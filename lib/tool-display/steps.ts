/**
 * The step lines under a chained bash row: a numbered cell colored by the
 * step's status, the step's command, and its own time on the right. A leading
 * `cd` is the row's location, not a step, unless it is what failed.
 *
 * The running step's whole line breathes toward the accent, and a step that
 * ends flashes toward its outcome's hue and fades back, so steps finishing
 * in quick succession read as a wave down the list.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatTime, paintLine, timeSeg, type Motion, type Seg } from "../band/band.ts";
import { mix, parseAnsiColor, type Rgb } from "../band/color.ts";
import { paletteFrom, type Palette } from "../band/palette.ts";
import type { ChainRun, StepState } from "../chain/run.ts";
import type { Chain } from "../chain/split.ts";
import type { ThemeLike } from "./kit.ts";

/** A step with no record: a resumed session from before steps were saved. */
export type ShownState = StepState | "unknown";

const CHIP: Record<Exclude<ShownState, "running">, [keyof Palette, number]> = {
	ok: ["success", 0.3],
	fail: ["error", 0.38],
	timeout: ["warning", 0.35],
	aborted: ["muted", 0.22],
	handled: ["muted", 0.22],
	waiting: ["muted", 0.1],
	skipped: ["muted", 0.05],
	unknown: ["muted", 0.14],
};

export function stateOf(run: ChainRun | undefined, index: number): ShownState {
	return run ? run.stateOf(index) : "unknown";
}

/** The steps shown, by index into the chain. */
export function shownSteps(chain: Chain, run: ChainRun | undefined): number[] {
	return chain.steps.flatMap((step, index) => {
		if (!step.cd) return [index];
		const state = stateOf(run, index);
		return state === "fail" || state === "timeout" || state === "aborted" ? [index] : [];
	});
}

/** A single-line form of a step, for the band and step lines. */
export function flat(text: string): string {
	return text.replace(/\s*\\\n\s*/g, " ").replace(/\s*\n\s*/g, " ");
}

/** The whole chain on one line, operators kept. */
export function chainTitle(chain: Chain): string {
	return chain.steps.map((step, index) => (index === 0 ? flat(step.text) : step.op === ";" ? `; ${flat(step.text)}` : ` ${step.op} ${flat(step.text)}`)).join("");
}

/** One breath of the running step: slow enough to read as calm, not as a warning. */
export const BREATH_MS = 1_600;
/** How far the running step's line leans toward the accent, at rest and at the top of a breath. */
const BREATH_LINE = { low: 0.03, high: 0.1, reduced: 0.05 } as const;
/** How long a finished step's flash takes to rise and fade back to the body. */
export const STEP_FLASH_MS = 1_100;
const FLASH_RISE_MS = 120;
/** How far a finished step's line leans toward its outcome's hue at the flash's peak. */
const FLASH_PEAK = 0.24;

const FLASH_HUE: Partial<Record<ShownState, keyof Palette>> = { ok: "success", fail: "error", timeout: "warning", aborted: "muted", handled: "muted" };

/** 0 at the start of a breath, 1 at its top. */
export function breath(sinceMs: number): number {
	return 0.5 - 0.5 * Math.cos((2 * Math.PI * Math.max(0, sinceMs)) / BREATH_MS);
}

/** The flash's strength `sinceMs` after a step ended: a quick rise, then an eased fade to nothing. */
export function stepFlash(sinceMs: number): number {
	if (!(sinceMs >= 0) || sinceMs >= STEP_FLASH_MS) return 0;
	if (sinceMs < FLASH_RISE_MS) return sinceMs / FLASH_RISE_MS;
	return (1 - (sinceMs - FLASH_RISE_MS) / (STEP_FLASH_MS - FLASH_RISE_MS)) ** 2;
}

/** When a step stopped: its end mark, or the chain's end for the step a timeout or abort cut off. */
function stepEnd(run: ChainRun, index: number): number | undefined {
	const step = run.steps[index];
	if (step?.startedAt === undefined) return undefined;
	return step.endedAt ?? run.endedAt;
}

/** Whether any step of a live run is still flashing, so the row needs frames after the call has ended. */
export function flashing(run: ChainRun | undefined, now: number): boolean {
	if (!run?.live) return false;
	return run.steps.some((_, index) => {
		const end = stepEnd(run, index);
		return end !== undefined && stepFlash(now - end) > 0;
	});
}

function chipColor(palette: Palette, state: ShownState, breathing: number): Rgb {
	if (state === "running") return mix(palette.base, palette.accent, 0.18 + 0.14 * breathing);
	const [hue, amount] = CHIP[state];
	return mix(palette.base, palette[hue] as Rgb, amount);
}

/** The step line's own background past its number cell; undefined leaves the row's body gray. A saved run never animates. */
function lineColor(palette: Palette, run: ChainRun | undefined, index: number, state: ShownState, now: number, motion: Motion): Rgb | undefined {
	if (!run?.live) return undefined;
	if (state === "running") {
		if (motion === "reduced") return mix(palette.base, palette.accent, BREATH_LINE.reduced);
		const started = run.steps[index]?.startedAt ?? now;
		return mix(palette.base, palette.accent, BREATH_LINE.low + (BREATH_LINE.high - BREATH_LINE.low) * breath(now - started));
	}
	const hue = FLASH_HUE[state];
	const end = stepEnd(run, index);
	if (!hue || motion === "reduced" || end === undefined) return undefined;
	const strength = stepFlash(now - end);
	return strength > 0 ? mix(palette.base, palette[hue] as Rgb, FLASH_PEAK * strength) : undefined;
}

function stepRail(run: ChainRun | undefined, index: number, state: ShownState, now: number): Seg[] {
	const ms = run?.stepMs(index, now);
	const time = ms === undefined ? [] : [timeSeg(ms)];
	const code = run?.steps[index]?.code;
	switch (state) {
		case "running": return ms === undefined ? [] : [{ text: formatTime(ms), color: "text" }];
		case "ok": return time;
		case "fail": return [{ text: code === undefined ? "failed" : `exit ${code}`, color: "error" }, { text: "  ", color: "dim" }, ...time];
		case "handled": return [{ text: `exit ${code ?? 1}`, color: "muted" }, { text: "  ", color: "dim" }, ...time];
		case "timeout": return [{ text: "timed out", color: "warning" }, { text: "  ", color: "dim" }, ...time];
		case "aborted": return [{ text: "aborted", color: "muted" }, { text: "  ", color: "dim" }, ...time];
		case "skipped": return [{ text: "skipped", color: "dim" }];
		default: return [];
	}
}

/** Numbered cells shared by shell steps and observed JavaScript tool calls. */
export function numberedLine(theme: ThemeLike, label: string, title: readonly Seg[], rail: readonly Seg[], state: ShownState, width: number, options: StepLineOptions): string {
	const palette = paletteFrom(theme);
	const start = options.indent;
	const end = start + visibleWidth(label);
	const chip = palette ? chipColor(palette, state, 0.5) : undefined;
	return paintLine(theme, palette, {
		width, indent: start,
		left: [{ text: label, color: "accent", bold: true }, { text: " ", color: "text" }, ...title], rail,
		bgAt: (x) => x >= start && x < end ? chip : undefined,
	});
}

export interface StepLineOptions {
	readonly indent: number;
	readonly now: number;
	readonly selected?: boolean;
	/** Reduced motion keeps the running step's tint steady and drops the finish flash. */
	readonly motion?: Motion;
}

export function stepLine(theme: ThemeLike, chain: Chain, run: ChainRun | undefined, index: number, number: number, width: number, options: StepLineOptions): string {
	const palette = paletteFrom(theme);
	const state = stateOf(run, index);
	const label = ` ${number} `;
	const quiet = state === "skipped" || state === "waiting";
	const left: Seg[] = [
		{ text: label, color: quiet ? "dim" : "text", bold: options.selected === true },
		{ text: " ", color: "text" },
		{ text: flat(chain.steps[index]!.text), color: quiet ? "dim" : "text", bold: options.selected === true },
	];
	const chipStart = options.indent;
	const chipEnd = chipStart + label.length;
	let selectedBg: Rgb | undefined;
	if (options.selected && palette) {
		try { selectedBg = parseAnsiColor(theme.getBgAnsi("selectedBg")); } catch { /* none */ }
		selectedBg ??= mix(palette.base, palette.muted, 0.12);
	}
	const motion = options.motion ?? "full";
	const started = run?.steps[index]?.startedAt;
	const breathing = state === "running" && motion === "full" && started !== undefined ? breath(options.now - started) : 0.5;
	const chip = palette ? chipColor(palette, state, breathing) : undefined;
	const line = selectedBg ?? (palette ? lineColor(palette, run, index, state, options.now, motion) : undefined);
	return paintLine(theme, palette, {
		width,
		left,
		indent: options.indent,
		rail: stepRail(run, index, state, options.now),
		bgAt: (x) => (x >= chipStart && x < chipEnd ? chip : x >= chipEnd && line ? line : undefined),
	});
}
