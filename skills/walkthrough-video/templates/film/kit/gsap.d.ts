/**
 * The part of GSAP (loaded as a global by the page) that a film uses. Kept
 * small and local, so a film project type-checks without node_modules.
 */
declare namespace gsap {
	type Target = string | Element | Element[] | NodeListOf<Element> | object | null;
	type Ease = string | ((progress: number) => number);
	interface Vars {
		duration?: number;
		ease?: Ease;
		delay?: number;
		stagger?: number | { each?: number; from?: string | number; amount?: number };
		immediateRender?: boolean;
		repeat?: number;
		yoyo?: boolean;
		onComplete?: () => void;
		onUpdate?: () => void;
		[property: string]: unknown;
	}
	interface Tween {
		duration(): number;
	}
	interface Timeline {
		to(target: Target, vars: Vars, position?: number | string): Timeline;
		from(target: Target, vars: Vars, position?: number | string): Timeline;
		fromTo(target: Target, from: Vars, to: Vars, position?: number | string): Timeline;
		set(target: Target, vars: Vars, position?: number | string): Timeline;
		call(fn: () => void, args?: unknown[], position?: number | string): Timeline;
		add(child: Timeline | Tween | string, position?: number | string): Timeline;
		/** A tween that plays this (paused) timeline from one time to another. */
		tweenFromTo(from: number, to: number, vars?: Vars): Tween;
		duration(): number;
		seek(time: number, suppressEvents?: boolean): Timeline;
		time(): number;
	}
}

declare const gsap: {
	timeline(vars?: { paused?: boolean; defaults?: gsap.Vars }): gsap.Timeline;
	set(target: gsap.Target, vars: gsap.Vars): void;
	getProperty(target: gsap.Target, property: string): unknown;
};

interface Window {
	__timelines?: Record<string, gsap.Timeline>;
	__film?: { ready: boolean; cues: import("./types.ts").Cue[]; duration: number };
}
