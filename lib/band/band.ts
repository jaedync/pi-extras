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
import { visibleWidth } from "@earendil-works/pi-tui";
import { bgSgr, mix, type Rgb } from "./color.ts";
import type { BandTheme, Palette } from "./palette.ts";

export type Outcome = "ok" | "fail" | "timeout" | "aborted";
export type Motion = "full" | "reduced";

export type BandPhase =
	| { readonly kind: "writing" }
	| { readonly kind: "queued" }
	/** Running out of sight, in the background: a steady tint that doesn't draw the eye. */
	| { readonly kind: "calm" }
	| { readonly kind: "running"; readonly elapsedMs: number; readonly timeoutMs?: number }
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

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const wave = (ms: number, period: number) => 0.5 + 0.5 * Math.sin((2 * Math.PI * ms) / period - Math.PI / 2);

export function easedFill(share: number, strength = EASE): number {
	return Math.log1p(strength * clamp(share)) / Math.log1p(strength);
}

export function formatTime(ms: number): string {
	if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
	const seconds = Math.floor(ms / 1_000);
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
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
		case "running": {
			if (!phase.timeoutMs) {
				if (motion === "reduced") return () => mix(base, accent, 0.1);
				const center = ((clockMs % SWEEP_MS) / SWEEP_MS) * (width + 30) - 15;
				return (x) => mix(base, accent, 0.08 + 0.16 * Math.pow(clamp(1 - Math.abs(x - center) / 12), 1.4));
			}
			const share = clamp(phase.elapsedMs / phase.timeoutMs);
			const edge = Math.max(1, Math.ceil(easedFill(share) * width));
			// The heat follows the real share of the timeout, so amber means a kill is actually close.
			const hue = mix(accent, palette.warning, clamp((share - 0.5) / 0.4));
			const filled = mix(base, hue, 0.2);
			const lead = mix(base, hue, 0.27 + (motion === "full" ? 0.05 * wave(clockMs, 1_000) : 0));
			const rest = mix(base, accent, 0.05);
			return (x) => (x === edge - 1 ? lead : x < edge ? filled : rest);
		}
	}
}

/** The theme background a band uses when the palette can't be derived. */
function fallbackKey(phase: BandPhase): string {
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

function fgCode(theme: BandTheme, color: string): string {
	try { return theme.getFgAnsi(color); } catch { return ""; }
}

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
		out += withPalette ? text : runColor ? safeFg(theme, runColor, text) : text;
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

function safeFg(theme: BandTheme, key: string, text: string): string {
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
	readonly indent?: number;
}

export function renderBand(theme: BandTheme, palette: Palette | undefined, spec: BandSpec): string {
	const motion = spec.motion ?? "full";
	const bgAt = palette ? bandBackground(palette, spec.phase, spec.width, spec.clockMs, motion) : undefined;
	return paintLine(theme, palette, {
		width: spec.width,
		left: spec.segs,
		rail: spec.rail,
		...(spec.indent !== undefined ? { indent: spec.indent } : {}),
		...(bgAt ? { bgAt } : {}),
		fallbackBg: fallbackKey(spec.phase),
	});
}

/** Whether a phase still changes on its own, so its row needs animation ticks. */
export function isAnimated(phase: BandPhase, motion: Motion): boolean {
	if (phase.kind === "running") return true;
	return phase.kind === "done" && motion === "full" && phase.sinceMs < FLASH_MS;
}
