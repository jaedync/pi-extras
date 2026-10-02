/**
 * How a shell job looks wherever it shows: a band, like a call that runs in
 * place, because a job is one, only out of the way. Its title first, since
 * a name reads faster than a command line, then its command after a `$` and
 * where it is, set close together so they read as one phrase rather than as
 * two ends of the line. While it runs the band fills
 * with real progress when its command or output says how far along it is
 * (shell-jobs-progress.ts), and sweeps when nothing does. Output sits in a
 * gutter under it. Subagents have no band at all (agent-look.ts), so the two
 * never read alike.
 */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bandBackground, fallbackKey, paintLine, ROW_MARGIN, type BandPhase, type Motion, type Seg } from "./band.ts";
import { paletteFrom, type BandTheme } from "./palette.ts";

export const PROMPT = "$";
export const GUTTER = "│";
/** Output text starts after the margin and the gutter. */
export const GUTTER_INDENT = ROW_MARGIN + 2;
/** Between the title, the command and the status: near enough to read as one line, apart enough to tell apart. */
const GAP = "  ";
const FACT_SEP = " · ";
const TAIL_MARK = "  ▸ ";
/** The command is cut no shorter than this before the title gives way. */
const MIN_COMMAND = 16;
/** A command, title or output line cut shorter than these says too little to keep. */
const MIN_COMMAND_SHOWN = 4;
const MIN_TITLE = 6;
const MIN_TAIL = 10;
/** The output line keeps this much before the command is cut: enough to say what the job is doing. */
const TAIL_KEPT = 24;

/** `$ command`, the prompt bold in the tool color. */
export function promptSegs(command: string, color = "toolTitle"): Seg[] {
	return [{ text: `${PROMPT} `, color: "accent", bold: true }, { text: command, color }];
}

export interface JobBandSpec {
	readonly width: number;
	readonly phase: BandPhase;
	/** One glyph in the margin: the job's spinner, or a bullet in the color it ended in. */
	readonly margin: Seg;
	readonly command: string;
	readonly commandColor?: string;
	readonly title: string | null;
	/** Where the job is or how it ended; never cut. */
	readonly status: readonly Seg[];
	/** Facts after the status, time left first: all but the first give way before the title, the first after it. */
	readonly facts?: readonly string[];
	/** The latest output line: past TAIL_KEPT it is cut first, then it outlasts the end of the command. */
	readonly tail?: string;
	readonly clockMs: number;
	readonly motion?: Motion;
}

const widthOf = (segs: readonly Seg[]) => segs.reduce((sum, seg) => sum + visibleWidth(seg.text), 0);
/** Cut to a width with an ellipsis, as plain text: segments carry their own colors. */
const cut = (text: string, width: number) => stripTerminalSequences(truncateToWidth(text, width, "…"));

/** How wide each part may be at this width, giving way in order of how little it is worth. */
function budget(spec: JobBandSpec, room: number) {
	const facts = spec.facts ?? [];
	const factsWidth = (count: number) => facts.slice(0, count).reduce((sum, fact) => sum + FACT_SEP.length + visibleWidth(fact), 0);
	const status = widthOf(spec.status);
	const parts = { command: visibleWidth(spec.command), title: spec.title ? visibleWidth(spec.title) : 0, facts: facts.length, tail: spec.tail ? visibleWidth(spec.tail) : 0 };
	const prompt = () => (parts.command > 0 ? PROMPT.length + 1 : 0);
	const gaps = () => Math.max(0, [parts.command, parts.title, status].filter((part) => part > 0).length - 1) * GAP.length;
	const over = () => prompt() + parts.command + parts.title + status + gaps() + factsWidth(parts.facts) + (parts.tail ? TAIL_MARK.length + parts.tail : 0) - room;
	// What a running job is doing now outweighs the end of a command its title already names.
	if (over() > 0 && parts.tail) parts.tail = Math.max(Math.min(parts.tail, TAIL_KEPT), parts.tail - over());
	if (over() > 0 && parts.command) parts.command = Math.max(Math.min(parts.command, MIN_COMMAND), parts.command - over());
	if (over() > 0 && parts.tail) parts.tail = parts.tail - over() >= MIN_TAIL ? parts.tail - over() : 0;
	// The first fact is the time left; the rest (size, speed) matter less than the job's name.
	while (over() > 0 && parts.facts > 1) parts.facts--;
	if (over() > 0 && parts.title) parts.title = parts.title - over() >= MIN_TITLE ? parts.title - over() : 0;
	while (over() > 0 && parts.facts > 0) parts.facts--;
	// Narrower still, a command too short to say anything goes, and the status is all the line says.
	if (over() > 0 && parts.command) parts.command = parts.command - over() >= MIN_COMMAND_SHOWN ? parts.command - over() : 0;
	return parts;
}

/** A job as one band line; the status always shows whole, the rest is cut to fit. */
export function jobBand(theme: BandTheme, spec: JobBandSpec): string {
	const palette = paletteFrom(theme);
	const room = Math.max(1, spec.width - ROW_MARGIN - 1);
	const fit = budget(spec, room);
	const groups: Seg[][] = [];
	if (spec.title && fit.title > 0) groups.push([{ text: cut(spec.title, fit.title), color: "text", bold: true }]);
	if (fit.command > 0) groups.push(promptSegs(cut(spec.command, fit.command), spec.commandColor));
	if (spec.status.length > 0) groups.push([...spec.status]);
	const facts = (spec.facts ?? []).slice(0, fit.facts).flatMap((fact): Seg[] => [{ text: FACT_SEP, color: "dim" }, { text: fact, color: "muted" }]);
	const tail: Seg[] = spec.tail && fit.tail > 0 ? [{ text: `${TAIL_MARK}${cut(spec.tail, fit.tail)}`, color: "dim" }] : [];
	const body = groups.flatMap((group, index) => (index === 0 ? group : [{ text: GAP, color: "dim" }, ...group]));
	const margin: Seg = { ...spec.margin, text: spec.margin.text.padEnd(ROW_MARGIN) };
	const bgAt = palette ? bandBackground(palette, spec.phase, spec.width, spec.clockMs, spec.motion ?? "full") : undefined;
	return paintLine(theme, palette, { width: spec.width, left: [margin, ...body, ...facts, ...tail], indent: 0, ...(bgAt ? { bgAt } : {}), fallbackBg: fallbackKey(spec.phase) });
}

const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
/**
 * What is left of a color or erase sequence after its ESC was stripped
 * upstream (job completions carry text sanitized for the model): `[32m`,
 * `[0;1m`, `[2K`. Only those finals, so ordinary brackets survive.
 */
const ORPHANED_SEQUENCE = /\[[0-9;?]*[mKJ]/g;
/** Output as it reads on a terminal: colors and controls gone, one line. */
export const cleanOutput = (line: string): string => stripTerminalSequences(line).replace(CONTROLS, "").replace(ORPHANED_SEQUENCE, "").replace(/\s+$/, "");

/**
 * Output as a terminal leaves it: each line shows what its last carriage
 * return wrote, so a meter redrawn in place (curl, wget) is its final state,
 * not every update run together.
 */
export function overwritten(text: string): string {
	return text.split("\n").map((line) => line.split("\r").filter((part) => part.length > 0).at(-1) ?? "").join("\n");
}

/** The last line with words in some output, as a terminal would show it. */
export function lastLine(text: string): string | undefined {
	const lines = overwritten(text).split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const shown = cleanOutput(lines[i]!).trim();
		if (shown.length > 0) return shown;
	}
	return undefined;
}

function paint(theme: BandTheme, key: string, text: string): string {
	try { return theme.fg(key, text); } catch { return text; }
}

/** Output lines in the gutter under a band, each cut to the width. */
export function gutterLines(theme: BandTheme, lines: readonly string[], width: number, color = "toolOutput"): string[] {
	const room = Math.max(1, width - GUTTER_INDENT);
	// Below the gutter's own width the whole line is cut, so it never runs past the terminal.
	return lines.map((line) => truncateToWidth(`${" ".repeat(ROW_MARGIN)}${paint(theme, "border", GUTTER)} ${paint(theme, color, truncateToWidth(cleanOutput(line), room, "…"))}`, Math.max(1, width), "…"));
}
