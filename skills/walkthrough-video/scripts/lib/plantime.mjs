/**
 * The two clocks. Capture time is `frame / fps`; output time is the seconds in
 * the final video. plan.json maps capture frame ranges (clips) to output
 * ranges, with an optional `hold` on the last frame of a clip.
 *
 * Approximation used by the gates: the camera gate reads the last keyframe at or
 * before t and does not ease between keyframes, as compose.mjs does with power3.
 * It is therefore slightly conservative, never optimistic.
 */

const num = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function clipSpeed(clip) {
	const speed = num(clip.speed, 1);
	return speed > 0 ? speed : 1;
}

/** Seconds a clip spends on its frames, before the hold. */
export function clipDuration(clip, fps) {
	return (clip.to - clip.from) / fps / clipSpeed(clip);
}

export function clipOutputStart(clip) {
	return num(clip.at);
}

/** The output time at which a clip, including its hold, has passed. */
export function clipOutputEnd(clip, fps) {
	return clipOutputStart(clip) + clipDuration(clip, fps) + Math.max(0, num(clip.hold));
}

/** Output seconds of a capture frame inside a clip, or null when the plan drops it. */
export function outputTimeForFrame(plan, frame) {
	for (const clip of plan.clips ?? []) {
		if (frame >= clip.from && frame <= clip.to) return clipOutputStart(clip) + (frame - clip.from) / plan.fps / clipSpeed(clip);
	}
	return null;
}

/** The capture frame shown at an output time, or null outside every clip. */
export function frameForOutputTime(plan, time) {
	for (const clip of plan.clips ?? []) {
		const start = clipOutputStart(clip);
		const duration = clipDuration(clip, plan.fps);
		if (time < start || time > clipOutputEnd(clip, plan.fps)) continue;
		if (time >= start + duration) return clip.to;
		const frame = clip.from + Math.floor((time - start) * plan.fps * clipSpeed(clip));
		return Math.min(clip.to, Math.max(clip.from, frame));
	}
	return null;
}

/** The clip that shows an output time, or null (a jump cut or outside the video). */
export function clipAtOutputTime(plan, time) {
	for (const clip of plan.clips ?? []) {
		if (time >= clipOutputStart(clip) && time <= clipOutputEnd(clip, plan.fps)) return clip;
	}
	return null;
}

/** True when the plan keeps this capture frame anywhere. */
export function isKeptFrame(plan, frame) {
	return outputTimeForFrame(plan, frame) !== null;
}

/** The longest camera move, in output seconds: compose-html.mjs tweens over this at most. */
export const CAMERA_MOVE_S = 0.7;

/** GSAP's power3.inOut: the ease the composition uses for every camera move. */
const power3InOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

/**
 * The camera at an output time. A key is held until the composition starts its
 * move (CAMERA_MOVE_S before the next key), then the values ease from the
 * previous key to the next one, exactly as index.html tweens them, so a gate
 * reads the same frame the viewer sees.
 */
export function cameraAt(plan, time) {
	const frames = [...(plan.camera ?? [])].sort((a, b) => a.t - b.t);
	const first = frames[0];
	const fallback = { t: 0, cx: plan.source.width / 2, cy: plan.source.height / 2, zoom: 1 };
	if (!first) return fallback;
	let index = -1;
	for (let i = 0; i < frames.length; i++) if (frames[i].t <= time) index = i;
	const chosen = index < 0 ? first : frames[index];
	const value = (keyframe) => ({
		cx: num(keyframe.cx, fallback.cx),
		cy: num(keyframe.cy, fallback.cy),
		zoom: num(keyframe.zoom, 1) || 1,
	});
	const held = value(chosen);
	const next = index + 1 < frames.length ? frames[index + 1] : null;
	if (!next) return { t: chosen.t, ...held };
	const duration = Math.min(CAMERA_MOVE_S, next.t - chosen.t);
	const start = next.t - duration;
	if (duration <= 0 || time <= start || time >= next.t) return { t: chosen.t, ...held };
	const to = value(next);
	const k = (next.ease ?? "power3.inOut") === "none" ? (time - start) / duration : power3InOut((time - start) / duration);
	return { t: next.t, cx: held.cx + (to.cx - held.cx) * k, cy: held.cy + (to.cy - held.cy) * k, zoom: held.zoom + (to.zoom - held.zoom) * k };
}

/** Linear interpolation between cursor keyframes; clamped at both ends. */
export function cursorAt(plan, time) {
	const points = [...(plan.cursor ?? [])].sort((a, b) => a.t - b.t);
	if (points.length === 0) return null;
	if (time <= points[0].t) return { x: points[0].x, y: points[0].y };
	for (let i = 1; i < points.length; i++) {
		const next = points[i];
		if (time > next.t) continue;
		const prev = points[i - 1];
		const span = next.t - prev.t;
		const k = span > 0 ? (time - prev.t) / span : 1;
		return { x: prev.x + (next.x - prev.x) * k, y: prev.y + (next.y - prev.y) * k };
	}
	const last = points[points.length - 1];
	return { x: last.x, y: last.y };
}

/** Output pixels per source CSS pixel at this camera. */
export function outputPixelsPerCss(plan, camera) {
	return (plan.output.width * camera.zoom) / plan.source.width;
}

/** Source CSS pixels visible across the frame at this zoom. */
export function visibleSourceWidth(plan, zoom) {
	return plan.source.width / zoom;
}

/** Gate 3: source device pixels per output pixel. Below 1 means an upscale. */
export function devicePixelsPerOutputPixel(plan, camera) {
	return (plan.source.scale * plan.source.width) / (camera.zoom * plan.output.width);
}

/** Maps a box in source CSS pixels to output pixels for the given camera. */
export function cameraTransform(plan, camera, box) {
	const zoom = camera.zoom || 1;
	const kx = (plan.output.width * zoom) / plan.source.width;
	const ky = (plan.output.height * zoom) / plan.source.height;
	return {
		x: (box.x - camera.cx) * kx + plan.output.width / 2,
		y: (box.y - camera.cy) * ky + plan.output.height / 2,
		width: box.width * kx,
		height: box.height * ky,
	};
}

/** Caption geometry at 1080 (compose-html.mjs draws it); other outputs scale with the height. */
// 56 px text: about 13 px on a 360 px phone screen.
export const CAPTION_BOX = Object.freeze({ inset: 96, edge: 84, height: 116, maxWidth: 1400, padX: 76, charPx: 30 });

/** The output-space box of a caption at its place ("bottom" by default, or "top"). */
export function captionBox(plan, caption) {
	const k = plan.output.height / 1080, b = CAPTION_BOX;
	const width = Math.min(b.maxWidth, b.padX + b.charPx * String(caption.text ?? "").length) * k;
	const height = b.height * k;
	const y = caption.place === "top" ? b.edge * k : plan.output.height - (b.edge + b.height) * k;
	return { x: b.inset * k, y, width, height };
}

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** How far from the control a change can be and still count as part of the same action. */
export const CHANGE_NEAR_TARGET_PX = 16;

const grows = (box, by) => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });

/**
 * The controls a caption covers: each event with a target that acts while the caption is on
 * screen, and its change when that change is at the control. A click on a radio also repaints a
 * sticky bar far below it; that is not a control the caption hides, and counting it made
 * caption_clear fail for a caption that covers nothing.
 */
export function captionConflicts(plan, events, caption) {
	const area = plan.source.width * plan.source.height;
	const box = captionBox(plan, caption);
	const hits = [];
	for (const event of events ?? []) {
		if (!event.target || event.kind === "goto" || event.kind === "scroll") continue;
		const t = outputTimeForFrame(plan, event.startFrame);
		if (t === null || t < caption.start || t > caption.end) continue;
		const camera = cameraAt(plan, t);
		const boxes = [event.target];
		const near = grows(event.target, CHANGE_NEAR_TARGET_PX);
		if (event.changed && event.changed.width * event.changed.height < 0.35 * area && overlap(event.changed, near)) boxes.push(event.changed);
		const hit = boxes.map((b) => cameraTransform(plan, camera, b)).find((b) => overlap(b, box));
		if (hit) hits.push({ event: event.id, t, box: hit });
	}
	return hits;
}
