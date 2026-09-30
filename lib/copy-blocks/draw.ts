/**
 * Code blocks and quotes redrawn as cards: a background of their own from
 * where the block starts to the message's right margin, and a `copy` label a
 * click hits. A code block's opening fence becomes a header with its
 * language, its closing fence a blank row of the card.
 */
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { bgSgr, mix, parseAnsiColor, type ColorMode, type Rgb } from "../band/color.ts";
import type { Block } from "./scan.ts";

export const LABEL = "copy";
export const DONE = "✓ copied";
/** The label's slot fits both words, so a click doesn't shift the header. */
const SLOT = Math.max(LABEL.length, DONE.length);
/**
 * A card this many rows tall gets a label at each end: scrolled part way, one
 * end is often out of view. Shorter cards fit on screen whole and keep one.
 */
export const BOTH_ENDS_ROWS = 10;
const RESET = "\x1b[0m";

export interface Paint {
	readonly codeBg: string;
	readonly quoteBg: string;
	label(text: string): string;
	done(text: string): string;
	lang(text: string): string;
}

/** The theme surface this reads; Pi's Theme satisfies it. */
export interface PaintTheme {
	getFgAnsi(key: string): string;
	getBgAnsi(key: string): string;
	getColorMode(): ColorMode;
	fg(key: string, text: string): string;
}

// How far each card leans from the theme's tool background toward its text color.
const CODE_TINT = 0.05;
const QUOTE_TINT = 0.08;

const paints = new WeakMap<object, Paint>();

export function paintFrom(theme: PaintTheme): Paint {
	const kept = paints.get(theme);
	if (kept) return kept;
	const read = (kind: "fg" | "bg", key: string): Rgb | undefined => {
		try { return parseAnsiColor(kind === "fg" ? theme.getFgAnsi(key) : theme.getBgAnsi(key)); } catch { return undefined; }
	};
	const safe = (key: string) => (text: string) => { try { return theme.fg(key, text); } catch { return text; } };
	let mode: ColorMode = "truecolor";
	try { mode = theme.getColorMode(); } catch { /* truecolor */ }
	const base = read("bg", "toolPendingBg") ?? read("bg", "userMessageBg");
	const tinted = (key: string, amount: number, fallback: string) => {
		const toward = read("fg", key) ?? read("fg", "accent");
		if (base && toward) return bgSgr(mix(base, toward, amount), mode);
		try { return theme.getBgAnsi(fallback); } catch { return ""; }
	};
	const paint: Paint = {
		codeBg: tinted("mdCodeBlock", CODE_TINT, "toolPendingBg"),
		quoteBg: tinted("mdQuote", QUOTE_TINT, "userMessageBg"),
		label: safe("muted"),
		done: safe("success"),
		lang: safe("dim"),
	};
	paints.set(theme, paint);
	return paint;
}

/** Text on a background that survives the resets inside it. */
export function onBg(text: string, bg: string): string {
	if (!bg) return text;
	return `${bg}${text.replace(/\x1b\[0?m/g, (reset) => reset + bg).replace(/\x1b\[49m/g, bg)}\x1b[49m`;
}

const padTo = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
const plainOf = (line: string) => stripTerminalSequences(line);

export interface Button {
	readonly row: number;
	readonly from: number;
	readonly to: number;
	readonly block: Block;
}

export interface DrawInput {
	readonly lines: readonly string[];
	readonly blocks: readonly Block[];
	readonly width: number;
	/** The message's left and right margin. */
	readonly pad: number;
	readonly paint: Paint;
	/** Whether a click can reach the labels; without one they are left out. */
	readonly labels: boolean;
	readonly langOf: (block: Block) => string;
	readonly copied?: Block;
}

const same = (a: Block | undefined, b: Block) => !!a && a.kind === b.kind && a.index === b.index;
const tall = (block: Block) => block.end - block.start + 1 >= BOTH_ENDS_ROWS;

/** Where a label goes: on a row of the block, or on a row added above or below it. */
type Place = "on" | "above" | "below";

/**
 * Which rows of a quote carry its label, and whether a row is added above or
 * below it for one. A short quote takes its first or last line with room,
 * else a row below; a tall one its first line with room in its top half,
 * else a row above, and its last line, else a row below.
 */
function quoteLabels(block: Block, fits: (row: number) => boolean): { rows: number[]; above: boolean; below: boolean } {
	const last = fits(block.end) ? block.end : undefined;
	if (!tall(block)) {
		const home = fits(block.start) ? block.start : last;
		return home === undefined ? { rows: [], above: false, below: true } : { rows: [home], above: false, below: false };
	}
	const half = block.start + Math.floor((block.end - block.start + 1) / 2);
	const top = Array.from({ length: half - block.start }, (_, offset) => block.start + offset).find(fits);
	return { rows: [...(top === undefined ? [] : [top]), ...(last === undefined ? [] : [last])], above: top === undefined, below: last === undefined };
}

/** The lines with every block drawn as a card, and where each label is. */
export function draw(input: DrawInput): { lines: string[]; buttons: Button[] } {
	const rows = [...input.lines];
	const above = new Map<number, string>();
	const below = new Map<number, string>();
	const placed: Array<{ row: number; place: Place; from: number; to: number; block: Block }> = [];
	const right = input.width - input.pad;
	const label = (block: Block) => padStartVisible(same(input.copied, block) ? input.paint.done(DONE) : input.paint.label(LABEL), SLOT);
	// Quotes first, so a code block inside one is drawn over it.
	for (const block of input.blocks.filter((each) => each.kind === "quote")) {
		const bg = input.paint.quoteBg;
		const first = plainOf(rows[block.start]!);
		const left = Math.max(0, first.indexOf("│"));
		const region = right - left;
		if (region < 2) continue;
		const fits = (row: number) => visibleWidth(plainOf(rows[row]!).trimEnd()) - left + 1 + SLOT + 1 <= region;
		const labelled = input.labels && region >= SLOT + 4 ? quoteLabels(block, fits) : { rows: [], above: false, below: false };
		for (let row = block.start; row <= block.end; row++) {
			const line = rows[row]!;
			const body = labelled.rows.includes(row)
				? padTo(sliceByColumn(line, left, region - SLOT - 1), region - SLOT - 1) + label(block) + " "
				: padTo(sliceByColumn(line, left, region), region);
			rows[row] = sliceByColumn(line, 0, left) + RESET + onBg(body, bg) + " ".repeat(input.pad);
		}
		for (const row of labelled.rows) placed.push({ row, place: "on", from: right - SLOT - 1, to: right, block });
		// A row of the quote's own: its bar, then the label.
		const labelRow = (row: number) => {
			const border = sliceByColumn(input.lines[row]!, left, 2);
			return sliceByColumn(rows[row]!, 0, left) + RESET + onBg(padTo(border, region - SLOT - 1) + RESET + label(block) + " ", bg) + " ".repeat(input.pad);
		};
		if (labelled.above) {
			above.set(block.start, labelRow(block.start));
			placed.push({ row: block.start, place: "above", from: right - SLOT - 1, to: right, block });
		}
		if (labelled.below) {
			below.set(block.end, labelRow(block.end));
			placed.push({ row: block.end, place: "below", from: right - SLOT - 1, to: right, block });
		}
	}
	for (const block of input.blocks.filter((each) => each.kind === "code")) {
		const bg = input.paint.codeBg;
		const left = plainOf(rows[block.start]!).indexOf("```");
		const region = right - left;
		if (left < 0 || region < 2) continue;
		const slot = input.labels && region >= SLOT + 4 ? SLOT + 1 : 0;
		for (let row = block.start; row <= block.end; row++) {
			const line = rows[row]!;
			let body: string;
			if (row === block.start) {
				const lang = input.langOf(block);
				const head = lang ? " " + input.paint.lang(sliceByColumn(lang, 0, Math.max(0, region - slot - 2))) : "";
				body = padTo(head, region - slot) + (slot ? label(block) + " " : "");
			} else if (row === block.end && block.closed) {
				body = slot && tall(block) ? " ".repeat(region - slot) + label(block) + " " : " ".repeat(region);
			} else {
				body = padTo(sliceByColumn(line, left, region), region);
			}
			rows[row] = sliceByColumn(line, 0, left) + RESET + onBg(body, bg) + " ".repeat(input.pad);
		}
		// The whole header is the button, so a click anywhere on it copies; a tall card's foot too.
		if (slot) placed.push({ row: block.start, place: "on", from: left, to: right, block });
		if (slot && block.closed && tall(block)) placed.push({ row: block.end, place: "on", from: left, to: right, block });
	}
	const lines: string[] = [];
	const at: number[] = [];
	rows.forEach((row, index) => {
		const before = above.get(index);
		if (before !== undefined) lines.push(before);
		at.push(lines.length);
		lines.push(row);
		const after = below.get(index);
		if (after !== undefined) lines.push(after);
	});
	const shift: Record<Place, number> = { above: -1, on: 0, below: 1 };
	const buttons = placed.map(({ row, place, from, to, block }) => ({ row: at[row]! + shift[place], from, to, block }));
	return { lines, buttons };
}

function padStartVisible(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}
