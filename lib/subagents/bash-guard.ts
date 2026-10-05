/**
 * A child's bash tool: Pi's own, with its commands confined to the child's
 * worktree (sandbox.ts) and a note on its result when that stopped a write.
 * Around each call it also compares the workspace's changed files, so a
 * command that changes files takes the edit lock as an `edit` would. That is
 * detection after the fact, not prevention.
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { changedPaths, fingerprint, gitRoot, type Fingerprint } from "./fingerprint.ts";
import { deniedWriteNote, type Sandbox } from "./sandbox.ts";
import type { ToolActivity, Watched } from "./tool-activity.ts";

/** How a child's bash call reports the files it changed. */
export interface ChangeWatch {
	/** The child's workspace; changes are looked for in its git work tree. */
	cwd: string;
	/** The child's name, which keeps its call ids apart from other agents' in `activity`. */
	agent: string;
	activity: ToolActivity;
	/** True while the child may edit anyway: it or an agent it works for holds the lock. */
	mayEdit(): boolean;
	/** Paths relative to the work tree; takes the lock, or returns a note for the call's result. */
	changed(paths: readonly string[]): string | undefined;
	warn(message: string): void;
}

export interface BashGuardOptions {
	sandbox?: Sandbox;
	changes?: ChangeWatch;
}

type Content = AgentToolResult<unknown>["content"];

const textOf = (content: Content): string => content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

/** `line` added to the result's last text, or as a new text part when there is none. */
export function withLine<T extends { content: Content }>(result: T, line: string): T {
	const last = result.content.at(-1);
	const content: Content = last?.type === "text"
		? [...result.content.slice(0, -1), { ...last, text: last.text ? `${last.text.replace(/\n?$/, "\n")}${line}` : line }]
		: [...result.content, { type: "text", text: line }];
	return { ...result, content };
}

/** Workspaces whose detection failed once; a non-git workspace would otherwise warn on every call. */
const warned = new Set<string>();

function skip(watch: ChangeWatch, error: unknown): undefined {
	if (warned.has(watch.cwd)) return undefined;
	warned.add(watch.cwd);
	watch.warn(`subagents: can't tell which files bash commands change in ${watch.cwd}, so they don't take the edit lock there. ${(error as Error).message}`);
	return undefined;
}

interface Before { root: string; print: Fingerprint; stop(): Watched }

async function before(watch: ChangeWatch, id: string): Promise<Before | undefined> {
	if (watch.mayEdit()) return undefined;
	// Watch first: an edit that lands while the fingerprint is taken must not count either.
	const stop = watch.activity.watch(`${watch.agent}:${id}`, watch.cwd);
	try {
		const root = await gitRoot(watch.cwd);
		return { root, print: await fingerprint(root), stop };
	} catch (error) {
		stop();
		return skip(watch, error);
	}
}

async function after(watch: ChangeWatch, start: Before): Promise<string | undefined> {
	let print: Fingerprint;
	try { print = await fingerprint(start.root); }
	catch (error) { start.stop(); return skip(watch, error); }
	const { edited, shared } = start.stop();
	// Another agent's command ran here meanwhile, so these changes may be its.
	if (shared) return undefined;
	const paths = changedPaths(start.print, print).filter((path) => !edited.has(path));
	return paths.length > 0 ? watch.changed(paths.map((path) => relative(start.root, path))) : undefined;
}

export function guardBash<T extends ToolDefinition<any, any, any>>(definition: T, options: BashGuardOptions): T {
	const { sandbox, changes } = options;
	if (!sandbox && !changes) return definition;
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const start = changes ? await before(changes, toolCallId) : undefined;
			let result: AgentToolResult<unknown>;
			try { result = await definition.execute(toolCallId, params, signal, onUpdate, ctx); }
			catch (error) {
				// A command that timed out or was aborted may have changed files before it stopped.
				const note = start ? await after(changes!, start) : undefined;
				throw note ? new Error(`${(error as Error).message}\n${note}`) : error;
			}
			const denied = sandbox && result.isError ? deniedWriteNote(sandbox, textOf(result.content)) : undefined;
			const changed = start ? await after(changes!, start) : undefined;
			return [denied, changed].reduce((current, note) => (note ? withLine(current, note) : current), result);
		},
	};
}
