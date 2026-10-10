/**
 * A tool row: the header band, then the row's own lines. Rows use Pi's
 * `renderShell: "self"`, so Pi draws nothing around them.
 *
 * Pi renders a row as a call slot followed by a result slot, and shares one
 * state object between them. That object holds the row's timing: when the
 * call started and ended, how it ended, and whether it was replayed from
 * history (no times then; Pi doesn't save them). While the band moves, the
 * row asks the shared animation clock for frames and redraws itself.
 */
import type { TuiMouseEvent, TuiMouseEventResult, Component } from "@earendil-works/pi-tui";
import { isAnimated, renderBand, ROW_MARGIN, timeSeg, formatTime, formatWhole, type BandPhase, type Outcome, type Seg } from "../band/band.ts";
import { flowing, noteDraft, writingRail, type Draft } from "../band/draft.ts";
import { paletteFrom } from "../band/palette.ts";
import type { Kit, RenderContext, ThemeLike } from "./kit.ts";

/** Output lines sit under the band's title, two columns in; the title starts after the row's margin. */
export const BODY_INDENT = 2 + ROW_MARGIN;

export interface RowState {
	startedAt?: number;
	endedAt?: number;
	/** Replayed from history: the result was final the first time the row was drawn. */
	resumed?: boolean;
	/** Built while the model streamed a reply, so a call still being written is being written now. */
	live?: boolean;
	/** The band's phase when the row was last drawn. */
	drawnAs?: BandPhase["kind"];
	outcome?: Outcome;
	/** A call written now: its arguments so far, for the pen, the rail and the preview. */
	draft?: Draft;
	context?: RenderContext;
	theme?: ThemeLike;
	stopFrames?: () => void;
	/** Tool-specific data the renderers keep between the call and result slots. */
	[key: string]: unknown;
}

export function rowState(context: RenderContext): RowState {
	return (context.state.row ??= {}) as RowState;
}

/** Brings the row's timing up to date with what Pi reports. */
export function track(row: RowState, context: RenderContext, now: number, outcome?: Outcome): void {
	row.context = context;
	const done = !context.isPartial;
	if (!done && context.executionStarted && row.startedAt === undefined) row.startedAt = now;
	// Only a call written now gets a draft; one rebuilt from history has no clock to show.
	if (row.live && !done && !context.executionStarted && !context.argsComplete) row.draft = noteDraft(row.draft, context.args, now);
	if (done) {
		if (row.startedAt === undefined && row.endedAt === undefined) row.resumed = true;
		if (row.endedAt === undefined && !row.resumed) row.endedAt = now;
		if (outcome) row.outcome = outcome;
		row.outcome ??= context.isError ? "fail" : "ok";
	}
}

export function phaseOf(row: RowState, context: RenderContext, now: number, timeoutMs?: number): BandPhase {
	if (context.isPartial) {
		if (context.executionStarted) {
			const elapsedMs = now - (row.startedAt ?? now);
			return timeoutMs ? { kind: "running", elapsedMs, timeoutMs } : { kind: "running", elapsedMs };
		}
		if (context.argsComplete) return { kind: "queued" };
		const draft = row.draft;
		return draft ? { kind: "writing", elapsedMs: now - draft.startedAt, chars: draft.chars, flowing: flowing(draft, now) } : { kind: "writing" };
	}
	const sinceMs = row.resumed || row.endedAt === undefined ? Number.POSITIVE_INFINITY : now - row.endedAt;
	return { kind: "done", outcome: row.outcome ?? (context.isError ? "fail" : "ok"), sinceMs };
}

export function tookMs(row: RowState, now: number): number | undefined {
	if (row.startedAt === undefined) return undefined;
	return (row.endedAt ?? now) - row.startedAt;
}

const OUTCOME_WORD: Record<Exclude<Outcome, "ok">, Seg> = {
	fail: { text: "failed", color: "error" },
	timeout: { text: "timed out", color: "warning" },
	aborted: { text: "aborted", color: "muted" },
};

/**
 * The right side of the band: the live time while running (with the timeout
 * when there is one), afterwards how the call ended and how long it took.
 */
export function rail(phase: BandPhase, took: number | undefined, options: { lead?: readonly Seg[]; failure?: readonly Seg[] } = {}): Seg[] {
	const lead = options.lead ?? [];
	const gap = (segs: readonly Seg[]) => (segs.length > 0 ? [...segs, { text: "   ", color: "dim" }] : []);
	switch (phase.kind) {
		case "writing": return phase.elapsedMs === undefined ? [] : writingRail(phase.chars ?? 0, phase.elapsedMs);
		case "queued": return [{ text: "queued", color: "dim" }];
		case "calm": case "progress": return [...lead];
		case "running": {
			const time: Seg[] = [{ text: formatTime(phase.elapsedMs), color: "text" }];
			// The timeout in the same units as the time beside it, so `20m02s / 30m00s` compare at a glance.
			if (phase.timeoutMs) time.push({ text: ` / ${formatWhole(phase.timeoutMs)}`, color: "dim" });
			return [...gap(lead), ...time];
		}
		case "done": {
			const status = phase.outcome === "ok" ? [...lead] : [...(options.failure ?? [OUTCOME_WORD[phase.outcome]])];
			if (took === undefined) return status;
			return status.length > 0 ? [...status, { text: phase.outcome === "ok" ? "   " : "  ", color: "dim" }, timeSeg(took)] : [timeSeg(took)];
		}
	}
}

/**
 * Keeps a row redrawing while its band (or `alsoMoving`, the row's own lines)
 * moves, and stops once it settles; a `margined` band also spins while written.
 */
export function animate(row: RowState, kit: Kit, phase: BandPhase, alsoMoving = false, margined = false): void {
	row.drawnAs = phase.kind;
	const moving = alsoMoving || isAnimated(phase, kit.motion(), margined);
	if (moving && !row.stopFrames) row.stopFrames = kit.clock.add(() => (outlived(row, kit) ? stopFrames(row) : row.context?.invalidate()));
	else if (!moving && row.stopFrames) stopFrames(row);
}

function stopFrames(row: RowState): void {
	row.stopFrames?.();
	row.stopFrames = undefined;
}

/**
 * A row whose frames outlived it. Only drawing a row stops its frames, and
 * Pi rebuilds the transcript on some settings changes mid-run, so a row it
 * dropped still reads as written after its message ended, or as running
 * after the run did.
 */
function outlived(row: RowState, kit: Kit): boolean {
	if (row.drawnAs === "writing") return kit.streaming?.() === false;
	if (row.drawnAs === "running") return kit.busy?.() === false;
	return false;
}

export interface BandInput {
	readonly toolName?: string;
	readonly segs: readonly Seg[];
	readonly rail: readonly Seg[];
	readonly phase: BandPhase;
}

/** A row's band; `margin` for the transcript, where the call's spinner goes before the title. */
export function band(theme: ThemeLike, kit: Kit, input: BandInput, width: number, margin: boolean | "blank" = false): string {
	return renderBand(theme, paletteFrom(theme), { width, phase: input.phase, segs: input.segs, rail: input.rail, clockMs: kit.now(), motion: kit.motion(), margin, toolName: input.toolName });
}

/**
 * A slot's component. It draws on demand, so the band's phase and time are
 * current on every frame, and caches the lines while nothing they depend on
 * changed. A click opens the row's popup when one is available.
 */
export class Slot implements Component {
	private draw: (width: number) => string[] = () => [];
	private key: () => string = () => "";
	private cache?: { width: number; key: string; lines: string[] };
	private click?: () => boolean;

	/** Pi calls the renderers again on every change and animation frame, so lines keep until then. */
	set(draw: (width: number) => string[], key: () => string = () => ""): this {
		this.draw = draw;
		this.key = key;
		this.cache = undefined;
		return this;
	}

	onClick(click: (() => boolean) | undefined): this {
		this.click = click;
		return this;
	}

	render(width: number): string[] {
		const safe = Math.max(1, width);
		const key = this.key();
		if (this.cache?.width !== safe || this.cache.key !== key) this.cache = { width: safe, key, lines: this.draw(safe) };
		return this.cache.lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || !this.click) return undefined;
		return this.click() ? { handled: true } : undefined;
	}
}

/** The slot Pi handed back last time, or a new one. */
export function slotFor(context: RenderContext): Slot {
	return context.lastComponent instanceof Slot ? context.lastComponent : new Slot();
}

export function indent(lines: readonly string[], by = BODY_INDENT): string[] {
	const pad = " ".repeat(by);
	return lines.map((line) => (line === "" ? line : pad + line));
}
