/**
 * Band colors derived from the active theme, so any theme gets bands in its
 * own colors. The gray base is the theme's pending tool background; finished
 * bands start from the theme's success and error backgrounds and lean further
 * toward their hue, which is what makes a status readable at a glance.
 */
import { mix, parseAnsiColor, type ColorMode, type Rgb } from "./color.ts";

/** The theme surface bands use; Pi's Theme satisfies it. */
export interface BandTheme {
	getFgAnsi(key: string): string;
	getBgAnsi(key: string): string;
	getColorMode(): ColorMode;
	fg(key: string, text: string): string;
	bg(key: string, text: string): string;
}

export interface Palette {
	readonly mode: ColorMode;
	/** The resting gray: arguments streaming, queued, and the unfilled part of a progress band. */
	readonly base: Rgb;
	readonly ok: Rgb;
	readonly fail: Rgb;
	readonly timeout: Rgb;
	readonly aborted: Rgb;
	readonly accent: Rgb;
	readonly warning: Rgb;
	readonly success: Rgb;
	readonly error: Rgb;
	readonly muted: Rgb;
}

// How far finished bands lean from the theme's backgrounds toward their hue.
const DONE_TINT = 0.12;
const TIMEOUT_TINT = 0.14;
const ABORTED_TINT = 0.08;

function read(theme: BandTheme, kind: "fg" | "bg", key: string): Rgb | undefined {
	try {
		return parseAnsiColor(kind === "fg" ? theme.getFgAnsi(key) : theme.getBgAnsi(key));
	} catch {
		return undefined;
	}
}

const cache = new WeakMap<object, Palette | null>();

/**
 * The palette for a theme, or undefined when its colors can't be read back
 * (a default-colored background, say); bands then use the theme's backgrounds as-is.
 */
export function paletteFrom(theme: BandTheme): Palette | undefined {
	const cached = cache.get(theme);
	if (cached !== undefined) return cached ?? undefined;
	const palette = build(theme);
	cache.set(theme, palette ?? null);
	return palette;
}

function build(theme: BandTheme): Palette | undefined {
	const base = read(theme, "bg", "toolPendingBg");
	if (!base) return undefined;
	const okBg = read(theme, "bg", "toolSuccessBg") ?? base;
	const failBg = read(theme, "bg", "toolErrorBg") ?? base;
	const accent = read(theme, "fg", "accent") ?? read(theme, "fg", "toolTitle") ?? [143, 180, 200];
	const success = read(theme, "fg", "success") ?? [143, 174, 122];
	const error = read(theme, "fg", "error") ?? [201, 122, 114];
	const warning = read(theme, "fg", "warning") ?? [236, 182, 78];
	const muted = read(theme, "fg", "muted") ?? [138, 136, 130];
	let mode: ColorMode = "truecolor";
	try { mode = theme.getColorMode(); } catch { /* truecolor */ }
	return {
		mode, base, accent, warning, success, error, muted,
		ok: mix(okBg, success, DONE_TINT),
		fail: mix(failBg, error, DONE_TINT),
		timeout: mix(base, warning, TIMEOUT_TINT),
		aborted: mix(base, muted, ABORTED_TINT),
	};
}
