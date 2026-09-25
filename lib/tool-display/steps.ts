/**
 * The step lines under a chained bash row: a numbered cell colored by the
 * step's status, the step's command, and its own time on the right. A leading
 * `cd` is the row's location, not a step, unless it is what failed.
 */
import { formatTime, paintLine, timeSeg, type Seg } from "../band/band.ts";
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

function chipColor(palette: Palette, state: ShownState, clockMs: number): Rgb {
	if (state === "running") return mix(palette.base, palette.accent, 0.18 + 0.14 * (0.5 + 0.5 * Math.sin((2 * Math.PI * clockMs) / 1_200)));
	const [hue, amount] = CHIP[state];
	return mix(palette.base, palette[hue] as Rgb, amount);
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

export interface StepLineOptions {
	readonly indent: number;
	readonly now: number;
	readonly selected?: boolean;
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
	const chip = palette ? chipColor(palette, state, options.now) : undefined;
	return paintLine(theme, palette, {
		width,
		left,
		indent: options.indent,
		rail: stepRail(run, index, state, options.now),
		bgAt: (x) => (x >= chipStart && x < chipEnd ? chip : x >= chipEnd && selectedBg ? selectedBg : undefined),
	});
}
