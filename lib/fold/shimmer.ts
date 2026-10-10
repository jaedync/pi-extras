/**
 * A live folded line's words rest on the settled line's gray, and a soft
 * band of light crosses them left to right, as a highlight crosses the phase
 * spinner's word. So a working line is no brighter than the rest, and still
 * reads as live.
 */
import { mixColors, visibleWidth, type Color } from "@earendil-works/pi-tui";

export interface ShimmerTheme {
	fg(key: string, text: string): string;
	readonly colors?: Readonly<Record<string, Color | undefined>>;
	style?(text: string, options: { fg?: Color }): string;
}

/** Columns a second the band moves: about one a frame, slow enough to read as calm. */
export const SHIMMER_SPEED = 12;
/** Half the band's width in columns; its light falls off softly to nothing there. */
export const SHIMMER_REACH = 5;
/** Columns of rest, off the words, between passes. */
const SHIMMER_REST = 12;
/** How far the band's middle leans from the gray toward the text color. */
export const SHIMMER_PEAK = 0.55;
/** Light levels a run of columns shares, so columns away from the band are one run. */
const LEVELS = 20;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Where the band's middle is, in columns from the first, at `ms`, over words `length` columns wide. */
export function shimmerAt(length: number, ms: number): number {
	const cycle = length + 2 * SHIMMER_REACH + SHIMMER_REST;
	return (((Math.max(0, ms) / 1_000) * SHIMMER_SPEED) % cycle) - SHIMMER_REACH;
}

/** How lit column `at` is, from 0 to 1, with the band's middle at `center`. */
export function lightAt(at: number, center: number): number {
	const distance = Math.abs(at - center);
	return distance >= SHIMMER_REACH ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * distance) / SHIMMER_REACH);
}

/**
 * The segments painted at `ms`: those in `tone` lit by the band, the rest in
 * their own color. Undefined when the theme can't give the colors to mix.
 */
export function shimmerWords(segments: readonly { key: string; text: string }[], tone: string, ms: number, theme: ShimmerTheme): string | undefined {
	const base = theme.colors?.[tone];
	const top = theme.colors?.text;
	const style = theme.style?.bind(theme);
	if (!base || !top || !style) return undefined;
	const length = segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
	const center = shimmerAt(length, ms);
	const colors = new Map<number, Color>();
	const colorAt = (level: number) => {
		const kept = colors.get(level);
		if (kept) return kept;
		const color = level === 0 ? base : mixColors(base, top, (SHIMMER_PEAK * level) / LEVELS);
		colors.set(level, color);
		return color;
	};
	let column = 0;
	let out = "";
	for (const segment of segments) {
		if (segment.key !== tone) {
			out += theme.fg(segment.key, segment.text);
			column += visibleWidth(segment.text);
			continue;
		}
		let run = "";
		let runLevel = -1;
		for (const { segment: grapheme } of graphemes.segment(segment.text)) {
			const level = Math.round(lightAt(column, center) * LEVELS);
			if (level !== runLevel && run) out += style(run, { fg: colorAt(runLevel) });
			if (level !== runLevel) run = "";
			run += grapheme;
			runLevel = level;
			column += visibleWidth(grapheme);
		}
		if (run) out += style(run, { fg: colorAt(runLevel) });
	}
	return out;
}
