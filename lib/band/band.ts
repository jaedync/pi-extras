/**
 * The header band: one terminal line whose background says what a tool call
 * is doing. Gray while arguments stream, a filling bar while it runs against a
 * timeout (a sweep when it has none), then green, red, amber for a timeout or
 * gray for an abort. The right side is a reserved rail for status and time,
 * drawn in full; the title is cut to make room.
 *
 * Lines are built cell by cell so the background can change per column; the
 * foreground colors are the theme's own escapes.
 */
import { foregroundAnsi, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { minutesAndUp } from "../duration.ts";
import { bgSgr, fgSgr, mix, parseAnsiColor, type Rgb } from "./color.ts";
import type { BandTheme, Palette } from "./palette.ts";
import { BULLET_GLYPH, penGlyph, toolIndicator, toolKind } from "./glyph.ts";

export type Outcome = "ok" | "fail" | "timeout" | "aborted";
export type Motion = "full" | "reduced";

export type BandPhase =
	/** A call written now has a clock, a size so far, and whether its arguments still flow; one rebuilt from history has none. */
	| { readonly kind: "writing"; readonly elapsedMs?: number; readonly chars?: number; readonly flowing?: boolean }
	| { readonly kind: "queued" }
	/** Running out of sight, in the background: a steady tint that doesn't draw the eye. */
	| { readonly kind: "calm" }
	| { readonly kind: "running"; readonly elapsedMs: number; readonly timeoutMs?: number }
	/** Running with a known share done (a download's percent, a sleep's time): a linear fill, no heat. */
	| { readonly kind: "progress"; readonly share: number }
	| { readonly kind: "done"; readonly outcome: Outcome; readonly sinceMs: number };

export interface Seg {
	readonly text: string;
	readonly color: string;
	readonly bold?: boolean;
	/** A URL the text links to, as an OSC 8 hyperlink. */
	readonly link?: string;
}

/** How strongly the fill eases: 30 puts 5s of a 300s timeout at 12% and 30s at 40%. */
export const EASE = 30;
export const FLASH_MS = 800;
export const SWEEP_MS = 2_200;
/** Times at or above this read in the warm heading color. */
export const SLOW_MS = 10_000;
/**
 * How far a running band leans toward its hue. These reproduce the approved design's medium
 * tint, which mixed from the terminal background; mixing from the lighter pending gray needs
 * these values to reach the same colors.
 */
const RUN_TINT = { rest: 0.05, fill: 0.31, lead: 0.38, pulse: 0.05, sweepLow: 0.06, sweepPeak: 0.34, steady: 0.15 } as const;

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const wave = (ms: number, period: number) => 0.5 + 0.5 * Math.sin((2 * Math.PI * ms) / period - Math.PI / 2);

export function easedFill(share: number, strength = EASE): number {
	return Math.log1p(strength * clamp(share)) / Math.log1p(strength);
}

/**
 * One way to write a time on every row (tools, steps, jobs, agents): `40ms`,
 * `8.6s`, then the two coarsest units run together, `24m23s`, `1h50m`.
 */
export function formatTime(ms: number): string {
	if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
	return minutesAndUp(Math.floor(ms / 1_000));
}

/**
 * A limit or a time left in the same units, but in whole seconds, rounded up
 * so it never reads 0s while something is left: `30s`, `30m00s`, `1h30m`.
 */
export function formatWhole(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1_000));
	return seconds < 60 ? `${seconds}s` : minutesAndUp(seconds);
}

/** A finished time for the rail, warm when the call was slow. */
export const timeSeg = (ms: number): Seg => ({ text: formatTime(ms), color: ms >= SLOW_MS ? "mdHeading" : "muted" });

const HUE: Record<Outcome, keyof Palette> = { ok: "success", fail: "error", timeout: "warning", aborted: "muted" };

/** The band's background at each column. */
export function bandBackground(palette: Palette, phase: BandPhase, width: number, clockMs: number, motion: Motion): (x: number) => Rgb {
	const { base, accent } = palette;
	switch (phase.kind) {
		case "writing": return () => base;
		case "queued": return () => mix(base, palette.muted, 0.05);
		case "calm": return () => mix(base, accent, 0.06);
		case "done": {
			const settled = palette[phase.outcome];
			if (motion === "reduced" || phase.sinceMs >= FLASH_MS) return () => settled;
			const flashed = mix(settled, palette[HUE[phase.outcome]] as Rgb, 0.3 * (1 - phase.sinceMs / FLASH_MS));
			return () => flashed;
		}
		case "progress": {
			// The cell the fill is crossing takes the fraction of it that is done, so a long
			// job visibly creeps instead of holding still for the half minute a cell can take.
			const exact = clamp(phase.share) * width;
			const whole = Math.floor(exact);
			const filled = mix(base, accent, RUN_TINT.fill);
			const rest = mix(base, accent, RUN_TINT.rest);
			const lead = mix(base, accent, RUN_TINT.lead + (motion === "full" ? RUN_TINT.pulse * wave(clockMs, 1_000) : 0));
			const crossing = mix(rest, lead, exact - whole);
			return (x) => (x < whole ? filled : x === whole ? crossing : rest);
		}
		case "running": {
			if (!phase.timeoutMs) {
				if (motion === "reduced") return () => mix(base, accent, RUN_TINT.steady);
				const center = ((clockMs % SWEEP_MS) / SWEEP_MS) * (width + 30) - 15;
				const swing = RUN_TINT.sweepPeak - RUN_TINT.sweepLow;
				return (x) => mix(base, accent, RUN_TINT.sweepLow + swing * Math.pow(clamp(1 - Math.abs(x - center) / 12), 1.4));
			}
			const share = clamp(phase.elapsedMs / phase.timeoutMs);
			const edge = Math.max(1, Math.ceil(easedFill(share) * width));
			// The heat follows the real share of the timeout, so amber means a kill is actually close.
			const hue = mix(accent, palette.warning, clamp((share - 0.5) / 0.4));
			const filled = mix(base, hue, RUN_TINT.fill);
			const lead = mix(base, hue, RUN_TINT.lead + (motion === "full" ? RUN_TINT.pulse * wave(clockMs, 1_000) : 0));
			const rest = mix(base, accent, RUN_TINT.rest);
			return (x) => (x === edge - 1 ? lead : x < edge ? filled : rest);
		}
	}
}

/** The theme background a band uses when the palette can't be derived. */
export function fallbackKey(phase: BandPhase): string {
	if (phase.kind !== "done") return "toolPendingBg";
	return phase.outcome === "ok" ? "toolSuccessBg" : phase.outcome === "aborted" ? "toolPendingBg" : "toolErrorBg";
}

interface Glyph { readonly text: string; readonly width: number; readonly color: string; readonly bold: boolean; readonly link?: string }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function glyphs(segs: readonly Seg[]): Glyph[] {
	const out: Glyph[] = [];
	for (const seg of segs) {
		for (const { segment } of segmenter.segment(seg.text)) {
			const width = visibleWidth(segment);
			if (width === 0) continue;
			out.push({ text: segment, width, color: seg.color, bold: seg.bold === true, ...(seg.link ? { link: seg.link } : {}) });
		}
	}
	return out;
}

/** Glyphs that fit in `room` columns, ending in an ellipsis when cut. */
function fit(all: readonly Glyph[], room: number): Glyph[] {
	const total = all.reduce((sum, glyph) => sum + glyph.width, 0);
	if (total <= room) return [...all];
	const out: Glyph[] = [];
	let used = 0;
	for (const glyph of all) {
		if (used + glyph.width > room - 1) break;
		out.push(glyph);
		used += glyph.width;
	}
	if (room >= 1) out.push({ text: "…", width: 1, color: "muted", bold: false });
	return out;
}

export interface LineSpec {
	readonly width: number;
	readonly left: readonly Seg[];
	/** Where the left segments start. */
	readonly indent?: number;
	/** Drawn in full at the right edge, one column in. */
	readonly rail?: readonly Seg[];
	/** Background per column; undefined leaves the terminal's own. */
	readonly bgAt?: (x: number) => Rgb | undefined;
	/** The theme background for the whole line when there is no palette. */
	readonly fallbackBg?: string;
}

/**
 * A segment color is a theme key, a raw escape, or `#rrggbb` for a color
 * that means the same in every theme (a provider's), set in whatever color
 * mode the terminal uses.
 */
function fgCode(theme: BandTheme, color: string): string {
	if (color.startsWith("\x1b[")) return color;
	const fixed = HEX.exec(color);
	if (fixed) return fgSgr([1, 2, 3].map((group) => parseInt(fixed[group]!, 16)) as unknown as Rgb, theme.getColorMode?.() ?? "truecolor");
	try { return theme.getFgAnsi(color); } catch { return ""; }
}

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

const OSC8 = (url: string) => `\x1b]8;;${url}\x1b\\`;

/** Lays out one line: the left segments cut to fit, then the rail at the right edge. */
export function paintLine(theme: BandTheme, palette: Palette | undefined, spec: LineSpec): string {
	const width = Math.max(1, spec.width);
	const indent = spec.indent ?? 1;
	const rail = fit(glyphs(spec.rail ?? []), Math.max(0, width - indent - 1));
	const railWidth = rail.reduce((sum, glyph) => sum + glyph.width, 0);
	const room = Math.max(0, width - 1 - (railWidth ? railWidth + 2 : 0) - indent);
	const cols: Array<Glyph | null | undefined> = Array.from({ length: width }, () => undefined);
	const put = (items: readonly Glyph[], start: number) => {
		let x = start;
		for (const glyph of items) {
			if (x + glyph.width > width) break;
			cols[x] = glyph;
			for (let k = 1; k < glyph.width; k++) cols[x + k] = null;
			x += glyph.width;
		}
	};
	put(fit(glyphs(spec.left), room), indent);
	put(rail, width - 1 - railWidth);

	const withPalette = palette !== undefined;
	let out = "";
	let runKey = "";
	let runText = "";
	let runLink: string | undefined;
	let runColor = "";
	const flush = () => {
		if (!runText) return;
		const text = runLink ? `${OSC8(runLink)}${runText}${OSC8("")}` : runText;
		out += withPalette ? text : runColor ? paintFg(theme, runColor, text) : text;
		runText = "";
	};
	for (let x = 0; x < width; x++) {
		const cell = cols[x];
		if (cell === null) continue;
		const glyph = cell ?? { text: " ", width: 1, color: "", bold: false };
		const bg = withPalette && spec.bgAt ? spec.bgAt(x) : undefined;
		const bgCode = bg ? bgSgr(bg, palette!.mode) : "\x1b[49m";
		const fg = glyph.color ? (withPalette ? fgCode(theme, glyph.color) : glyph.color) : withPalette ? "\x1b[39m" : "";
		const key = `${bgCode}|${fg}|${glyph.bold}|${glyph.link ?? ""}`;
		if (key !== runKey) {
			flush();
			runKey = key;
			runLink = glyph.link;
			runColor = glyph.color;
			if (withPalette) out += `${bgCode}${fg}${glyph.bold ? "\x1b[1m" : "\x1b[22m"}`;
		}
		runText += glyph.text;
	}
	flush();
	if (!withPalette) return spec.fallbackBg ? safeBg(theme, spec.fallbackBg, out) : out;
	return `${out}\x1b[0m`;
}

/** Text in a segment color, outside a painted line; an unknown theme key leaves it plain. */
export function paintFg(theme: BandTheme, key: string, text: string): string {
	if (key.startsWith("\x1b[") || HEX.test(key)) return `${fgCode(theme, key)}${text}\x1b[39m`;
	try { return theme.fg(key, text); } catch { return text; }
}

function safeBg(theme: BandTheme, key: string, text: string): string {
	try { return theme.bg(key, text); } catch { return text; }
}

export interface BandSpec {
	readonly width: number;
	readonly phase: BandPhase;
	readonly segs: readonly Seg[];
	readonly rail: readonly Seg[];
	readonly clockMs: number;
	readonly motion?: Motion;
	readonly toolName?: string;
	readonly indent?: number;
	/** A transcript row: the title starts `ROW_MARGIN` columns later, after the call's spinner; `blank` keeps the columns empty. */
	readonly margin?: boolean | "blank";
	/** The phase the margin shows, when the band is colored as another (purple rows stay purple while written). */
	readonly marginPhase?: BandPhase;
}

/**
 * The columns a transcript row keeps at its left for a spinner while the model
 * writes or runs the call. Rows indent their lines by as much, so every row lines up.
 */
export const ROW_MARGIN = 2;

const BLANK_MARGIN: Seg = { text: " ".repeat(ROW_MARGIN), color: "" };

/**
 * The margin: a spinner while the call is written or runs, a still dot while
 * it waits, else blank. Frames follow the clock, not the call, so every
 * spinner on screen (the divider's too) turns in step.
 */
function indicatorColor(theme: BandTheme, blend: number): string {
	const dim = parseAnsiColor(fgCode(theme, "dim")), accent = parseAnsiColor(fgCode(theme, "accent"));
	if (!dim || !accent) return blend < .5 ? "dim" : "accent";
	const [r,g,b] = mix(dim, accent, blend);
	return foregroundAnsi(rgbColor(r,g,b), theme.getColorMode?.() ?? "truecolor");
}
function marginSeg(theme: BandTheme, phase: BandPhase, motion: Motion, toolName: string): Seg {
	const mark = (glyph: string, color: string): Seg => ({ text: `${glyph}${" ".repeat(ROW_MARGIN - 1)}`, color });
	switch (phase.kind) {
		case "writing":
			if (phase.elapsedMs === undefined || motion === "reduced") return mark(BULLET_GLYPH, "dim");
			return mark(penGlyph(phase.elapsedMs, phase.flowing === true), phase.flowing ? "accent" : "dim");
		case "running": {
			if (motion === "reduced") return mark(BULLET_GLYPH, "accent");
			const fraction = phase.timeoutMs ? phase.elapsedMs / phase.timeoutMs : undefined;
			const indicator = toolIndicator(phase.elapsedMs, fraction, toolKind(toolName, fraction));
			return mark(indicator.glyph, indicatorColor(theme, indicator.blend));
		}
		case "queued": return mark(BULLET_GLYPH, "dim");
		case "done": return mark(BULLET_GLYPH, phase.outcome === "ok" ? "success" : phase.outcome === "fail" ? "error" : phase.outcome === "timeout" ? "warning" : "muted");
		default: return mark(BULLET_GLYPH, "dim");
	}
}

export function renderBand(theme: BandTheme, palette: Palette | undefined, spec: BandSpec): string {
	const motion = spec.motion ?? "full";
	const bgAt = palette ? bandBackground(palette, spec.phase, spec.width, spec.clockMs, motion) : undefined;
	return paintLine(theme, palette, {
		width: spec.width,
		left: spec.margin ? [spec.margin === "blank" ? BLANK_MARGIN : marginSeg(theme, spec.marginPhase ?? spec.phase, motion, spec.toolName ?? ""), ...spec.segs] : spec.segs,
		rail: spec.rail,
		...(spec.indent !== undefined ? { indent: spec.indent } : spec.margin ? { indent: 0 } : {}),
		...(bgAt ? { bgAt } : {}),
		fallbackBg: fallbackKey(spec.phase),
	});
}

/** Running, a call written now (its clock ticks) and the brief finish flash need animation ticks. */
export function isAnimated(phase: BandPhase, motion: Motion, margined = false): boolean {
	if (phase.kind === "running" || phase.kind === "progress") return true;
	if (phase.kind === "writing") return margined && phase.elapsedMs !== undefined;
	return phase.kind === "done" && motion === "full" && phase.sinceMs < FLASH_MS;
}
