/**
 * Width-aware string helpers that see through escape sequences. Widths are
 * pi-tui's terminal cells: Pi refuses a rendered line wider than the
 * terminal, so the footer must measure wide characters (CJK, emoji) the way
 * pi-tui does, not one per code point.
 */
import { stripTerminalSequences, visibleWidth as cellWidth } from "@earendil-works/pi-tui";

/**
 * The escape sequences pi-tui skips when it measures: CSI ending in one of
 * m/G/K/H/J, and OSC (hyperlinks) or APC ending in BEL or ST.
 */
const ESCAPE = /(\x1b\[[^mGKHJ]*[mGKHJ]|\x1b[\]_](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\))/;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Most footer text: one cell per character, so no segmenter is needed. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

interface Piece {
	readonly text: string;
	/** Terminal cells; 0 for an escape sequence. */
	readonly width: number;
	readonly escape: boolean;
}

/** Escape sequences and graphemes in order, each with its width. */
function pieces(text: string): Piece[] {
	const out: Piece[] = [];
	text.split(ESCAPE).forEach((part, index) => {
		// split() with a capture group puts each escape at an odd index.
		if (index % 2 === 1) out.push({ text: part, width: 0, escape: true });
		else if (PRINTABLE_ASCII.test(part)) for (const char of part) out.push({ text: char, width: 1, escape: false });
		else for (const { segment } of graphemes.segment(part)) out.push({ text: segment, width: cellWidth(segment), escape: false });
	});
	return out;
}

export function stripAnsi(text: string): string {
	return stripTerminalSequences(text);
}

/** Terminal cells the text takes, as pi-tui counts them. */
export function visibleWidth(text: string): number {
	return cellWidth(text);
}

export function padEndVisible(text: string, width: number): string {
	const pad = width - visibleWidth(text);
	return pad > 0 ? text + " ".repeat(pad) : text;
}

export function padStartVisible(text: string, width: number): string {
	const pad = width - visibleWidth(text);
	return pad > 0 ? " ".repeat(pad) + text : text;
}

/**
 * Cut visible text to `width`, keeping every escape sequence (so colors and
 * links that were opened before the cut are still closed after it) and ending
 * with the marker when something was removed. A wide character that would
 * cross the edge is dropped whole, and a marker wider than `width` is left out.
 */
export function truncateVisible(text: string, width: number, marker = ""): string {
	if (visibleWidth(text) <= width) return text;
	const mark = visibleWidth(marker) <= width ? marker : "";
	const keep = Math.max(0, width - visibleWidth(mark));
	let out = "";
	let seen = 0;
	let cut = false;
	for (const piece of pieces(text)) {
		if (piece.escape) out += piece.text;
		else if (cut) continue;
		else if (seen + piece.width > keep) {
			out += mark;
			cut = true;
		} else {
			out += piece.text;
			seen += piece.width;
		}
	}
	return out;
}

/** Paint over cells, retaining suffix positions and replaying its original SGR state. */
export function overlayVisible(text: string, start: number, replacement: string): string {
	const end = start + visibleWidth(replacement);
	let seen = 0;
	let suffix = "";
	for (const piece of pieces(text)) {
		if (piece.escape) suffix += piece.text;
		// A wide character the replacement covers in part leaves blank cells, so the suffix keeps its columns.
		else if (seen >= end) suffix += piece.text;
		else if (seen + piece.width > end) suffix += " ".repeat(seen + piece.width - end);
		seen += piece.width;
	}
	return padEndVisible(truncateVisible(text, start), start) + replacement + suffix;
}

/** Keep the tail of a path-like string, marking the dropped head. */
export function truncateStart(text: string, width: number, marker = "…"): string {
	if (visibleWidth(text) <= width) return text;
	const mark = visibleWidth(marker) <= width ? marker : "";
	let room = Math.max(0, width - visibleWidth(mark));
	const tail: string[] = [];
	for (const piece of pieces(text).reverse()) {
		if (piece.escape) continue;
		if (piece.width > room) break;
		tail.unshift(piece.text);
		room -= piece.width;
	}
	return mark + tail.join("");
}
