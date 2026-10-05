/**
 * A child's bash tool: Pi's own, with its commands confined to the child's
 * worktree (sandbox.ts) and a note on its result when that stopped a write.
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { deniedWriteNote, type Sandbox } from "./sandbox.ts";

export interface BashGuardOptions {
	sandbox?: Sandbox;
}

type Content = AgentToolResult<unknown>["content"];

const textOf = (content: Content): string => content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

/** `line` added to the result's last text, or as a new text part when there is none. */
export function withLine<T extends { content: Content }>(result: T, line: string): T {
	const last = result.content.at(-1);
	const content: Content = last?.type === "text"
		? [...result.content.slice(0, -1), { ...last, text: last.text ? `${last.text}\n${line}` : line }]
		: [...result.content, { type: "text", text: line }];
	return { ...result, content };
}

export function guardBash<T extends ToolDefinition<any, any, any>>(definition: T, options: BashGuardOptions): T {
	const { sandbox } = options;
	if (!sandbox) return definition;
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
			const note = result.isError ? deniedWriteNote(sandbox, textOf(result.content)) : undefined;
			return note ? withLine(result, note) : result;
		},
	};
}
