/**
 * A child's session as lines for the inspector: what it was told, what it
 * said, one line per tool call with the first lines of its result, and a
 * single dim line for thinking. Pure, so it is tested without a terminal.
 *
 * What it was told reads as the conversation main's transcript shows, not as
 * the envelopes its model reads (format.ts): an arrow to it from you or main,
 * or the ◆ of the agent that wrote, in that agent's color, with the text set
 * in under it.
 */
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { AVATAR, agentHue } from "../band/agent-look.ts";
import { FAILURE_GLYPH } from "../band/glyph.ts";
import { readEnvelopes, type Envelope } from "./format.ts";
import { MAIN, USER, moreLines } from "./names.ts";
import { shortModel } from "./widget.ts";

export type Painter = (color: string, text: string) => string;

/** Who is in an agent's conversation: the agent the inspector shows, and the color each agent wears. */
export interface Voices {
	readonly self: string;
	hue(name: string): string;
}

export const RESULT_PREVIEW_LINES = 3;
const INDENT = "  ";
/** Between a header's name, what happened and the facts, as on main's rows. */
const GAP = "  ";
const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`;

type Report = Extract<Envelope, { kind: "report" }>;
const REPORT_WORDS: Readonly<Record<Report["state"], { readonly text: string; readonly color: string }>> = {
	idle: { text: "reported", color: "muted" },
	failed: { text: `${FAILURE_GLYPH} failed`, color: "error" },
	stopped: { text: "stopped", color: "muted" },
	interrupted: { text: "interrupted", color: "muted" },
};

/** The line a delivery's text sits under, the same words main's rows use for it. */
function header(envelope: Exclude<Envelope, { kind: "prompt" }>, voices: Voices, paint: Painter): string {
	if (envelope.kind === "report") {
		const word = REPORT_WORDS[envelope.state];
		const took = envelope.took ? [paint("text", envelope.took)] : [];
		return [`${strong(paint(agentHue(envelope.model), `${AVATAR} ${envelope.from}`))}${paint(word.color, ` ${word.text}`)}`, ...took, paint("dim", shortModel(envelope.model))].join(GAP);
	}
	const asks = envelope.kind === "question";
	if (envelope.from === MAIN || envelope.from === USER) {
		const who = envelope.from === USER ? "you" : MAIN;
		// A question keeps its amber verb, as an agent's question to main does.
		const said = asks ? `${paint("dim", `${who} `)}${paint("warning", envelope.from === USER ? "asked" : "asks")}` : paint("dim", `${who} wrote`);
		return `${strong(paint(voices.hue(voices.self), `→ ${voices.self}`))}${GAP}${said}`;
	}
	return `${strong(paint(voices.hue(envelope.from), `${AVATAR} ${envelope.from}`))}${paint("dim", ` → ${voices.self}`)}${GAP}${paint(asks ? "warning" : "dim", asks ? "asks" : "note")}`;
}

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
	voices: Voices,
): string[] {
	const inner = Math.max(8, width);
	const wrap = (text: string, color: string, indent = ""): string[] =>
		wrapTextWithAnsi(clean(text), Math.max(4, inner - indent.length)).map((line) => indent + paint(color, line));
	const lines: string[] = [];
	for (const raw of messages) {
		const message = raw as Message;
		if (message.role === "user") {
			for (const envelope of readEnvelopes(textOf(message.content))) {
				if (envelope.kind === "prompt") { lines.push("", ...wrap(`▸ ${envelope.text}`, "accent")); continue; }
				const color = envelope.kind === "report" && envelope.state === "failed" ? "error" : "customMessageText";
				lines.push("", truncateToWidth(header(envelope, voices, paint), inner, "…"), ...(envelope.text ? wrap(envelope.text, color, INDENT) : []));
			}
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
