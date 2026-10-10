/**
 * New characters of streamed text show brighter for a moment, then fade to
 * the text's own color, so a stream reads as arriving. A trail notes how long
 * the text was at each moment; a character's age is the time since the text
 * first grew past it.
 */
import { fgSgr, mix, parseAnsiColor, type ColorMode, type Rgb } from "./color.ts";

export const GLOW_MS = 700;
// Brightness steps: few enough that a line keeps few color runs, enough that the fade looks smooth.
const LEVELS = 6;

export interface Mark { readonly length: number; readonly at: number }
export interface Trail {
	/** Which text it follows: another key starts a new trail. */
	readonly key: string;
	readonly marks: readonly Mark[];
}

const lengthOf = (trail: Trail): number => trail.marks[trail.marks.length - 1]?.length ?? 0;

export function noteText(trail: Trail | undefined, key: string, length: number, now: number): Trail {
	if (!trail || trail.key !== key || length < lengthOf(trail)) return { key, marks: [{ length, at: now }] };
	if (length === lengthOf(trail)) return trail;
	// A mark older than the glow can never brighten a character again; the newest such mark keeps the boundary.
	const cut = now - GLOW_MS;
	let first = 0;
	trail.marks.forEach((mark, index) => { if (mark.at <= cut) first = index; });
	return { key, marks: [...trail.marks.slice(first), { length, at: now }] };
}

/** 1 when the character at `index` has just arrived, falling to 0 over the glow. */
export function freshness(trail: Trail | undefined, index: number, now: number): number {
	const arrived = trail?.marks.find((mark) => mark.length > index)?.at;
	if (arrived === undefined) return 0;
	const left = 1 - (now - arrived) / GLOW_MS;
	return left <= 0 ? 0 : Math.min(1, left) ** 2;
}

/** Whether any character still glows, so the row asks for frames until it has faded. */
export const glowing = (trail: Trail | undefined, now: number): boolean =>
	trail !== undefined && trail.marks.length > 0 && now - trail.marks[trail.marks.length - 1]!.at < GLOW_MS;

export interface GlowTheme {
	fg(key: string, text: string): string;
	getFgAnsi?(key: string): string;
	getColorMode?(): ColorMode;
}

function colorOf(theme: GlowTheme, key: string): Rgb | undefined {
	try { return theme.getFgAnsi ? parseAnsiColor(theme.getFgAnsi(key)) : undefined; } catch { return undefined; }
}

/**
 * Paints the tail lines of a text whose last line ends at `length`. Lines are
 * counted back from the end with one break between them, so a wrap that
 * dropped a space shifts the glow by a character at most.
 */
export function glowLines(lines: readonly string[], length: number, trail: Trail | undefined, now: number, theme: GlowTheme, base: string, bright = "text"): string[] {
	const from = colorOf(theme, base), to = colorOf(theme, bright);
	if (!from || !to || !glowing(trail, now)) return lines.map((line) => theme.fg(base, line));
	let mode: ColorMode = "truecolor";
	try { mode = theme.getColorMode?.() ?? mode; } catch { /* truecolor */ }
	const paint = (level: number, text: string) => (level === 0 ? theme.fg(base, text) : `${fgSgr(mix(from, to, level / LEVELS), mode)}${text}\x1b[39m`);
	let end = length;
	const painted: string[] = [];
	for (let k = lines.length - 1; k >= 0; k--) {
		const chars = [...lines[k]!];
		const start = end - chars.length;
		let out = "", run = "", level = -1;
		chars.forEach((ch, i) => {
			const next = Math.round(freshness(trail, start + i, now) * LEVELS);
			if (next !== level && run) { out += paint(level, run); run = ""; }
			level = next;
			run += ch;
		});
		painted.unshift(run ? out + paint(level, run) : out);
		end = start - 1;
	}
	return painted;
}
