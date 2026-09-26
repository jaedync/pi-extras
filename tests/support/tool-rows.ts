/** A hand-driven stand-in for Pi's tool row, for tests of Tool Display's renderers. */
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { AnimationClock, type Timers } from "../../lib/band/clock.ts";
import type { PopupSource } from "../../lib/band/popup.ts";
import type { ChainRun } from "../../lib/chain/run.ts";
import type { Kit, RenderContext } from "../../lib/tool-display/kit.ts";
import { quiet } from "./quiet-theme.ts";

export const theme = quiet();

/** A clock driven by hand: `tick()` runs one frame. */
export function manualClock() {
	let frame: (() => void) | undefined;
	const timers: Timers = { setInterval: (fn) => { frame = fn; return 1; }, clearInterval: () => { frame = undefined; } };
	return { clock: new AnimationClock(timers), tick: () => frame?.(), running: () => frame !== undefined };
}

export function harness() {
	let now = 1_000;
	const runs = new Map<string, ChainRun>();
	const popups: PopupSource[] = [];
	const { clock, tick, running } = manualClock();
	const kit: Kit = {
		moreHint: () => "click for all",
		highlight: (code) => code.split("\n"),
		language: () => undefined,
		diff: (diff) => diff,
		fileUrl: () => undefined,
		now: () => now,
		motion: () => "full",
		chains: () => true,
		clock,
		chainRun: (id) => runs.get(id),
		openPopup: (source) => { popups.push(source); return true; },
	};
	return { kit, runs, popups, tick, running, advance: (ms: number) => { now += ms; }, now: () => now };
}

export type Renderers = {
	renderCall(args: unknown, theme: unknown, context: RenderContext): Component;
	renderResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown, context: RenderContext): Component;
};

/** Mimics Pi's tool row: the call slot, then the result slot once there is a result. */
export function row(renderers: Renderers, args: unknown, toolCallId = "call-1") {
	const state: Record<string, unknown> = {};
	let call: Component | undefined;
	let result: Component | undefined;
	let invalidations = 0;
	let last: Partial<RenderContext> & { result?: unknown } = {};
	const context = (over: Partial<RenderContext>, component: unknown): RenderContext => ({
		args, toolCallId, state, lastComponent: component, cwd: "/work", executionStarted: false, argsComplete: true,
		isPartial: true, expanded: false, isError: false, invalidate: () => { invalidations++; update(last); }, ...over,
	});
	function update(over: Partial<RenderContext> & { result?: unknown } = {}) {
		last = over;
		const { result: value, ...rest } = over;
		call = renderers.renderCall(args, theme, context(rest, call));
		if (value !== undefined) {
			result = renderers.renderResult(value, { expanded: rest.expanded ?? false, isPartial: rest.isPartial ?? true }, theme, context(rest, result));
		}
	}
	return {
		update,
		lines(width = 60) {
			return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])].map((line) => stripTerminalSequences(line).trimEnd());
		},
		raw(width = 60) {
			return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])];
		},
		click: () => (call as { handleMouse?: (event: unknown) => unknown }).handleMouse?.({ type: "click", button: "left", x: 3, y: 0 }),
		invalidations: () => invalidations,
	};
}

export const text = (value: string, details?: unknown) => ({ content: [{ type: "text", text: value }], details });
/** A band: the title from column 1, the rail ending one column before the edge. */
export const band = (title: string, rail = "", width = 60) => ` ${title}${" ".repeat(Math.max(1, width - 2 - title.length - rail.length))}${rail}`.trimEnd();

/** The foreground color escape `piece` is drawn in, the last one set before it. */
export function colorOf(raw: string, piece: string): string | undefined {
	const at = raw.indexOf(piece);
	if (at < 0) return undefined;
	return [...raw.slice(0, at).matchAll(/\x1b\[38;2;[\d;]+m/g)].at(-1)?.[0];
}
