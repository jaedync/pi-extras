/**
 * Text read from a VM's console frame by Windows OCR on the host, for screens
 * UI Automation can't describe: custom-drawn apps, MMC consoles and the secure
 * desktop (UAC and sign-in). It needs no vision model and works on any screen
 * the console shows. Words become items with centers in guest pixels, the same
 * coordinates win.click and win.console.click take.
 */

export interface OcrWord { readonly text: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface OcrLine { readonly words: readonly OcrWord[] }
export interface OcrResult { readonly width: number; readonly height: number; readonly lines: readonly OcrLine[] }
export interface OcrItem { readonly text: string; readonly x: number; readonly y: number }
export interface Region { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * OCR joins words on one baseline into a line even when they are separate
 * controls, such as a menu bar's items. A gap wider than the words are tall
 * splits them: spaces in running text are a third to half of that.
 */
const GAP_RATIO = 1;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function malformed(): Error {
	return new Error("the host sent a malformed OCR result");
}

function readWord(value: unknown): OcrWord {
	const word = record(value);
	if (!word || typeof word.text !== "string" || !finite(word.x) || !finite(word.y) || !finite(word.w) || !finite(word.h)) throw malformed();
	return { text: word.text, x: word.x, y: word.y, w: word.w, h: word.h };
}

/** The host's OCR answer, checked: `{ width, height, lines: [{ words: [{ text, x, y, w, h }] }] }`. */
export function readOcr(value: unknown): OcrResult {
	const raw = record(value);
	if (!raw || !finite(raw.width) || !finite(raw.height) || !Array.isArray(raw.lines)) throw malformed();
	const lines = raw.lines.map((line) => {
		const words = record(line)?.words;
		if (!Array.isArray(words)) throw malformed();
		return { words: words.map(readWord) };
	});
	return { width: raw.width, height: raw.height, lines };
}

interface Box extends OcrItem { readonly h: number }

function toBox(words: readonly OcrWord[]): Box {
	const left = Math.min(...words.map((word) => word.x));
	const right = Math.max(...words.map((word) => word.x + word.w));
	const top = Math.min(...words.map((word) => word.y));
	const bottom = Math.max(...words.map((word) => word.y + word.h));
	return { text: words.map((word) => word.text).join(" "), x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2), h: bottom - top };
}

/** A line's words, split into items wherever a gap is wider than the words beside it are tall. */
function splitLine(line: OcrLine): Box[] {
	const words = [...line.words].sort((a, b) => a.x - b.x);
	const groups: OcrWord[][] = [];
	for (const word of words) {
		const group = groups.at(-1);
		const last = group?.at(-1);
		if (group && last && word.x - (last.x + last.w) <= GAP_RATIO * Math.max(last.h, word.h)) group.push(word);
		else groups.push([word]);
	}
	return groups.map(toBox);
}

const inside = (item: OcrItem, region: Region) =>
	item.x >= region.x && item.x < region.x + region.width && item.y >= region.y && item.y < region.y + region.height;

/**
 * Items in reading order: rows top to bottom, left to right within a row.
 * Items share a row when their centers are within half the taller one's
 * height, since OCR reports a row's lines in no particular order.
 */
export function ocrItems(lines: readonly OcrLine[], region?: Region): OcrItem[] {
	const boxes = lines.flatMap(splitLine).filter((box) => !region || inside(box, region)).sort((a, b) => a.y - b.y);
	const rows: Box[][] = [];
	for (const box of boxes) {
		const row = rows.at(-1);
		const first = row?.[0];
		if (row && first && Math.abs(box.y - first.y) <= Math.max(first.h, box.h) / 2) row.push(box);
		else rows.push([box]);
	}
	return rows.flatMap((row) => [...row].sort((a, b) => a.x - b.x)).map(({ text, x, y }) => ({ text, x, y }));
}

/** One "(x,y) text" per item, the shape snapshot text uses. */
export function ocrText(items: readonly OcrItem[]): string {
	return items.map((item) => `(${item.x},${item.y}) ${item.text}`).join("\n");
}
