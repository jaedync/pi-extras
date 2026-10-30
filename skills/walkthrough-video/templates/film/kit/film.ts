/**
 * The film runtime. mountFilm reads the film data that `wv film build`
 * inlines (the storyboard, its whole-frame timing and the brand tokens),
 * gives each shot's scene module its own section and times, and registers
 * one paused GSAP timeline for HyperFrames. A scene only places things in
 * time; it never decides when its shot starts or ends.
 */
import { CSS_CURVES, bezier, driftOut, parseCurve, type EaseFn } from "./ease.ts";
import type { Cue, FilmData, Shot, ShotTiming, Tokens } from "./types.ts";

export interface SceneContext {
	/** The film's one timeline; positions are film seconds. */
	tl: gsap.Timeline;
	/** The shot as the storyboard writes it: its parameters live here. */
	shot: Shot;
	timing: ShotTiming;
	/** Shot start, end and length in film seconds (whole frames). */
	t0: number;
	t1: number;
	d: number;
	/** Seconds per beat (0 without a bpm). */
	beat: number;
	fps: number;
	width: number;
	height: number;
	/** The shot's section; shown only during the shot. */
	root: HTMLElement;
	/** A full-frame layer inside root for camera moves. */
	cam: HTMLElement;
	/** The shot's captured clip, when the storyboard gives one. */
	video: HTMLVideoElement | null;
	brand: Tokens;
	/** spring (the brand's first spring), std, out, in, inOut, settle, linear, and the storyboard's own curves. */
	ease: Record<string, EaseFn | string>;
	/** Film time of a time in seconds from the shot start. */
	at(seconds: number): number;
	/** A sound cue on a picture event, in seconds from the shot start; `peak` in dBFS. */
	cue(sound: string, seconds: number, opts?: { peak?: number }): void;
	/** Appends markup to the cam (or to `parent`) and returns its first element. */
	html(markup: string, parent?: Element): HTMLElement;
	$(selector: string): HTMLElement;
	$$(selector: string): HTMLElement[];
}

export type Scene = (ctx: SceneContext) => void;

/** Marks a function as a scene; the type does the work. */
export function scene(fn: Scene): Scene {
	return fn;
}

function readFilmData(): FilmData {
	const node = document.getElementById("film-data");
	if (!node?.textContent) throw new Error("film: no #film-data in the page; build it with wv film build");
	return JSON.parse(node.textContent) as FilmData;
}

function easesFor(data: FilmData): Record<string, EaseFn | string> {
	const ease: Record<string, EaseFn | string> = { linear: "none" };
	for (const [name, curve] of Object.entries(CSS_CURVES)) ease[name] = bezier(...curve);
	const spring = data.tokens.motion?.springs[0] ? parseCurve(data.tokens.motion.springs[0].value) : null;
	ease.drift = driftOut();
	ease.spring = bezier(...(spring ?? [0.34, 1.56, 0.64, 1]));
	for (const [name, curve] of Object.entries(data.storyboard.ease ?? {})) ease[name] = bezier(...curve);
	return ease;
}

export function mountFilm(scenes: Record<string, Scene>): gsap.Timeline {
	const data = readFilmData();
	const { storyboard, timing } = data;
	const ease = easesFor(data);
	const tl = gsap.timeline({ paused: true });
	const cues: Cue[] = [];
	const beat = storyboard.bpm ? 60 / storyboard.bpm : 0;
	const last = timing.shots[timing.shots.length - 1];
	for (const [index, shotTiming] of timing.shots.entries()) {
		const shot = storyboard.shots[index];
		const build = scenes[shot.scene];
		if (!build) throw new Error(`film: shot "${shot.id}" uses the scene "${shot.scene}", which film.ts does not register`);
		const root = document.getElementById(shot.id);
		if (!root) throw new Error(`film: no section #${shot.id} in the page; run wv film build again`);
		const cam = root.querySelector<HTMLElement>(":scope > .cam") ?? root;
		// Exact frame times: the cut is where the storyboard says, to the frame.
		const t0 = shotTiming.startFrame / timing.fps;
		const t1 = shotTiming.endFrame / timing.fps;
		// Shown while the scene builds, so it can measure its own layout.
		root.style.display = "block";
		build({
			tl,
			shot,
			timing: shotTiming,
			t0,
			t1,
			d: t1 - t0,
			beat,
			fps: timing.fps,
			width: timing.width,
			height: timing.height,
			root,
			cam,
			video: root.querySelector("video"),
			brand: data.tokens,
			ease,
			at: (seconds) => t0 + seconds,
			cue: (sound, seconds, opts = {}) => cues.push({ sound, t: Math.round((t0 + seconds) * 1e4) / 1e4, shot: shot.id, ...opts }),
			html: (markup, parent = cam) => {
				const holder = document.createElement("div");
				holder.innerHTML = markup.trim();
				const first = holder.firstElementChild as HTMLElement;
				parent.append(...holder.childNodes);
				return first;
			},
			$: (selector) => {
				const el = root.querySelector<HTMLElement>(selector);
				if (!el) throw new Error(`film: shot "${shot.id}" has no ${selector}`);
				return el;
			},
			$$: (selector) => [...root.querySelectorAll<HTMLElement>(selector)],
		});
		root.style.display = "none";
		tl.set(root, { display: "block" }, t0);
		if (shotTiming !== last) tl.set(root, { display: "none" }, t1);
	}
	// The timeline is exactly as long as the film.
	tl.set({}, {}, timing.duration);
	window.__timelines = window.__timelines ?? {};
	window.__timelines.main = tl;
	window.__film = { ready: true, cues: cues.sort((a, b) => a.t - b.t), duration: timing.duration };
	return tl;
}
