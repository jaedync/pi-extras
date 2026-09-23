/** Width-aware string helpers that see through SGR escape sequences. */

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/** Code-point count of the visible text; footer content is single-width. */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const _ of text.includes("\x1b") ? stripAnsi(text) : text) width += 1;
	return width;
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
 * Cut visible text to `width`, keeping every escape sequence (so colors that
 * were opened before the cut are still closed after it) and ending with the
 * marker when something was removed.
 */
export function truncateVisible(text: string, width: number, marker = ""): string {
	if (visibleWidth(text) <= width) return text;
	const keep = Math.max(0, width - visibleWidth(marker));
	let out = "";
	let seen = 0;
	let cut = false;
	for (const piece of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
		if (piece.startsWith("\x1b")) {
			out += piece;
			continue;
		}
		if (cut) continue;
		for (const char of piece) {
			if (seen === keep) {
				out += marker;
				cut = true;
				break;
			}
			out += char;
			seen++;
		}
	}
	return out;
}

/** Paint over cells, retaining suffix positions and replaying its original SGR state. */
export function overlayVisible(text: string, start: number, replacement: string): string {
	const end = start + visibleWidth(replacement);
	let seen = 0;
	let suffix = "";
	for (const piece of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
		if (piece.startsWith("\x1b")) {
			suffix += piece;
			continue;
		}
		for (const char of piece) {
			if (seen >= end) suffix += char;
			seen++;
		}
	}
	return padEndVisible(truncateVisible(text, start), start) + replacement + suffix;
}

/** Keep the tail of a path-like string, marking the dropped head. */
export function truncateStart(text: string, width: number, marker = "…"): string {
	const chars = [...text];
	if (chars.length <= width) return text;
	return marker + chars.slice(chars.length - Math.max(0, width - [...marker].length)).join("");
}
