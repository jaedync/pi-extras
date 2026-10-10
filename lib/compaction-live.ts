/**
 * A compaction while it runs: a purple band at the bottom of the
 * conversation with why it runs, the size before, the tokens of the summary
 * so far and the time, and the newest lines of the summary. Pi's own
 * compaction sends no text, so its band has the time only. The final band in
 * the transcript takes its place; a cancelled one turns gray for a moment.
 */
import { formatTime, renderBand, type Motion, type Seg } from "./band/band.ts";
import { mix, parseAnsiColor } from "./band/color.ts";
import { cleanText, previewLines } from "./band/draft.ts";
import { noteText, type Trail } from "./band/glow.ts";
import { purpleBackground, purplePalette, purpleTheme } from "./band/purple.ts";
import { onBackground } from "./band/surface.ts";
import { BODY_INDENT, indent } from "./tool-display/row.ts";
import type { ThemeLike } from "./tool-display/kit.ts";
import { CHARS_PER_TOKEN } from "./cc-phase.ts";
import { formatTokens } from "./status-plus-render.ts";
import { PROGRESS_TAIL_CHARS } from "./cache-compaction/decision.ts";

export const CANCEL_SHOW_MS = 2_000;
// The sweep runs from Pi's purple toward its violet label, as the mockup's.
const SWEEP_BASE = 0.1;

export type Reason = "threshold" | "manual" | "overflow";

export interface LiveCompaction {
	readonly reason: Reason;
	readonly tokensBefore: number;
	readonly startedAt: number;
	/** The newest characters of the summary, cleaned. */
	readonly text: string;
	/** How many characters of summary came in all. */
	readonly chars: number;
	readonly trail?: Trail;
	readonly cancelledAt?: number;
}

export const startLive = (reason: Reason, tokensBefore: number, at: number): LiveCompaction => ({ reason, tokensBefore, startedAt: at, text: "", chars: 0 });

export function noteProgress(live: LiveCompaction, text: string, chars: number, at: number): LiveCompaction {
	if (live.cancelledAt !== undefined || chars <= live.chars) return live;
	return { ...live, text: cleanText(text.slice(-PROGRESS_TAIL_CHARS)), chars, trail: noteText(live.trail, "summary", chars, at) };
}

export const cancelLive = (live: LiveCompaction, at: number): LiveCompaction => ({ ...live, cancelledAt: at });
/** A running band shows until it ends; a cancelled one for a moment. */
export const liveShown = (live: LiveCompaction, now: number): boolean => live.cancelledAt === undefined || now - live.cancelledAt < CANCEL_SHOW_MS;

const gap: Seg = { text: "   ", color: "dim" };
const REASON_WORD: Record<Reason, string> = { threshold: "auto", manual: "manual", overflow: "overflow" };

function rail(live: LiveCompaction, now: number): Seg[] {
	if (live.cancelledAt !== undefined) return [{ text: "cancelled", color: "muted" }, gap, { text: formatTime(live.cancelledAt - live.startedAt), color: "muted" }];
	const tokens: Seg[] = live.chars > 0 ? [gap, { text: `↓ ${Math.round(live.chars / CHARS_PER_TOKEN).toLocaleString("en-US")} tokens`, color: "muted" }] : [];
	return [{ text: formatTokens(live.tokensBefore), color: "muted" }, ...tokens, gap, { text: formatTime(Math.max(1, now - live.startedAt)), color: "text" }];
}

/** The purple palette with a running sweep from Pi's purple toward its label. */
function sweepPalette(theme: ThemeLike) {
	const palette = purplePalette(theme);
	try {
		const bg = parseAnsiColor(theme.getBgAnsi("customMessageBg"));
		const hue = parseAnsiColor(theme.getFgAnsi("customMessageLabel"));
		return palette && bg && hue ? { ...palette, base: mix(bg, hue, SWEEP_BASE), accent: hue } : palette;
	} catch { return palette; }
}

export function liveCompactionLines(live: LiveCompaction, width: number, theme: ThemeLike, now: number, motion: Motion): string[] {
	const segs: Seg[] = [{ text: "compaction", color: "customMessageLabel", bold: true }, { text: ` ${REASON_WORD[live.reason]}`, color: "muted" }];
	const phase = live.cancelledAt !== undefined
		? { kind: "done" as const, outcome: "aborted" as const, sinceMs: Number.POSITIVE_INFINITY }
		: { kind: "running" as const, elapsedMs: now - live.startedAt };
	const band = renderBand(purpleTheme(theme), sweepPalette(theme), { width, phase, segs, rail: rail(live, now), clockMs: now, motion, margin: true });
	if (live.cancelledAt !== undefined) return [band];
	const preview = previewLines({ text: live.text, length: live.chars, trail: live.trail }, width - BODY_INDENT, now, theme, motion, "toolOutput");
	return [band, ...onBackground(indent(preview), width, purpleBackground(theme))];
}
