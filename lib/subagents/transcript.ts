/**
 * A child's session as lines for the inspector: what it was told, what it
 * said, one line per tool call with the first lines of its result, and a
 * single dim line for thinking. Pure, so it is tested without a terminal.
 */
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { moreLines } from "./names.ts";

export type Painter = (color: string, text: string) => string;

export const RESULT_PREVIEW_LINES = 3;
const INDENT = "  ";

interface Block { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }
interface Message { role?: string; content?: unknown; isError?: boolean; toolName?: string }

const blocksOf = (content: unknown): Block[] =>
	typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as Block[] : [];

const textOf = (content: unknown): string =>
	blocksOf(content).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();

// Control characters from tool output would move the cursor inside the overlay.
// Whole escape sequences first, so none leaves its tail behind.
const clean = (text: string): string => text.replace(/\r/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

export function transcriptLines(
	messages: readonly unknown[],
	width: number,
	paint: Painter,
	describe: (tool: string, args: unknown) => string,
): string[] {
	const inner = Math.max(8, width);
	const wrap = (text: string, color: string, indent = ""): string[] =>
		wrapTextWithAnsi(clean(text), Math.max(4, inner - indent.length)).map((line) => indent + paint(color, line));
	const lines: string[] = [];
	for (const raw of messages) {
		const message = raw as Message;
		if (message.role === "user") {
			const text = textOf(message.content);
			if (!text) continue;
			lines.push("", ...wrap(`▸ ${text}`, "accent"));
		} else if (message.role === "assistant") {
			for (const block of blocksOf(message.content)) {
				if (block.type === "thinking" && block.thinking?.trim()) {
					const first = block.thinking.trim().split("\n")[0]!;
					lines.push(paint("dim", `${INDENT}thinking: ${first.length > inner - 14 ? `${first.slice(0, inner - 15)}…` : first}`));
				} else if (block.type === "text" && block.text?.trim()) {
					lines.push("", ...wrap(block.text.trim(), "text"));
				} else if (block.type === "toolCall") {
					lines.push(...wrap(`⚙ ${describe(block.name ?? "tool", block.arguments)}`, "toolTitle", INDENT));
				}
			}
		} else if (message.role === "toolResult") {
			const text = textOf(message.content);
			const all = text ? clean(text).split("\n") : [];
			const shown = all.slice(0, RESULT_PREVIEW_LINES);
			const color = message.isError ? "error" : "dim";
			for (const line of shown) lines.push(...wrap(line, color, `${INDENT}  `).slice(0, 1));
			if (all.length > shown.length) lines.push(paint("dim", `${INDENT}  … ${moreLines(all.length - shown.length)}`));
		}
	}
	while (lines[0] === "") lines.shift();
	return lines;
}
