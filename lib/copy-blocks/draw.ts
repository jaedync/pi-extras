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

/** The lines with every block drawn as a card, and where each label is. */
export function draw(input: DrawInput): { lines: string[]; buttons: Button[] } {
	const rows = [...input.lines];
	const inserted = new Map<number, string>();
	const placed: Array<{ row: number; below: boolean; from: number; to: number; block: Block }> = [];
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
		const home = !input.labels || region < SLOT + 4 ? undefined : [block.start, block.end].find(fits);
		for (let row = block.start; row <= block.end; row++) {
			const line = rows[row]!;
			const body = row === home
				? padTo(sliceByColumn(line, left, region - SLOT - 1), region - SLOT - 1) + label(block) + " "
				: padTo(sliceByColumn(line, left, region), region);
			rows[row] = sliceByColumn(line, 0, left) + RESET + onBg(body, bg) + " ".repeat(input.pad);
		}
		if (home !== undefined) placed.push({ row: home, below: false, from: right - SLOT - 1, to: right, block });
		else if (input.labels && region >= SLOT + 4) {
			const line = rows[block.end]!;
			const border = sliceByColumn(input.lines[block.end]!, left, 2);
			inserted.set(block.end, sliceByColumn(line, 0, left) + RESET + onBg(padTo(border, region - SLOT - 1) + RESET + label(block) + " ", bg) + " ".repeat(input.pad));
			placed.push({ row: block.end, below: true, from: right - SLOT - 1, to: right, block });
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
				body = " ".repeat(region);
			} else {
				body = padTo(sliceByColumn(line, left, region), region);
			}
			rows[row] = sliceByColumn(line, 0, left) + RESET + onBg(body, bg) + " ".repeat(input.pad);
		}
		// The whole header is the button, so a click anywhere on it copies.
		if (slot) placed.push({ row: block.start, below: false, from: left, to: right, block });
	}
	const lines: string[] = [];
	const at: number[] = [];
	rows.forEach((row, index) => {
		at.push(lines.length);
		lines.push(row);
		const extra = inserted.get(index);
		if (extra !== undefined) lines.push(extra);
	});
	const buttons = placed.map(({ row, below, from, to, block }) => ({ row: at[row]! + (below ? 1 : 0), from, to, block }));
	return { lines, buttons };
}

function padStartVisible(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}
