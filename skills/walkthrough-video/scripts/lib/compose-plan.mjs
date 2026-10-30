// Turns a capture (events.json) and a short shot list (shots.json) into plan.json: the edit, the
// camera, the cursor, captions and voice, all on the output clock. Pure: no I/O.
//
// The numbers below are the house motion spec for walkthroughs. They are here, not in prompts, so
// every video gets the same camera and the same pacing without the agent choosing them again.
export const SPEC = Object.freeze({
	fps: 60,
	output: { width: 1920, height: 1080 },
	leadS: 0.35, // the camera and cursor arrive this long before an action starts
	cursorTravelS: 0.45,
	clickPressS: 0.08,
	cameraMoveS: 0.7,
	gapKeepS: 0.5, // idle gaps up to this long play at 1x
	gapOutS: 0.4, // longer idle gaps are sped up to last this long
	maxGapSpeed: 12,
	minShotS: 0.8, // a shot keeps at least this much picture, even if every frame repeats
	readBaseS: 0.5, // a caption stays at least 0.5 s + 0.3 s a word
	readPerWordS: 0.3,
	minTextFrac: 0.026, // text meant to be read: 2.6 % of the short side (28 px at 1080)
	safeFrac: 0.8, // title-safe area
	focusPad: 0.3, // margin around a focus box, as a fraction of its size
	minFocusPadPx: 24,
	maxVoiceHoldS: 1.0,
	emphasisZoom: 1.25, // a focused control is shown at least this much larger than the overview
	churnGapS: 1.5, // two focus windows closer than this get one straight move, not an out and back
	payoffS: 2.0, // the last result stays on screen at least this long
	introS: 2.2,
	outroS: 2.4,
});

import { stillRuns } from "./stills.mjs";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** The caption of a shot: a string, or { text, place } to fix where it sits. */
export function captionOf(shot) {
	const caption = shot?.caption;
	if (!caption) return null;
	if (typeof caption === "string") return { text: caption, place: null };
	return { text: caption.text ?? "", place: caption.place ?? null };
}

export const words = (text) => (text ?? "").trim().split(/\s+/).filter(Boolean).length;
export const readSeconds = (text) => (text ? SPEC.readBaseS + SPEC.readPerWordS * words(text) : 0);

/** Fit scale from source CSS px to output px at zoom 1. */
export const baseScale = (source, output) => output.width / source.width;

/** The largest zoom that shows source pixels at 1:1 or better. */
export const maxZoom = (source, output) => (source.scale * source.width) / output.width;

/** The readable floor in output pixels (28.1 px at 1080). */
export const textFloorPx = (output) => SPEC.minTextFrac * Math.min(output.width, output.height);

/**
 * The margin that counts as rounding, not a defect. Compose (its warnings) and
 * the gates (text_readable) both use it, so a video never renders a fix line
 * that compose said was fine.
 */
export const TEXT_FLOOR_MARGIN_PX = 0.2;

/** The size that text of fontPx reaches on screen at a camera zoom, in output px. */
export const textPxAt = (fontPx, zoom, source, output) => fontPx * zoom * baseScale(source, output);

/** True when the text reaches the readable floor, with the shared margin. */
export const textReadsAt = (fontPx, zoom, source, output) => !fontPx || textPxAt(fontPx, zoom, source, output) >= textFloorPx(output) - TEXT_FLOOR_MARGIN_PX;

/** The zoom at which text of fontPx reaches the readable floor. */
export function readZoom(fontPx, source, output) {
	if (!fontPx) return 1;
	const floor = SPEC.minTextFrac * Math.min(output.width, output.height);
	return floor / (fontPx * baseScale(source, output));
}

/** The largest zoom at which a padded box still fits inside the title-safe area. */
export function fitZoom(box, source, output) {
	const pad = (v) => v * (1 + 2 * SPEC.focusPad) + 2 * SPEC.minFocusPadPx;
	const s = baseScale(source, output);
	const zw = (SPEC.safeFrac * output.width) / (pad(box.width) * s);
	const zh = (SPEC.safeFrac * output.height) / (pad(box.height) * s);
	return Math.min(zw, zh);
}

/** The widest focus box (of any height) that still fits the title-safe area at a zoom: fitZoom, inverted. */
export function widestBoxWidth(zoom, source, output) {
	const s = baseScale(source, output);
	const padded = (SPEC.safeFrac * output.width) / (zoom * s);
	return Math.max(0, Math.floor((padded - 2 * SPEC.minFocusPadPx) / (1 + 2 * SPEC.focusPad)));
}

/** Centre the view on a box, then clamp so the view never leaves the viewport. */
export function centreFor(box, zoom, source) {
	const halfW = source.width / zoom / 2, halfH = source.height / zoom / 2;
	return {
		cx: clamp(box.x + box.width / 2, halfW, source.width - halfW),
		cy: clamp(box.y + box.height / 2, halfH, source.height - halfH),
	};
}

const union = (a, b) => {
	if (!a) return b;
	if (!b) return a;
	const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
	return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const area = (b) => (b ? b.width * b.height : 0);

/**
 * Which box the viewer must read for an event, and how far to zoom.
 * A wide input that does not fit at reading size is framed on the caret and the text before it.
 */
export function focusFor(ev, source, output, mode = "auto") {
	const zMax = maxZoom(source, output);
	const zRead = Math.max(1, readZoom(ev.fontPx, source, output));
	// A wait, a key press or a mark with no element keeps the camera where it is, in every mode
	// but "overview": a shot's focus mode is about its controls, not its pauses. When the screen
	// changed while it waited, the camera pulls back to show that.
	const bigChange = ev.changed && area(ev.changed) >= 0.35 * source.width * source.height;
	if (mode !== "overview" && !ev.target && !bigChange && ["wait", "mark", "key"].includes(ev.kind)) return { box: null, kind: "stay", zoom: null, zRead, zMax };
	if (mode === "overview" || ev.kind === "goto" || ev.kind === "scroll" || !ev.target) {
		return { box: null, kind: "overview", zoom: 1, zRead, zMax };
	}
	let box = ev.target, kind = "target";
	if (ev.kind === "type" && ev.caret && fitZoom(box, source, output) < zRead) {
		const left = Math.max(ev.target.x, ev.caret.x - 0.45 * source.width / zRead);
		box = { x: left, y: ev.target.y, width: ev.caret.x + ev.caret.width - left, height: ev.target.height };
		kind = "caret";
	} else if (ev.kind === "click" && ev.changed && area(ev.changed) < 0.35 * source.width * source.height) {
		// Show what the click changed only when it still reads at that framing; else the control.
		const both = union(ev.target, ev.changed);
		if (fitZoom(both, source, output) >= Math.min(zRead, zMax)) box = both, kind = "changed";
	}
	if (mode !== "auto" && mode !== kind && ev[mode]) box = ev[mode === "caret" ? "caret" : mode], kind = mode;
	const zoom = clamp(Math.min(Math.max(zRead, SPEC.emphasisZoom), fitZoom(box, source, output), zMax), 1, zMax);
	return { box, kind, zoom, zRead, zMax };
}

/** Frame range a shot needs: from its first action (less the lead) to its last settle. */
export function shotRange(shot, byId, fps) {
	const evs = shot.events.map((id) => {
		const ev = byId.get(id);
		if (!ev) throw new Error(`shots.json: unknown event "${id}". Use an id from events.json.`);
		return ev;
	});
	const from = Math.min(...evs.map((e) => e.startFrame)) - Math.round(SPEC.leadS * fps);
	const to = Math.max(...evs.map((e) => e.settleFrame ?? e.endFrame));
	return { evs, from, to };
}

/**
 * The last frame of an event that must keep its time: the part the flow asked
 * for (a wait of 300 ms stays 300 ms) or the animation after the action. The
 * frames a busy host added to a wait beyond its planned time are not story.
 */
export function busyEnd(event, fps) {
	const settle = event.settleFrame ?? event.endFrame;
	if (typeof event.plannedMs !== "number") return settle;
	return Math.min(settle, event.startFrame + Math.round((event.plannedMs / 1000) * fps));
}

/** [from, to] minus the ranges in `busy`, as inclusive pieces. */
function subtractRanges(from, to, busy) {
	let pieces = [[from, to]];
	for (const [a, b] of busy) {
		pieces = pieces.flatMap(([x, y]) => {
			if (b < x || a > y) return [[x, y]];
			return [[x, a - 1], [b + 1, y]].filter(([p, q]) => q >= p);
		});
	}
	return pieces;
}

/**
 * Splits a shot's picture into clips so that long runs of repeated frames between
 * the actions are time-remapped out, the way the gaps between shots already are.
 * A busy host writes the same image for many slots; the story is not in them.
 *
 * A run is left alone when it is short (SPEC.gapKeepS), when it touches an event
 * (an action, a mark or a planned wait: `busy`), or when the caption and the
 * voice line already need that time (`budgetS` is the seconds compression may
 * remove). Returns [{from, to, speed}] in capture frame order, half-open ranges,
 * so clip [] arithmetic stays (to - from) / fps / speed.
 */
export function splitStills({ from, to, speed = 1, stills = [], busy = [], budgetS = 0, fps = 60 }) {
	const base = speed > 0 ? speed : 1;
	const candidates = [];
	for (const [a, b] of stills) {
		const start = Math.max(from, a), end = Math.min(to, b);
		if (end < start) continue;
		for (const [pieceFrom, pieceTo] of subtractRanges(start, end, busy)) {
			const seconds = (pieceTo - pieceFrom + 1) / fps / base;
			if (seconds < SPEC.gapKeepS) continue;
			const idle = Math.min(SPEC.maxGapSpeed, seconds / SPEC.gapOutS);
			if (idle <= 1.05) continue;
			candidates.push({ from: pieceFrom, to: pieceTo + 1, idle });
		}
	}
	const segments = [];
	let at = from;
	let left = Math.max(0, budgetS);
	for (const cut of candidates.sort((a, b) => a.from - b.from)) {
		if (cut.from < at) continue;
		if (cut.from > at) segments.push({ from: at, to: cut.from, speed: base });
		const seconds = (cut.to - cut.from) / fps / base;
		const saved = seconds - seconds / cut.idle;
		// Spend what the caption and the voice line do not need; a run that would take the last
		// tenth of a second plays at the speed the budget still allows.
		const idle = Math.min(SPEC.maxGapSpeed, saved > left ? seconds / Math.max(seconds - left, 1e-6) : cut.idle);
		if (idle > 1.05 && seconds > 0) {
			segments.push({ from: cut.from, to: cut.to, speed: round(base * idle, 4) });
			left = Math.max(0, left - (seconds - seconds / idle));
		} else {
			segments.push({ from: cut.from, to: cut.to, speed: base });
		}
		at = cut.to;
	}
	if (at < to) segments.push({ from: at, to, speed: base });
	return segments.filter((segment) => segment.to > segment.from);
}

/**
 * Lays the shots on the output clock. Shots play at their own speed (default 1). Gaps between
 * shots are idle time: short gaps play at 1x, long ones are sped up to SPEC.gapOutS. Inside a
 * shot, the same rule applies to the runs of frames the host repeated (splitStills): the camera,
 * the cursor, the captions and the voice read the same clips, so they follow the remap.
 * A shot is held when its caption or voice needs more time than its picture gives.
 */
export function layoutClips(shots, byId, capture, voiceById, startAt) {
	const fps = capture.fps;
	const clips = [], spans = [];
	let at = startAt, cursorFrame = firstPaintFrame(capture);
	shots.forEach((shot, i) => {
		const r = shotRange(shot, byId, fps);
		const from = clamp(r.from, cursorFrame, capture.frames - 1);
		if (from > cursorFrame) {
			const gapS = (from - cursorFrame) / fps;
			const speed = gapS <= SPEC.gapKeepS ? 1 : Math.min(SPEC.maxGapSpeed, gapS / SPEC.gapOutS);
			clips.push({ from: cursorFrame, to: from, at: round(at), speed: round(speed, 4) });
			at += gapS / speed;
		}
		const to = clamp(Math.max(r.to, from + 1), from + 1, capture.frames);
		const speed = shot.speed ?? 1;
		// "trim": { start, end } keeps only the seconds of the shot's picture between them. It drops a
		// blank launch frame or a slow tail without touching the flow.
		const trimmed = clampTrim(shot.trim, from, to, fps, speed);
		const keepFrom = trimmed.from, keepTo = trimmed.to;
		const rawPictureS = (keepTo - keepFrom) / fps / speed;
		const voice = shot.voice ? voiceById.get(shot.voice) : null;
		if (shot.voice && !voice) throw new Error(`shots.json: shot ${i + 1} names voice "${shot.voice}", which voice.json does not have.`);
		// 0.2 s before the voice line and 0.25 s of air after it.
		const needS = Math.max(readSeconds(captionOf(shot)?.text), voice ? voice.seconds + 0.45 : 0);
		// Repeated frames between the actions are host lag: compress them, but never below what the
		// caption and the voice line need, and never below a minimum of picture.
		const segments = splitStills({
			from: keepFrom,
			to: keepTo,
			speed,
			stills: stillRuns(capture),
			busy: r.evs.map((e) => [e.startFrame, busyEnd(e, fps)]),
			budgetS: rawPictureS - Math.max(needS, SPEC.minShotS),
			fps,
		});
		// Each segment on the output clock. Compression moves everything after it, so the camera, the
		// cursor, the captions and the payoff hold all read these numbers, not the raw capture ones.
		let segmentAt = at;
		const placed = segments.map((segment) => {
			const item = { ...segment, at: segmentAt };
			segmentAt += (segment.to - segment.from) / fps / segment.speed;
			return item;
		});
		const pictureS = segmentAt - at;
		const outAt = (frame) => {
			for (const item of placed) if (frame >= item.from && frame <= item.to) return item.at + (Math.min(frame, item.to) - item.from) / fps / item.speed;
			return segmentAt;
		};
		let hold = Math.max(0, needS - pictureS);
		if (i === shots.length - 1) {
			const lastSettle = Math.max(...r.evs.map((e) => e.settleFrame ?? e.endFrame));
			const tail = segmentAt - outAt(Math.min(lastSettle, keepTo));
			hold = Math.max(hold, SPEC.payoffS - tail);
		}
		// Events the trim cuts away are not in the video: the camera and the cursor must not wait for them.
		const keepFrames = (e) => (e.settleFrame ?? e.endFrame) >= keepFrom && e.startFrame <= keepTo;
		const evs = r.evs.filter(keepFrames);
		const dropped = r.evs.filter((e) => !keepFrames(e));
		for (const item of placed) clips.push({ from: item.from, to: item.to, at: round(item.at), speed: item.speed });
		if (hold > 0) clips.at(-1).hold = round(hold);
		spans.push({ shot, index: i, evs, dropped, from: keepFrom, to: keepTo, start: at, end: at + pictureS + hold, speed, voice, hold });
		at += pictureS + hold;
		cursorFrame = to;
	});
	return { clips, spans, end: at };
}

/** The frame range a shot's trim keeps, or the whole shot when it has no trim. */
export function clampTrim(trim, from, to, fps, speed = 1) {
	if (!trim) return { from, to };
	const start = typeof trim.start === "number" ? trim.start : 0;
	const end = typeof trim.end === "number" ? trim.end : (to - from) / fps / speed;
	const keepFrom = Math.min(to - 1, Math.max(from, from + Math.round(start * fps * speed)));
	const keepTo = Math.min(to, Math.max(keepFrom + 1, from + Math.round(end * fps * speed)));
	return { from: keepFrom, to: keepTo };
}

/** The capture starts on a blank page; the edit starts once the first navigation has painted. */
export function firstPaintFrame(capture) {
	const nav = capture.events.find((e) => e.kind === "goto");
	if (!nav) return 0;
	return Math.min(capture.frames - 1, nav.settleFrame ?? nav.endFrame);
}

/** Output time of capture frame f, or null when no clip shows it. */
export function outTime(clips, f, fps) {
	for (const c of clips) if (f >= c.from && f <= c.to) return c.at + (Math.min(f, c.to) - c.from) / fps / c.speed;
	return null;
}

/**
 * The output time of a capture frame, or `fallback` when the frame is outside
 * every kept clip (a trim cut it). `null - x` is a negative time, so a caller
 * that cannot take null must use this.
 */
export function outTimeOr(clips, f, fps, fallback) {
	const t = outTime(clips, f, fps);
	return t === null ? fallback : t;
}
