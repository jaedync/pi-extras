/**
 * One-line voice indicator. Pure: state and clock in, styled string out.
 * Shows activity, never the transcript, so the user is not distracted by
 * words appearing while they speak.
 */
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ChunkViewState = "filling" | "queued" | "decoding" | "done";

export interface ChunkView {
	readonly state: ChunkViewState;
	readonly openedAt: number;
}

export interface IndicatorState {
	readonly phase: "connecting" | "loading" | "recording" | "finishing" | "inserted" | "cancelled" | "error";
	readonly startedAt: number;
	readonly stoppedAt?: number;
	/** 0..1 input levels, oldest first. */
	readonly levels: readonly number[];
	readonly speaking: boolean;
	readonly chunks: readonly ChunkView[];
	/** Audio captured before the daemon connected. */
	readonly queuedMs: number;
	readonly backend?: string;
	/** Human name of the loaded model, e.g. "parakeet 0.6b-v3". */
	readonly model?: string;
	/** The daemon is loading the model, so decoding waits behind it. */
	readonly loadingModel?: boolean;
	/** Human name of the microphone, when the recorder knows it. */
	readonly device?: string;
	/** No audible input yet after a few seconds: likely the wrong or a muted mic. */
	readonly quiet?: boolean;
	/** Last time the input hit full scale. */
	readonly clippedAt?: number;
	readonly message?: string;
}

export interface Palette {
	accent(text: string): string;
	dim(text: string): string;
	warn(text: string): string;
	error(text: string): string;
	muted(text: string): string;
	/** The error color moved `amount` (0..1) toward dim; absent where colors cannot be mixed. */
	pulse?(text: string, amount: number): string;
}

/** The recording dot breathes this far toward dim and back, once per period, like a recording light. */
export const PULSE_DEPTH = 0.4;
export const PULSE_PERIOD_MS = 2400;
const TRUECOLOR_FG = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/;

/** Mix two truecolor foreground escapes; undefined for any other color mode. */
export function blendAnsi(from: string, to: string, amount: number): string | undefined {
	const a = TRUECOLOR_FG.exec(from);
	const b = TRUECOLOR_FG.exec(to);
	if (!a || !b) return undefined;
	const mix = (i: number) => Math.round(Number(a[i]) + (Number(b[i]) - Number(a[i])) * amount);
	return `\x1b[38;2;${mix(1)};${mix(2)};${mix(3)}m`;
}

/** Must match the daemon's maximum speech segment. */
export const MAX_CHUNK_MS = 12_000;
export const METER_WIDTH = 14;
const MAX_VISIBLE_CHUNKS = 12;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
// The usual wait after stop is one short chunk's decode; labelling that would only flash.
export const WAIT_LABEL_AFTER_MS = 1000;
const CLIP_WARN_MS = 2000;
// Braille columns filled from the middle out: none, the two middle dots, all four.
const BRAILLE_BLANK = 0x2800;
const LEFT_COLUMN = [0, 0x02 | 0x04, 0x01 | 0x02 | 0x04 | 0x40];
const RIGHT_COLUMN = [0, 0x10 | 0x20, 0x08 | 0x10 | 0x20 | 0x80];
const MIDDLE_LEVEL = 0.15;
const FULL_LEVEL = 0.5;
// Heat thresholds on the 0..1 level scale (-60..-6 dBFS): speech sits in accent, near full scale turns red.
const HOT_LEVEL = 0.8;
const CLIPPING_LEVEL = 0.95;
// A filling chunk is cut at MAX_CHUNK_MS; it warms up so the cut is not a surprise.
const FILL_VISIBLE = 1 / 3;
const FILL_WARN = 3 / 4;
// Mirrors the "── " that opens the row, so the right-hand labels do not touch the edge.
const RIGHT_CAP = " ──";
// A lone full-scale sample is a transient; a few in 100 ms mean the input is saturating.
const CLIPPED_SAMPLES = 4;
const FULL_SCALE = 32_767;

/** Steady glyphs: state shows by shape and color, never by blinking. */
export function chunkGlyph(chunk: ChunkView, now: number, p: Palette): string {
	switch (chunk.state) {
		case "done":
			return p.accent("◆");
		case "decoding":
			return p.accent("◈");
		case "queued":
			return p.dim("◇");
		case "filling": {
			const fill = (now - chunk.openedAt) / MAX_CHUNK_MS;
			return fill >= FILL_WARN ? p.warn("◇") : fill >= FILL_VISIBLE ? p.accent("◇") : p.dim("◇");
		}
	}
}

export function levelFromPcm(frame: Int16Array): number {
	if (frame.length === 0) return 0;
	let sum = 0;
	for (const sample of frame) sum += sample * sample;
	const rms = Math.sqrt(sum / frame.length) / 32768;
	if (rms <= 0) return 0;
	// Map -60 dBFS (room noise) .. -6 dBFS (loud speech) onto 0..1.
	const db = 20 * Math.log10(rms);
	return Math.min(1, Math.max(0, (db + 60) / 54));
}

export function isClipped(frame: Int16Array): boolean {
	let count = 0;
	for (const sample of frame) {
		if ((sample >= FULL_SCALE || sample <= -FULL_SCALE) && ++count >= CLIPPED_SAMPLES) return true;
	}
	return false;
}

function clipWarning(state: IndicatorState, now: number, p: Palette): string {
	if (state.clippedAt === undefined || !livePhase(state) || now - state.clippedAt >= CLIP_WARN_MS) return "";
	return p.warn("▲ too loud");
}

function quietWarning(state: IndicatorState, p: Palette): string {
	return state.quiet && livePhase(state) ? p.warn("▼ can't hear you, try /voice mic") : "";
}

function clock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function columnHeight(level: number): number {
	return level >= FULL_LEVEL ? 2 : level >= MIDDLE_LEVEL ? 1 : 0;
}

function heat(level: number, p: Palette): (text: string) => string {
	if (level >= CLIPPING_LEVEL) return p.error;
	if (level >= HOT_LEVEL) return p.warn;
	return level >= MIDDLE_LEVEL ? p.accent : p.dim;
}

/** Input levels as braille that grows from the middle of the line, colored by loudness. */
export function meter(levels: readonly number[], p: Palette): string {
	const samples = METER_WIDTH * 2;
	const recent = levels.slice(-samples);
	const padded = [...Array<number>(Math.max(0, samples - recent.length)).fill(0), ...recent];
	let out = "";
	for (let i = 0; i < samples; i += 2) {
		const left = padded[i]!;
		const right = padded[i + 1]!;
		const glyph = String.fromCodePoint(BRAILLE_BLANK + LEFT_COLUMN[columnHeight(left)]! + RIGHT_COLUMN[columnHeight(right)]!);
		out += heat(Math.max(left, right), p)(glyph);
	}
	return out;
}

function chunkRow(chunks: readonly ChunkView[], now: number, p: Palette): string {
	const hidden = Math.max(0, chunks.length - MAX_VISIBLE_CHUNKS);
	const glyphs = chunks.slice(hidden).map((chunk) => chunkGlyph(chunk, now, p)).join("");
	return hidden > 0 ? `${p.dim(`+${hidden}`)}${glyphs}` : glyphs;
}

/** What a stopped dictation is still waiting for, once the wait is long enough to notice. */
function waitLabel(state: IndicatorState, now: number): string | undefined {
	if (state.stoppedAt === undefined || now - state.stoppedAt < WAIT_LABEL_AFTER_MS) return undefined;
	if (state.queuedMs > 0) return "starting voice";
	return state.loadingModel ? "loading the speech model" : "transcribing";
}

function trailer(state: IndicatorState, now: number, p: Palette): string {
	const spin = p.warn(SPINNER[Math.floor(now / 80) % SPINNER.length]);
	switch (state.phase) {
		case "connecting": {
			const dashes = "┄".repeat(Math.min(12, Math.max(1, Math.ceil(state.queuedMs / 700))));
			return `${spin} ${p.dim(state.message ?? "starting voice")}  ${p.dim(dashes)} ${p.dim(`${(state.queuedMs / 1000).toFixed(1)}s queued`)}`;
		}
		case "loading":
			return `${spin} ${p.dim("loading")}`;
		case "finishing": {
			const waiting = waitLabel(state, now);
			const parts = [waiting && `${spin} ${p.dim(waiting)}`, state.message && p.dim(state.message), waiting && p.dim("esc cancels")];
			return parts.filter(Boolean).join("  ");
		}
		case "cancelled":
			return p.dim(state.message ?? "cancelled");
		case "error":
			return p.error(state.message ?? "voice error");
		default:
			return state.message ? p.dim(state.message) : "";
	}
}

/** "mlx parakeet 0.6b-v3", shown at the right end of the line. */
export function modelLabel(state: IndicatorState, p: Palette): string {
	const parts = [state.backend, state.model].filter(Boolean);
	return parts.length > 0 ? p.dim(parts.join(" ")) : "";
}

function micLabel(state: IndicatorState, p: Palette): string {
	return state.device ? p.dim(state.device) : "";
}

/** The footer truncates to terminal width itself, so this only guards against absurd lines. */
const STATUS_WIDTH = 400;

/**
 * The single status line: the live indicator, the setup label, or both.
 * Returns undefined when there is nothing worth showing.
 */
/** Colors for drawing inside the editor's border row. */
export interface BorderPaint {
	border(text: string): string;
	measure(text: string): number;
	truncate(text: string, maxWidth: number): string;
}

/** The "↑ 4 more" or "↓ 3 more" label Pi embeds in an editor border, if any. */
export function extractScrollIndicator(line: string): string | undefined {
	return stripTerminalSequences(line).match(/[↑↓] \d+ more/)?.[0];
}

/** Index of the editor's bottom border inside its rendered lines, or -1. */
export function bottomBorderIndex(base: unknown, lines: readonly string[]): number {
	let node: unknown = base;
	while (node) {
		const count = (node as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
		if (typeof count === "number") {
			const index = 1 + count;
			if (index >= lines.length) return -1;
			const stripped = stripTerminalSequences(lines[index] ?? "").replace(/ ↓ \d+ more /, "");
			return /^─+$/.test(stripped) ? index : -1;
		}
		node = (node as { base?: unknown }).base;
	}
	return -1;
}

/**
 * Copy of the editor lines with one border row redrawn by `draw`, which gets
 * that row's scroll label. Unchanged when the bottom border cannot be found.
 */
export function overlayVoiceRow(
	lines: readonly string[],
	base: unknown,
	row: "top" | "bottom",
	draw: (overflow: string | undefined) => string,
): string[] {
	const index = row === "top" ? 0 : bottomBorderIndex(base, lines);
	if (index === -1 || index >= lines.length) return [...lines];
	return lines.map((line, i) => (i === index ? draw(extractScrollIndicator(line)) : line));
}

/**
 * The indicator drawn into an editor border row, progressively
 * dropping the meter and clock as the terminal narrows. `overflow` is the
 * scroll label extracted from the original line so no information is lost.
 */
export function renderVoiceBorder(
	state: IndicatorState,
	setup: string | undefined,
	now: number,
	width: number,
	p: Palette,
	paint: BorderPaint,
	overflow?: string,
): string {
	if (width <= 0) return "";
	const head = `${dotGlyph(state, now, p)} ${p.muted(clock((state.stoppedAt ?? now) - state.startedAt))}`;
	const label = [quietWarning(state, p), clipWarning(state, now, p), trailer(state, now, p)].filter(Boolean).join("  ");
	const row = chunkRow(state.chunks, now, p);
	const left = [
		[head, meter(livePhase(state) ? state.levels : [], p), row, label].filter(Boolean).join("  "),
		[head, row, label].filter(Boolean).join("  "),
		[head, label].filter(Boolean).join("  "),
		label,
	].filter(Boolean);
	const mic = micLabel(state, p);
	const model = modelLabel(state, p);
	const overflowLabel = overflow ? paint.border(overflow) : "";
	// Right side, most informative first; each step drops the least important piece.
	const right = [
		[mic, model, setup ? p.dim(setup) : "", overflowLabel].filter(Boolean).join(" "),
		[mic, model, overflowLabel].filter(Boolean).join(" "),
		[mic, overflowLabel].filter(Boolean).join(" "),
		overflowLabel,
		"",
	];
	const place = (leftText: string, rightText: string): string | undefined => {
		const rightWidth = rightText ? 1 + paint.measure(rightText) + RIGHT_CAP.length : 0;
		const rails = width - 3 - paint.measure(leftText) - 1 - rightWidth;
		if (rails < 1) return undefined;
		return (
			paint.border("── ") +
			leftText +
			paint.border(` ${"─".repeat(rails)}`) +
			(rightText ? `${paint.border(" ")}${rightText}${paint.border(RIGHT_CAP)}` : "")
		);
	};
	// Drop the meter, then the model, then the mic; the activity on the left goes last.
	for (const rightText of right) {
		for (const leftText of left) {
			const line = place(leftText, rightText);
			if (line) return line;
		}
	}
	const room = Math.max(1, width - 6);
	return place(paint.truncate(left[left.length - 1] ?? "", room), "") ?? paint.border("─".repeat(width));
}

export function renderStatus(state: IndicatorState | undefined, setup: string | undefined, now: number, p: Palette): string | undefined {
	const parts: string[] = [];
	if (state) parts.push(renderIndicator(state, now, STATUS_WIDTH, p).trim());
	if (setup) parts.push(p.dim(setup));
	return parts.length > 0 ? parts.join("  ") : undefined;
}

function livePhase(state: IndicatorState): boolean {
	return state.phase === "recording" || state.phase === "connecting" || state.phase === "loading";
}

function dotGlyph(state: IndicatorState, now: number, p: Palette): string {
	if (!livePhase(state)) return p.dim("○");
	if (!p.pulse) return p.error("●");
	// Starts at full red, softest halfway through each period.
	const phase = (Math.max(0, now - state.startedAt) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
	return p.pulse("●", (PULSE_DEPTH * (1 - Math.cos(2 * Math.PI * phase))) / 2);
}

export function renderIndicator(state: IndicatorState, now: number, width: number, p: Palette): string {
	const elapsed = (state.stoppedAt ?? now) - state.startedAt;
	const parts = [`${dotGlyph(state, now, p)} ${p.muted(clock(elapsed))}`, meter(livePhase(state) ? state.levels : [], p)];
	const chunks = chunkRow(state.chunks, now, p);
	if (chunks) parts.push(chunks);
	for (const warning of [quietWarning(state, p), clipWarning(state, now, p)]) if (warning) parts.push(warning);
	const tail = trailer(state, now, p) || [micLabel(state, p), modelLabel(state, p)].filter(Boolean).join(" ");
	if (tail) parts.push(tail);
	return truncateToWidth(` ${parts.join("  ")}`, Math.max(1, width));
}
