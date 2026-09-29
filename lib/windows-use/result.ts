/** MCP tool results in the shape the shared script executor consumes. */
import type { ContentBlock, ToolResult } from "../computer-use/session.ts";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

export function toResult(raw: unknown): ToolResult {
	const result = record(raw);
	const blocks = Array.isArray(result.content) ? result.content.map(record) : [];
	const content = blocks.flatMap((block): ContentBlock[] => {
		if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
		if (block.type === "image" && typeof block.data === "string") return [{ type: "image", data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" }];
		return [];
	});
	return { content, isError: result.isError === true };
}

export const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: false });

/** A result's text blocks, joined. */
export const textOf = (result: ToolResult): string => result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
