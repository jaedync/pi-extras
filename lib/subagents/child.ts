/**
 * Makes child sessions in this Pi process with the SDK. A child gets the
 * parent's tools minus the ones that make no sense below it (mesh, goals,
 * desktop control, background jobs), tool-owning extensions, Cache Compaction
 * and a quota guard. Status bars, voice and other UI extensions stay out.
 */
import type { AgentSession, InlineExtension, ModelRuntime, SettingsManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBlockingPeer } from "../band/glyph.ts";
import { operationalError } from "../operational-log.ts";
import { CHILD_GUARD_NAME, CHILD_GUARD_PATH, createChildRateLimitGuard } from "../rate-limit-recovery/child.ts";
import { callPhrase } from "../tool-phrase.ts";
import { guardBash } from "./bash-guard.ts";
import { confine, sandboxFor } from "./sandbox.ts";
import type { ToolActivity } from "./tool-activity.ts";
import { WAITING_FOR_MODEL, type AgentRecord, type AgentWork, type ChildHandle, type ChildHooks, type Launcher, type Usage } from "./types.ts";
import { editTarget, outsideWorktree, sourcePlace, workspaceError } from "./worktree.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

/** Never given to a child, whatever the parent has. */
export const CHILD_TOOL_EXCLUDE: readonly string[] = [
	"subagent", "message", "stop_subagent", "subagents_enable", "bg_wait", "subagent_supervisor",
	"agent_send", "agent_request", "list_peers",
	"get_goal", "create_goal", "propose_goal_draft", "complete_goal", "update_goal_progress",
	"shell_job_start", "shell_job", "computer_use", "windows_use", "usage", "codemode", "tool_search",
];
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write"]);
/** The calls the edit guard checks; `bash` can change files too, but its targets can't be read from its input (bash-guard.ts checks after it). */
const EDIT_TOOLS = new Set(["edit", "write"]);
const EDIT_GUARD_NAME = "subagent-edit-guard";
const EDIT_GUARD_PATH = `<inline:${EDIT_GUARD_NAME}>`;
const READ_TOOLS = ["read", "grep", "find", "ls"];
const SHUTDOWN_TIMEOUT_MS = 2_000;
export const CHILD_CACHE_COMPACTION_PATH = fileURLToPath(new URL("../../extensions/cache-compaction.ts", import.meta.url));

/**
 * The extension files that own a child's tools, each once. Built-in, SDK and
 * inline owners have no file to load; a child gets those some other way or not at all.
 */
export function childExtensionPaths(all: readonly { name: string; sourceInfo?: { path?: string } }[], toolNames: readonly string[]): string[] {
	const wanted = new Set(toolNames);
	const paths = all.filter((tool) => wanted.has(tool.name)).map((tool) => tool.sourceInfo?.path ?? "")
		.filter((path) => path !== "" && !path.startsWith("builtin:") && !path.startsWith("<"));
	return [...new Set(paths)];
}

/** The tool names a child gets, before its own `message` (and maybe `subagent`). */
export function childToolNames(parentActive: readonly string[], readOnly: boolean, extraExclude: readonly string[] = []): string[] {
	const exclude = new Set([...CHILD_TOOL_EXCLUDE, ...extraExclude]);
	const kept = parentActive.filter((name) => !exclude.has(name) && !(readOnly && WRITE_TOOLS.has(name)));
	const withRead = readOnly ? [...READ_TOOLS, ...kept] : kept;
	return [...new Set(withRead)];
}

const oneLine = (text: unknown, max: number): string => {
	const line = String(text ?? "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const shortPath = (path: unknown): string => {
	const text = String(path ?? "");
	const parts = text.split("/").filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : text;
};

/** A few words for the widget: what a tool call is doing. */
export function describeTool(name: string, args: unknown): string {
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	switch (name) {
		case "bash": return `bash ${oneLine(input.command, 48)}`;
		case "read": case "edit": case "write": case "ls": return `${name} ${shortPath(input.path)}`;
		case "grep": case "find": return `${name} ${oneLine(input.pattern, 40)}`;
		case "web_search": return `search ${oneLine(input.query, 44)}`;
		case "fetch_content": {
			const url = typeof input.url === "string" ? input.url : Array.isArray(input.urls) ? String(input.urls[0] ?? "") : "";
			try { return `fetch ${new URL(url).host}`; } catch { return "fetch"; }
		}
		case "message": return `message ${oneLine(input.to, 24)}`;
		case "subagent": return `subagent ${oneLine(input.name ?? input.task, 32)}`;
		default: return name;
	}
}

interface AssistantLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

export function addUsage(total: Usage, usage: AssistantLike["usage"]): Usage {
	if (!usage) return total;
	return {
		input: total.input + (usage.input ?? 0),
		output: total.output + (usage.output ?? 0),
		cacheRead: total.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: total.cacheWrite + (usage.cacheWrite ?? 0),
		cost: total.cost + (usage.cost?.total ?? 0),
	};
}

/**
 * Whether a child may load the project settings and resources of `dir`, a
 * directory a spawn named, decided as Pi decides at a start with no one to
 * ask: nothing there needs trust, or you trusted it, or defaultProjectTrust
 * is "always". A Pi without these checks trusts nothing there.
 */
export function projectTrusted(sdk: Sdk, agentDir: string, dir: string, fallback: string): boolean {
	if (typeof sdk.hasTrustRequiringProjectResources !== "function" || typeof sdk.ProjectTrustStore !== "function") return false;
	try {
		if (!sdk.hasTrustRequiringProjectResources(dir)) return true;
		return new sdk.ProjectTrustStore(agentDir).get(dir) ?? fallback === "always";
	} catch {
		// A trust file that can't be read trusts nothing, as no answer would.
		return false;
	}
}

export interface LauncherDeps {
	sdk: Sdk;
	agentDir: string;
	cwd: string;
	/** Where child sessions are written; null keeps them in memory. */
	sessionDir: string | null;
	modelRuntime(): Promise<ModelRuntime>;
	modelAllowed?(model: string): boolean;
	/** Tool names and custom tools for this child. */
	toolsFor(record: AgentRecord): { tools: string[]; customTools: ToolDefinition[]; extensionPaths?: readonly string[] };
	instructions(record: AgentRecord): string;
	onExtensionError?(error: unknown): void;
	/** Before each `edit` or `write` call of the resolved `target`: takes its workspace's lock, or says why the child can't edit now. */
	claimEdit?(name: string, target?: string): string | undefined;
	/** Problems the user should see, such as a sandbox tool that does not work here. */
	warn?(message: string): void;
	/** Every agent's running edit and bash calls; with `bashChanged`, a child's bash call that changes files takes the lock. */
	activity?: ToolActivity;
	/** Whether the child may edit in the work tree `root` now without taking its lock. */
	mayEdit?(name: string, root: string): boolean;
	/** After a bash call changed files in the work tree `root`: takes its lock, or returns a note for the call's result. */
	bashChanged?(name: string, paths: readonly string[], root: string): string | undefined;
}

/**
 * Pi's bash tool with the shell settings of the child's directory (main's,
 * unless a spawn named one), replacing whichever bash the child would get. A spawn hook confines a worktree child's commands, so
 * its transcript keeps the command it wrote.
 */
function childBash(sdk: Sdk, cwd: string, settings: SettingsManager, record: AgentRecord, deps: LauncherDeps): ToolDefinition {
	const warn = (message: string) => deps.warn?.(message);
	const sandbox = record.worktree
		? sandboxFor(record.worktree.path, (why) => warn(`subagents: bash in worktrees runs without a sandbox, so it can write into your checkout. ${why}`))
		: undefined;
	const { activity, bashChanged } = deps;
	const changes = activity && bashChanged ? {
		cwd, agent: record.name, activity, warn,
		mayEdit: (root: string) => deps.mayEdit?.(record.name, root) ?? false,
		changed: (paths: readonly string[], root: string) => bashChanged(record.name, paths, root),
	} : undefined;
	const shellPath = settings.getShellPath();
	const definition = sdk.createBashToolDefinition(cwd, {
		commandPrefix: settings.getShellCommandPrefix(),
		...(shellPath ? { shellPath } : {}),
		...(sandbox ? { spawnHook: confine(sandbox.prefix) } : {}),
	});
	return guardBash(definition, { ...(sandbox ? { sandbox } : {}), ...(changes ? { changes } : {}) }) as ToolDefinition;
}

/** The child's edit calls that run, by call id, so its own and other agents' bash calls don't count their changes. */
export interface EditTracker {
	start(id: string, path: unknown): void;
	end(id: string): void;
}

/** Blocks, before it runs, an edit the child may not make; the reason is the call's result. */
export function editGuard(check: (path: unknown) => string | undefined, track?: EditTracker): InlineExtension {
	return {
		name: EDIT_GUARD_NAME,
		factory(pi) {
			pi.on("tool_call", (event) => {
				if (!EDIT_TOOLS.has(event.toolName)) return undefined;
				const path = (event.input as { path?: unknown }).path;
				const reason = check(path);
				if (reason) return { block: true, reason };
				track?.start(event.toolCallId, path);
				return undefined;
			});
			// Also sent for a call another handler blocked, unlike tool_result.
			pi.on("tool_execution_end", (event) => track?.end(event.toolCallId));
		},
	};
}

function editTracker(activity: ToolActivity | undefined, agent: string, cwd: string): EditTracker | undefined {
	if (!activity) return undefined;
	return {
		start(id, path) {
			const target = editTarget(cwd, path);
			if (target !== undefined) activity.editStart(`${agent}:${id}`, target);
		},
		end: (id) => activity.end(`${agent}:${id}`),
	};
}

export function createLauncher(deps: LauncherDeps): Launcher {
	return {
		async launch(record: AgentRecord, hooks: ChildHooks): Promise<ChildHandle> {
			const { sdk, agentDir } = deps;
			const cwd = record.cwd ?? record.worktree?.path ?? deps.cwd;
			const missing = workspaceError(cwd);
			if (missing) throw new Error(missing);
			if (record.restored && record.runs > 0 && record.sessionFile && !existsSync(record.sessionFile)) throw new Error(`The saved child session is missing: ${record.sessionFile}. Locate its transcript before resuming.`);
			if (deps.modelAllowed && !deps.modelAllowed(record.model)) throw new Error(`The child's model ${record.model} is out of scope. Resume explicitly on the current default model.`);
			const modelRuntime = await deps.modelRuntime();
			const resolved = sdk.resolveCliModel({ cliModel: record.model, modelRuntime });
			if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `Unknown model ${record.model}.`);
			const { tools, customTools: listed, extensionPaths = [] } = deps.toolsFor(record);
			const wanted = new Set(tools);
			const guard = createChildRateLimitGuard({ configFile: join(agentDir, "pi-extras.json"), onWarning: (code) => operationalError(join(agentDir, "rate-limit-recovery.log"), CHILD_GUARD_NAME, `transport protection: ${code}`) });
			// A directory a spawn named is used as Pi would use it with no one to ask; main's own keeps today's settings.
			const settingsManager = record.cwd ? sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false }) : sdk.SettingsManager.create(cwd, agentDir);
			if (record.cwd) {
				const place = record.worktree ? sourcePlace(record.worktree, record.cwd) : record.cwd;
				settingsManager.setProjectTrusted(projectTrusted(sdk, agentDir, place, settingsManager.getDefaultProjectTrust()));
			}
			// An SDK tool wins over a built-in or extension tool of the same name.
			const customTools = wanted.has("bash") ? [...listed, childBash(sdk, cwd, settingsManager, record, deps)] : listed;
			const loader = new sdk.DefaultResourceLoader({
				cwd, agentDir, settingsManager, noPromptTemplates: true, noThemes: true,
				// Besides Cache Compaction, load only files that own the child's tools. Every factory is handed the
				// child's API, and one that keeps it in module state (remote-pi does) then delivers the
				// parent's messages to the child, even if the extension is filtered out afterwards.
				noExtensions: true, additionalExtensionPaths: [...new Set([...extensionPaths, CHILD_CACHE_COMPACTION_PATH])],
				appendSystemPrompt: [deps.instructions(record)],
				// Outside its worktree is refused before the lock is taken, so a refused edit holds nothing.
				extensionFactories: [guard.extension, editGuard((path) => (record.worktree ? outsideWorktree(record.worktree, cwd, path) : undefined) ?? deps.claimEdit?.(record.name, editTarget(cwd, path)),
					editTracker(deps.activity, record.name, cwd))],
				extensionsOverride: (base) => ({
					...base,
					extensions: base.extensions.filter((extension) => [CHILD_GUARD_PATH, EDIT_GUARD_PATH, CHILD_CACHE_COMPACTION_PATH].includes(extension.path)
						|| [...extension.tools.keys()].some((name) => wanted.has(name))),
				}),
			});
			await loader.reload();
			// A path fixed at spawn opens as a new session written there.
			const sessionManager = record.sessionFile ? sdk.SessionManager.open(record.sessionFile, dirname(record.sessionFile), cwd)
				: deps.sessionDir ? sdk.SessionManager.create(cwd, deps.sessionDir) : sdk.SessionManager.inMemory(cwd);
			const { session } = await sdk.createAgentSession({
				cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager,
				model: resolved.model,
				...(record.thinking ? { thinkingLevel: record.thinking } : {}),
				tools: [...wanted, ...customTools.map((tool) => tool.name)],
				customTools,
			}).catch((error) => { guard.dispose(); throw error; });
			await bindChild(session, guard, deps.onExtensionError);
			return handleFor(session, hooks, resolved.model.contextWindow, guard, record);
		},
	};
}

async function bindChild(session: AgentSession, guard: ReturnType<typeof createChildRateLimitGuard>, onError: LauncherDeps["onExtensionError"]): Promise<void> {
	try { await session.bindExtensions({ mode: "print", onError: (error: unknown) => onError?.(error) } as never); }
	catch (error) { guard.dispose(); session.dispose(); throw error; }
}

/**
 * What a streaming reply says an agent is doing: thinking, writing, or the
 * call it is writing, in the words main's phase line uses (tool-phrase.ts).
 */
export function streamingActivity(update: { type?: string; contentIndex?: number }, message: { content?: unknown } | undefined): Activity | undefined {
	const kind = update.type ?? "";
	// A block that has opened but sent no text yet is still the wait for the model.
	if (kind === "thinking_delta") return { activity: "thinking", work: "thinking" };
	if (kind === "text_delta") return { activity: "writing", work: "writing" };
	if (!kind.startsWith("toolcall")) return undefined;
	const blocks = Array.isArray(message?.content) ? message.content as Array<{ type?: string; name?: unknown; arguments?: unknown }> : [];
	const block = update.contentIndex === undefined ? undefined : blocks[update.contentIndex];
	const activity = block?.type === "toolCall" && typeof block.name === "string" ? callPhrase(block.name, block.arguments) : callPhrase(undefined);
	return { activity, work: "call" };
}

/** What an agent does now, in words and as its spinner's state. */
export interface Activity {
	readonly activity: string;
	readonly work: AgentWork;
}

/** The parts of a child session's events that say what it does. */
export interface ChildEvent {
	readonly type: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
	readonly attempt?: number;
	readonly maxAttempts?: number;
	readonly message?: { content?: unknown };
	readonly assistantMessageEvent?: { type?: string; contentIndex?: number };
}

/**
 * Follows a child session's events to what it does now, with the states main's
 * phase spinner has: a tool runs, or only waits on other agents; its model is
 * asked once every tool is done; a compaction; a retry. Undefined: unchanged.
 */
export function activityWatch(): (event: ChildEvent) => Activity | undefined {
	const running = new Map<string, { readonly words: string; readonly peer: boolean }>();
	const runningNow = (): Activity | undefined => {
		const calls = [...running.values()];
		const last = calls.at(-1);
		return last ? { activity: last.words, work: calls.every((call) => call.peer) ? "peer" : "tool" } : undefined;
	};
	return (event) => {
		switch (event.type) {
			case "tool_execution_start":
				running.set(event.toolCallId ?? `call ${running.size}`, { words: describeTool(event.toolName ?? "", event.args), peer: isBlockingPeer(event.toolName ?? "", event.args) });
				return runningNow();
			case "tool_execution_end":
				running.delete(event.toolCallId ?? "");
				return runningNow() ?? WAITING_FOR_MODEL;
			case "compaction_start": return { activity: "compacting context", work: "compacting" };
			case "auto_retry_start": {
				const { attempt, maxAttempts } = event;
				const counted = Number.isInteger(attempt) && Number.isInteger(maxAttempts) ? `, attempt ${attempt} of ${maxAttempts}` : "";
				return { activity: `retrying${counted}`, work: "retrying" };
			}
			case "compaction_end": case "auto_retry_end": return WAITING_FOR_MODEL;
			case "message_update": return streamingActivity(event.assistantMessageEvent ?? {}, event.message);
			default: return undefined;
		}
	};
}

function watchChild(session: AgentSession, hooks: ChildHooks, contextWindow: number | undefined, record: AgentRecord): () => void {
	let usage: Usage = { ...record.usage };
	let toolCalls = record.toolCalls;
	const watch = activityWatch();
	let shown: Activity | undefined;
	return session.subscribe((event) => {
		const e = event as ChildEvent & { message?: AssistantLike };
		const next = watch(e);
		if (next && (next.activity !== shown?.activity || next.work !== shown?.work)) {
			shown = next;
			hooks.update({ activity: next.activity, work: next.work });
		}
		// Pi's own rule: the size is unknown until a reply after the compaction.
		if (e.type === "compaction_end") hooks.update({ contextTokens: undefined });
		else if (e.type === "tool_execution_end") hooks.update({ toolCalls: ++toolCalls });
		else if (e.type === "message_end" && e.message?.role === "assistant") {
			usage = addUsage(usage, e.message.usage);
			const u = e.message.usage;
			const contextTokens = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0) : undefined;
			hooks.update({ usage, ...(contextTokens ? { contextTokens } : {}), ...(contextWindow ? { contextWindow } : {}) });
		}
	});
}

function childDisposer(session: AgentSession, unsubscribe: () => void, guard: ReturnType<typeof createChildRateLimitGuard>): () => Promise<void> {
	let disposed: Promise<void> | null = null;
	return () => disposed ??= (async () => {
		// SDK disposal can skip or time out extension shutdown handlers.
		guard.dispose();
		unsubscribe();
		// Pi's own hosts let extensions release watchers and timers before disposing.
		const runner = session.extensionRunner as { hasHandlers?(name: string): boolean; emit?(event: unknown): Promise<unknown> } | undefined;
		if (runner?.hasHandlers?.("session_shutdown")) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					runner.emit!({ type: "session_shutdown", reason: "quit" }).catch(() => undefined),
					new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); timer.unref?.(); }),
				]);
			} finally { if (timer) clearTimeout(timer); }
		}
		session.dispose();
	})();
}

/** The assistant message being streamed, until it ends and joins the session's messages. */
function watchStreaming(session: AgentSession): { current: () => unknown; stop: () => void } {
	let current: unknown;
	const stop = session.subscribe((event) => {
		const e = event as { type: string; message?: { role?: string } };
		if ((e.type === "message_start" || e.type === "message_update") && e.message?.role === "assistant") current = e.message;
		else if (e.type === "message_end" || e.type === "agent_end") current = undefined;
	});
	return { current: () => current, stop };
}

function handleFor(session: AgentSession, hooks: ChildHooks, contextWindow: number | undefined, guard: ReturnType<typeof createChildRateLimitGuard>, record: AgentRecord): ChildHandle {
	const streaming = watchStreaming(session);
	const unwatch = watchChild(session, hooks, contextWindow, record);
	const dispose = childDisposer(session, () => { streaming.stop(); unwatch(); }, guard);
	return {
		sessionFile: session.sessionFile,
		async prompt(text) {
			await session.prompt(text);
			const failure = guard.failure();
			if (failure) throw new Error(failure);
			const last = [...session.messages].reverse().find((message) => (message as AssistantLike).role === "assistant") as AssistantLike | undefined;
			if (last?.stopReason === "error") throw new Error(last.errorMessage || "The model returned an error.");
		},
		steer(text) {
			void session.steer(text).catch(() => undefined);
		},
		abort: () => session.abort(),
		lastText: () => session.getLastAssistantText(),
		messages: () => session.messages,
		streaming: streaming.current,
		tool: (name) => session.getToolDefinition(name),
		takeQueued() {
			const agent = session.agent as { hasQueuedMessages?: () => boolean };
			if (agent.hasQueuedMessages?.() !== true) return [];
			const { steering, followUp } = session.clearQueue();
			return [...steering, ...followUp];
		},
		dispose,
	};
}
