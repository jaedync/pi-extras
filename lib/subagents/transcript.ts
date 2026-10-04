/**
 * What other agents, you and main told a child, as the inspector shows it:
 * the conversation main's transcript shows, not the envelopes its model reads
 * (format.ts). An arrow to it from you or main, or the ◆ of the agent that
 * wrote, in that agent's color, with the text set in under it. Pure, so it is
 * tested without a terminal.
 */
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { AVATAR, agentHue } from "../band/agent-look.ts";
import { FAILURE_GLYPH } from "../band/glyph.ts";
import type { Envelope } from "./format.ts";
import { MAIN, USER } from "./names.ts";
import { shortModel } from "./widget.ts";

export type Painter = (color: string, text: string) => string;

/** Who is in an agent's conversation: the agent the inspector shows, and the color each agent wears. */
export interface Voices {
	readonly self: string;
	hue(name: string): string;
}

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

// Control characters in what an agent wrote would move the cursor inside the overlay.
// Whole escape sequences first, so none leaves its tail behind.
const clean = (text: string): string => text.replace(/\r/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/**
 * One delivery from another agent, you or main: the header main's rows use
 * for it, cut to the width, and what it said set in under it.
 */
export function envelopeLines(envelope: Exclude<Envelope, { kind: "prompt" }>, width: number, paint: Painter, voices: Voices): string[] {
	const inner = Math.max(8, width);
	const color = envelope.kind === "report" && envelope.state === "failed" ? "error" : "customMessageText";
	const body = envelope.text ? wrapTextWithAnsi(clean(envelope.text), Math.max(4, inner - INDENT.length)).map((line) => INDENT + paint(color, line)) : [];
	return [truncateToWidth(header(envelope, voices, paint), inner, "…"), ...body];
}
