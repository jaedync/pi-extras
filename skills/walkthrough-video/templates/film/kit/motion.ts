/**
 * Small motion pieces that scenes combine. Each one places tweens on the
 * film timeline at times the scene gives; none of them picks a time itself.
 * Values are starting points from the reference films, not rules.
 */
import type { SceneContext } from "./film.ts";

/**
 * Entrances that open a shot start this long before the cut (seconds from the
 * shot start, so negative), so the first frame of the shot already moves.
 * A word under its mask for the first frames reads as a still frame at the cut.
 */
export const LEAD = -0.1;

/**
 * Places the tweens that `build` adds at shot time `seconds`. A start before
 * the film's 0 s (a LEAD on the first shot) would move every tween of the film
 * later and show the start state at frame 0. Such tweens play from part way
 * in instead: frame 0 shows them as they are at 0 s, and the film keeps its length.
 */
export function place(ctx: SceneContext, seconds: number, build: (tl: gsap.Timeline, at: number) => void): void {
	const at = ctx.at(seconds);
	if (at >= 0) return build(ctx.tl, at);
	const sub = gsap.timeline({ paused: true });
	build(sub, 0);
	ctx.tl.add(sub.tweenFromTo(-at, sub.duration(), { ease: "none", immediateRender: true }), 0);
}

/**
 * Splits an element's text into masked words for a rise. Returns the inner
 * word spans.
 */
export function splitWords(el: HTMLElement): HTMLElement[] {
	const words = (el.textContent ?? "").trim().split(/\s+/);
	el.textContent = "";
	return words.map((word, i) => {
		const mask = document.createElement("span");
		mask.className = "wm";
		const inner = document.createElement("span");
		inner.className = "wi";
		inner.textContent = word;
		mask.append(inner);
		el.append(mask);
		if (i < words.length - 1) el.append(document.createTextNode(" "));
		return inner;
	});
}

/** Words rise out of their masks, one after the other (about 0.6 s each, 0.07 s apart). */
export function riseWords(ctx: SceneContext, words: HTMLElement[], seconds: number, opts: { each?: number; dur?: number } = {}): number {
	const each = opts.each ?? 0.07;
	const dur = opts.dur ?? 0.62;
	place(ctx, seconds, (tl, at) => tl.fromTo(words, { yPercent: 118 }, { yPercent: 0, duration: dur, ease: ctx.ease.settle, stagger: each }, at));
	return seconds + dur + each * Math.max(0, words.length - 1);
}

/** A pop on the brand spring: from scale `from` to 1. */
export function pop(ctx: SceneContext, el: Element | Element[], seconds: number, opts: { from?: number; dur?: number; each?: number } = {}): void {
	place(ctx, seconds, (tl, at) => tl.fromTo(el, { scale: opts.from ?? 0, opacity: 0 }, { scale: 1, opacity: 1, duration: opts.dur ?? 0.45, ease: ctx.ease.spring, stagger: opts.each ?? 0 }, at));
}

/**
 * A slow camera drift over the whole shot (3 to 6 % is a held shot that
 * still breathes). One camera move per shot reads best. It starts at LEAD, so
 * the cut frame already moves, on ease.drift: an ease-out that keeps a floor
 * speed, so its tail never reads as a freeze. A plain ease.out stops in its
 * last 0.2 s; an in-out ease barely moves at the cut.
 */
export function drift(ctx: SceneContext, opts: { from?: gsap.Vars; to?: gsap.Vars; target?: Element; ease?: gsap.Ease } = {}): void {
	place(ctx, LEAD, (tl, at) => tl.fromTo(opts.target ?? ctx.cam, { scale: 1.0, ...opts.from }, { scale: 1.04, ...opts.to, duration: ctx.d - LEAD, ease: opts.ease ?? ctx.ease.drift, immediateRender: false }, at));
}

/** A designed camera move between two framings, 0.75 to 0.9 s reads as intent. */
export function move(ctx: SceneContext, seconds: number, to: gsap.Vars, opts: { dur?: number; target?: Element } = {}): void {
	ctx.tl.to(opts.target ?? ctx.cam, { ...to, duration: opts.dur ?? 0.8, ease: ctx.ease.inOut }, ctx.at(seconds));
}

/**
 * Types `text` into `el` with one key cue per character. `times` are the key
 * times in seconds from the shot start; a human rhythm is uneven, so give
 * them by hand or from a captured take.
 */
export function typeOn(ctx: SceneContext, el: HTMLElement, text: string, times: number[]): void {
	ctx.tl.set(el, { textContent: "" }, ctx.at(Math.max(0, (times[0] ?? 0) - 0.01)));
	[...text].forEach((_, i) => {
		const t = times[i] ?? (times[times.length - 1] ?? 0) + 0.09 * (i - times.length + 1);
		ctx.tl.set(el, { textContent: text.slice(0, i + 1) }, ctx.at(t));
		ctx.cue("key", t);
	});
}
