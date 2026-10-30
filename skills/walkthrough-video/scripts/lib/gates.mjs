/**
 * Gates 1 to 8 of the design, as pure checks where possible. Gate 8 (the
 * HyperFrames check) and the ffmpeg scan for gate 5 live in gates-run.mjs,
 * which feeds `gateBlankFrame` its samples.
 */
import { containsPoint, insetBox } from "./geometry.mjs";
import { TEXT_FLOOR_MARGIN_PX, fitZoom, maxZoom, readZoom, textPxAt as textPx, textReadsAt, widestBoxWidth } from "./compose-plan.mjs";
import { cameraAt, captionConflicts, cameraTransform, clipAtOutputTime, clipDuration, clipOutputEnd, clipOutputStart, cursorAt, devicePixelsPerOutputPixel, outputTimeForFrame } from "./plantime.mjs";
import { stillFramesIn } from "./stills.mjs";

/** Luma range below which a frame counts as near-uniform (blank). */
export const BLANK_LUMA_RANGE = 12;
/** Longest stretch with nothing to look at, in output seconds. */
export const MAX_DEAD_STRETCH_S = 3;
/** A still picture under a voice line is the shot being explained, up to this long. */
export const MAX_STILL_UNDER_VOICE_S = 6;
/** Title-safe area: 80 percent of the frame, 10 percent margin on each side. */
export const SAFE_FRACTION = 0.8;
/** Text floor: 2.6 percent of the output short side (28 px at 1080). */
export const TEXT_FLOOR_FRACTION = 0.026;
/**
 * Plans round the camera zoom to three decimals, which can leave the text a
 * tiny fraction below the floor (a 1.404 zoom gives 18.7199 px for 18.72).
 * Compose and the gates share one margin, so the two agree to 0.2 px.
 */
export const TEXT_FLOOR_EPSILON_PX = TEXT_FLOOR_MARGIN_PX;

const t3 = (seconds) => `${seconds.toFixed(3)}s`;
const s1 = (seconds) => `${seconds.toFixed(1)} s`;

function gate(id, status, detail, extra = {}) {
	return { id, status, detail, fix: null, checked: 0, ...extra };
}

/** Gate 1: at each click the cursor is inside the target box, inset 2 px. */
export function gateCursorOnTarget(plan, events) {
	const checked = [];
	const seen = new Set();
	const eventById = new Map((events.events ?? []).map((event) => [event.id, event]));
	for (const point of plan.cursor ?? []) {
		if (!point.click) continue;
		const event = point.event ? eventById.get(point.event) : undefined;
		if (event) {
			seen.add(event.id);
			// A keyframe for a click that the plan drops is not shown, so it cannot fail.
			if (outputTimeForFrame(plan, event.startFrame) === null) continue;
		}
		checked.push({ time: point.t, event, cursor: cursorAt(plan, point.t) });
	}
	for (const event of events.events ?? []) {
		if (event.kind !== "click" || seen.has(event.id)) continue;
		const time = outputTimeForFrame(plan, event.startFrame);
		if (time === null) continue;
		checked.push({ time, event, cursor: cursorAt(plan, time) });
	}
	if (checked.length === 0) return gate("cursor_on_target", "skip", "no click inside a kept clip");
	const misses = [];
	let scored = 0;
	for (const item of checked) {
		if (!item.event?.target || !item.cursor) continue;
		scored++;
		const box = insetBox(item.event.target, 2);
		if (box && containsPoint(box, item.cursor.x, item.cursor.y)) continue;
		misses.push(`at ${t3(item.time)} the cursor (${Math.round(item.cursor.x)}, ${Math.round(item.cursor.y)}) is outside ${item.event.id} target ${JSON.stringify(item.event.target)}`);
	}
	if (scored === 0) return gate("cursor_on_target", "skip", "clicks have no target box or no cursor keyframes");
	if (misses.length === 0) return gate("cursor_on_target", "pass", `${scored} click(s) on target`, { checked: scored });
	return gate("cursor_on_target", "fail", `${misses.length} of ${scored} clicks missed: ${misses.join("; ")}`, { checked: scored, fix: "Move the cursor keyframe to the target centre with plan.cursor, 0.15 s before the click, and keep the target box from events.json." });
}

/**
 * Which edges the camera is pressed against. A camera that shows the whole
 * source (zoom 1) is clamped on every side; a zoomed camera is clamped where
 * its view would leave the source viewport.
 */
export function clampedSides(plan, camera) {
	const halfW = plan.source.width / camera.zoom / 2;
	const halfH = plan.source.height / camera.zoom / 2;
	const tolerance = 0.5;
	return {
		left: camera.cx <= halfW + tolerance,
		right: camera.cx >= plan.source.width - halfW - tolerance,
		top: camera.cy <= halfH + tolerance,
		bottom: camera.cy >= plan.source.height - halfH - tolerance,
	};
}

const describeBox = (box) => `(${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.width)}x${Math.round(box.height)})`;

/** A move is a camera key that changes position or zoom. */
export function cameraMoves(plan) {
	const moves = [];
	const keys = plan.camera ?? [];
	for (let i = 1; i < keys.length; i++) {
		const a = keys[i - 1], b = keys[i];
		if (a.cx !== b.cx || a.cy !== b.cy || a.zoom !== b.zoom) moves.push(b.t);
	}
	return moves;
}

/** More than this many moves inside CAMERA_CHURN_WINDOW_S is churn: the viewer cannot follow the frame. */
export const CAMERA_CHURN_MAX_MOVES = 2;
export const CAMERA_CHURN_WINDOW_S = 2;

/** Gate 10: no more than two camera moves inside any two seconds. */
export function gateCameraChurn(plan) {
	const moves = cameraMoves(plan);
	if (moves.length < 3) return gate("camera_churn", "skip", `${moves.length} camera move(s): too few to churn`);
	for (let i = 0; i + CAMERA_CHURN_MAX_MOVES < moves.length; i++) {
		const from = moves[i], to = moves[i + CAMERA_CHURN_MAX_MOVES];
		if (to - from >= CAMERA_CHURN_WINDOW_S - 1e-9) continue;
		return gate("camera_churn", "fail", `${CAMERA_CHURN_MAX_MOVES + 1} moves in ${(to - from).toFixed(2)} s: ${moves.slice(i, i + CAMERA_CHURN_MAX_MOVES + 1).map(t3).join(", ")}`, {
			checked: moves.length,
			fix: "Two close targets got an out and back. Put them in one shot (the composer then moves straight from one to the next), merge them into one mark, or drop one of the two actions. A shot with one focus throughout needs no move at all.",
		});
	}
	return gate("camera_churn", "pass", `${moves.length} camera move(s), at most ${CAMERA_CHURN_MAX_MOVES} in ${CAMERA_CHURN_WINDOW_S} s`, { checked: moves.length });
}

/** A render may differ from the plan by this much and still be the same framing. */
export const CAMERA_SCALE_TOLERANCE = 0.02;

/**
 * The output times at which the rendered zoom must match the plan: every camera
 * key, and the middle of every focus window.
 */
export function cameraScaleTimes(plan) {
	const times = new Set();
	const add = (value) => {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) times.add(Math.round(value * 1000) / 1000);
	};
	for (const key of plan.camera ?? []) add(key.t);
	for (const window of plan.focus ?? []) add((window.start + window.end) / 2);
	return [...times].sort((a, b) => a - b);
}

/**
 * Gate 11: the composition on disk (index.html) puts the camera where plan.json
 * says. `samples` are [{t, scale}] read from the real timeline in Chromium: the
 * scale of #cam at that time. A stale index.html, a broken CSS variable tween or
 * a clock offset shows up here, before a two minute render does.
 */
export function gateCameraScale(plan, samples) {
	if (!samples || samples.length === 0) return gate("camera_scale", "skip", "no render samples");
	const bad = [];
	let worst = 0;
	for (const sample of samples) {
		const expected = cameraAt(plan, sample.t).zoom;
		if (!Number.isFinite(expected) || expected <= 0) continue;
		const error = Math.abs(sample.scale - expected) / expected;
		worst = Math.max(worst, error);
		if (error > CAMERA_SCALE_TOLERANCE) bad.push(`at ${t3(sample.t)} the render shows zoom ${sample.scale.toFixed(3)} but the plan key is ${expected.toFixed(3)} (${(error * 100).toFixed(0)} % off)`);
	}
	if (bad.length === 0) return gate("camera_scale", "pass", `${samples.length} sample(s) within ${(CAMERA_SCALE_TOLERANCE * 100).toFixed(0)} % of the plan (worst ${(worst * 100).toFixed(1)} %)`, { checked: samples.length });
	return gate("camera_scale", "fail", bad.slice(0, 3).join("; "), { checked: samples.length, fix: "index.html does not show what plan.json says. Run 'wv compose' again, do not edit plan.json or index.html by hand, and gate the new project. If compose just wrote it, the browser blocked the GSAP file: run 'wv setup' so the project carries its own gsap.min.js." });
}

/**
 * Gate 2: the focus box is inside the output frame, and inside the 80 percent
 * title-safe area on every side where the camera is not clamped to the source
 * edge. A clamped side may show the box in the outer margin, because the
 * camera cannot go further without showing past the source.
 */
export function gateFocusInSafe(plan, events) {
	const windows = plan.focus ?? [];
	if (windows.length === 0) return gate("focus_in_safe", "skip", "no focus windows");
	const eventById = new Map((events.events ?? []).map((event) => [event.id, event]));
	const marginX = plan.output.width * (1 - SAFE_FRACTION) * 0.5;
	const marginY = plan.output.height * (1 - SAFE_FRACTION) * 0.5;
	const safe = { left: marginX, top: marginY, right: plan.output.width - marginX, bottom: plan.output.height - marginY };
	const fails = [];
	let scored = 0;
	let clampedAllowed = 0;
	for (const window of windows) {
		const event = eventById.get(window.event);
		const source = event?.[window.box];
		if (!source) continue;
		scored++;
		const time = (window.start + window.end) / 2;
		const camera = cameraAt(plan, time);
		const box = cameraTransform(plan, camera, source);
		const right = box.x + box.width;
		const bottom = box.y + box.height;
		if (box.x < -0.5 || box.y < -0.5 || right > plan.output.width + 0.5 || bottom > plan.output.height + 0.5) {
			fails.push(`${window.event}.${window.box} at ${t3(time)} is outside the output frame: ${describeBox(box)} in ${plan.output.width}x${plan.output.height}`);
			continue;
		}
		const clamped = clampedSides(plan, camera);
		const sides = [];
		if (!clamped.left && box.x < safe.left) sides.push("left");
		if (!clamped.right && right > safe.right) sides.push("right");
		if (!clamped.top && box.y < safe.top) sides.push("top");
		if (!clamped.bottom && bottom > safe.bottom) sides.push("bottom");
		if (sides.length > 0) {
			fails.push(`${window.event}.${window.box} at ${t3(time)} is in the title-safe margin on the ${sides.join(" and ")} ${sides.length > 1 ? "sides" : "side"}: ${describeBox(box)}, safe area ${Math.round(safe.left)}..${Math.round(safe.right)} x ${Math.round(safe.top)}..${Math.round(safe.bottom)}`);
			continue;
		}
		if (clamped.left || clamped.right || clamped.top || clamped.bottom) clampedAllowed++;
	}
	if (scored === 0) return gate("focus_in_safe", "skip", "focus windows name no box in events.json");
	if (fails.length === 0) {
		const note = clampedAllowed > 0 ? `, ${clampedAllowed} against a clamped source edge` : "";
		return gate("focus_in_safe", "pass", `${scored} focus window(s) inside the title-safe area${note}`, { checked: scored });
	}
	return gate("focus_in_safe", "fail", fails.join("; "), { checked: scored, fix: "Centre the camera on the focus box (or reduce the zoom) so the whole box stays inside the title-safe area; a clamped source edge may take the margin on that side only." });
}

/** Gate 3: no upscale at any camera keyframe. */
export function gateNoUpscale(plan) {
	const camera = plan.camera ?? [];
	if (camera.length === 0) return gate("no_upscale", "skip", "no camera keyframes");
	const bad = [];
	for (const keyframe of camera) {
		const ratio = devicePixelsPerOutputPixel(plan, keyframe);
		if (ratio < 1 - 1e-9) bad.push(`at ${t3(keyframe.t)} zoom ${keyframe.zoom} gives ${ratio.toFixed(2)} source px per output px`);
	}
	if (bad.length === 0) {
		const lowest = Math.min(...camera.map((keyframe) => devicePixelsPerOutputPixel(plan, keyframe)));
		return gate("no_upscale", "pass", `lowest ${lowest.toFixed(2)} source px per output px`, { checked: camera.length });
	}
	return gate("no_upscale", "fail", bad.join("; "), { checked: camera.length, fix: plan.source.scale * plan.source.width < plan.output.width ? `The capture has fewer pixels than the output even at zoom 1: capture again with --scale ${Math.ceil(plan.output.width / plan.source.width)} or more.` : `Capture again with a higher --scale (the zoom may be at most ${((plan.source.scale * plan.source.width) / plan.output.width).toFixed(2)} at this scale).` });
}

/** Gate 4: the focused text is at least 2.6 percent of the output short side. */
export function gateTextReadable(plan, events) {
	const windows = plan.focus ?? [];
	if (windows.length === 0) return gate("text_readable", "skip", "no focus windows");
	const eventById = new Map((events.events ?? []).map((event) => [event.id, event]));
	const floorPx = TEXT_FLOOR_FRACTION * Math.min(plan.output.width, plan.output.height);
	const fails = [];
	const fixes = new Set();
	let scored = 0;
	for (const window of windows) {
		const event = eventById.get(window.event);
		if (!event || typeof event.fontPx !== "number" || event.fontPx <= 0) continue;
		scored++;
		const time = (window.start + window.end) / 2;
		const camera = cameraAt(plan, time);
		const px = textPx(event.fontPx, camera.zoom, plan.source, plan.output);
		if (!textReadsAt(event.fontPx, camera.zoom, plan.source, plan.output)) {
			fails.push(`${window.event} at ${t3(time)}: ${px.toFixed(1)} px after zoom, floor ${floorPx.toFixed(1)} px`);
			fixes.add(textFix(plan, event, event[window.box] ?? event.target));
		}
	}
	if (scored === 0) return gate("text_readable", "skip", "focus windows have no fontPx in events.json");
	if (fails.length === 0) return gate("text_readable", "pass", `${scored} focus window(s) at or above ${floorPx.toFixed(1)} px`, { checked: scored });
	return gate("text_readable", "fail", fails.join("; "), { checked: scored, fix: [...fixes].join(" ") });
}

/**
 * Which limit kept the zoom low: the capture's pixels, the width of the focus
 * box, or the camera arriving late. The line names the number the agent can act
 * on (the widest box that fits) and the cost of the bigger capture.
 */
function textFix(plan, event, box) {
	const need = readZoom(event.fontPx, plan.source, plan.output);
	const pixels = maxZoom(plan.source, plan.output);
	if (!textReadsAt(event.fontPx, pixels, plan.source, plan.output)) {
		const scale = Math.max(3, Math.ceil(((need * plan.output.width) / plan.source.width) * 2) / 2);
		return `${event.id}: ${event.fontPx} px text needs zoom ${need.toFixed(2)}; this capture allows ${pixels.toFixed(2)} at scale ${plan.source.scale}. Capture again with --scale ${scale}: more pixels, but the capture takes longer and can drop frames. Try --width 1024 --height 576 --scale 3 first, and keep the shot short.`;
	}
	if (box && fitZoom(box, plan.source, plan.output) < need) {
		const widest = widestBoxWidth(need, plan.source, plan.output);
		return `${event.id}: ${event.fontPx} px text needs zoom ${need.toFixed(2)}, and at that zoom only ${widest} px of box width fits; this box is ${Math.round(box.width)} px wide. Mark a smaller element: the text itself, or a span around one sentence.`;
	}
	return `${event.id}: the camera was not at its focus zoom at this time. Give the shot more time (a wait after the action) so the camera arrives.`;
}

/** Gate 9: no control the shot acts on sits under its caption. */
export function gateCaptionClear(plan, events) {
	const captions = plan.captions ?? [];
	if (captions.length === 0) return gate("caption_clear", "skip", "no captions");
	const fails = [];
	for (const caption of captions) {
		for (const hit of captionConflicts(plan, events.events ?? [], caption)) fails.push(`"${caption.text}" covers ${hit.event} at ${t3(hit.t)}`);
	}
	if (fails.length === 0) return gate("caption_clear", "pass", `${captions.length} caption(s) clear of the controls`, { checked: captions.length });
	return gate("caption_clear", "fail", fails.join("; "), { checked: captions.length, fix: 'Put the caption where it covers nothing: set "caption": {"text": "...", "place": "top"} on the shot, shorten the caption, or split the shot so the caption shows after the action. The composer moves a caption to the top by itself only when shots.json does not fix its place.' });
}

/** Gate 5: no near-uniform frame inside a kept clip. Samples are in capture seconds. */
export function gateBlankFrame(plan, samples) {
	const kept = (samples ?? []).filter((sample) => {
		const frame = Math.round(sample.t * plan.fps);
		const clips = plan.clips ?? [];
		return clips.some((clip) => frame >= clip.from && frame <= clip.to);
	});
	if (kept.length === 0) return gate("blank_frame", "skip", "no sampled frames inside a kept clip");
	const bad = kept.filter((sample) => sample.ymax - sample.ymin < BLANK_LUMA_RANGE);
	if (bad.length === 0) return gate("blank_frame", "pass", `${kept.length} kept frame(s) have detail`, { checked: kept.length });
	const sample = bad[0];
	const frame = Math.round(sample.t * plan.fps);
	const time = outputTimeForFrame(plan, frame);
	const clip = (plan.clips ?? []).find((c) => frame >= c.from && frame <= c.to);
	const intoShot = clip ? Math.max(0.1, Math.round(((frame - clip.from + 2) / plan.fps / (clip.speed || 1)) * 10) / 10) : null;
	const trim = intoShot === null ? '"trim": {"start": 0.5}' : `"trim": {"start": ${intoShot}}`;
	return gate("blank_frame", "fail", `${bad.length} near-uniform frame(s) of ${kept.length}: at ${t3(sample.t)} (capture frame ${frame}, luma range ${Math.round(sample.ymax - sample.ymin)})`, {
		checked: kept.length,
		fix: `Keep that frame out of the edit (output ${time === null ? "unmapped" : t3(time)}): set ${trim} on the shot that shows it${intoShot === null ? "" : ` (the frame is about ${intoShot} s into that shot)`}, or set "cut": true on the shot so the camera cuts to the next frame instead. When the blank is the app's own launch or splash screen, see "A splash or launch screen" in references/troubleshooting.md.`,
	});
}

/** Gate 6: no output stretch over 3 s with no source change, camera move or caption change. */
export function gateDeadStretch(plan, events = { events: [] }) {
	const points = new Set();
	const add = (value) => {
		if (typeof value === "number" && Number.isFinite(value)) points.add(Math.round(value * 1000) / 1000);
	};
	for (const clip of plan.clips ?? []) {
		add(clipOutputStart(clip));
		add(clipOutputStart(clip) + clipDuration(clip, plan.fps));
		add(clipOutputEnd(clip, plan.fps));
	}
	let previous = null;
	for (const keyframe of [...(plan.camera ?? [])].sort((a, b) => a.t - b.t)) {
		if (!previous || keyframe.cx !== previous.cx || keyframe.cy !== previous.cy || keyframe.zoom !== previous.zoom) add(keyframe.t);
		previous = keyframe;
	}
	for (const caption of plan.captions ?? []) {
		add(caption.start);
		add(caption.end);
	}
	for (const point of plan.cursor ?? []) add(point.t);
	for (const event of events.events ?? []) {
		if (event.kind === "wait") continue;
		if (!event.changed && !event.caret && !event.target) continue;
		add(outputTimeForFrame(plan, event.startFrame));
		add(outputTimeForFrame(plan, event.settleFrame));
	}
	const times = [...points].sort((a, b) => a - b);
	// A still picture under a voice line is the shot being explained, not dead time.
	const speech = (plan.voice ?? []).map((v) => ({ from: v.start, to: v.start + (v.seconds ?? v.end - v.start) }));
	const gaps = [];
	for (let i = 1; i < times.length; i++) {
		const from = times[i - 1];
		const to = times[i];
		const clip = clipAtOutputTime(plan, from);
		if (!clip || from >= clipOutputEnd(clip, plan.fps)) continue;
		if (to - from > MAX_STILL_UNDER_VOICE_S + 1e-9) gaps.push({ from, to });
		else for (const part of silentParts(from, to, speech)) if (part.to - part.from > MAX_DEAD_STRETCH_S + 1e-9) gaps.push(part);
	}
	if (gaps.length === 0) return gate("dead_stretch", "pass", "no stretch over 3 s", { checked: times.length });
	const list = gaps.map((g) => `${s1(g.to - g.from)} from ${t3(g.from)} to ${t3(g.to)}`).join("; ");
	return gate("dead_stretch", "fail", `${gaps.length} dead stretch(es): ${list}`, { checked: times.length, fix: 'Set "speed" (for example 2) on the shot in shots.json, shorten its voice line (a still picture may hold 6 s under a voice), or split the shot so a caption changes in the stretch. When the stretch is one long settle in events.json (settleFrame far after endFrame), fix the capture instead: hide the element that keeps changing, or wait for the content with waitFor.' });
}

/** The parts of [from, to] that no speech interval covers. */
function silentParts(from, to, speech) {
	let parts = [{ from, to }];
	for (const s of speech) {
		parts = parts.flatMap((p) => {
			if (s.to <= p.from || s.from >= p.to) return [p];
			return [{ from: p.from, to: s.from }, { from: s.to, to: p.to }].filter((q) => q.to > q.from);
		});
	}
	return parts;
}

/** Below this many new frames a second a shot with motion looks like a slideshow. */
export const MIN_NEW_FPS = 20;
/** A pause longer than this is a still picture, not motion: a calm UI changes in steps. */
export const LONG_STILL_S = 0.5;
/** A shot has motion when fewer than this share of its frames sits in a long pause. */
export const MOTION_STILL_SHARE = 0.5;
/**
 * A shot needs at least this many new images before its rate says anything: a
 * shot that shows one picture is a still, not a slow slideshow.
 */
export const MIN_MOTION_FRAMES = 3;
/**
 * A frame draw at or above this 95th percentile means the capture could not keep
 * up, so even a shot whose still runs are long was meant to move: the host or the
 * page's own animation stalled it.
 */
export const SLOW_DRAW_MS = 150;

/**
 * The frames of [from, to] that sit in a run of repeated frames longer than
 * LONG_STILL_S. A UI that changes in steps has long pauses and is not a
 * slideshow; a canvas animation that the browser draws at 5 fps has none.
 */
function longStillFrames(stills, from, to, fps) {
	const limit = LONG_STILL_S * fps;
	let count = 0;
	for (const [a, b] of stills) {
		if (b < from || a > to) continue;
		const start = Math.max(a, from), end = Math.min(b, to);
		if (end - start + 1 >= limit) count += end - start + 1;
	}
	return count;
}

/**
 * Why a shot showed so few new frames: the host, the draw time, or the app's own
 * animation. The agent can act on each of the three, so the line names the one
 * that the capture's numbers point to.
 */
function smoothFix(events, row) {
	const stats = events?.stats ?? {};
	const load = Array.isArray(stats.load) ? stats.load[0] : null;
	const cores = stats.cores ?? null;
	const p95 = stats.frameMs?.p95 ?? null;
	const canvas = stats.canvas;
	let cause;
	if (typeof load === "number" && cores && load >= cores * 0.8) cause = `the host was busy: load ${load.toFixed(1)} on ${cores} cores, so the browser got few slots`;
	else if (typeof p95 === "number" && p95 >= 50) cause = `each captured frame took ${p95} ms to draw (p95)${canvas ? `, from a ${canvas.width}x${canvas.height} ${canvas.webgl ? "WebGL" : "canvas"} view or a large --scale` : ""}`;
	else if (typeof p95 === "number") cause = `the app itself changed the screen about ${row.rate.toFixed(1)} times a second (frame draw p95 ${p95} ms)`;
	else cause = "the capture kept far fewer new frames than it wrote";
	return `The cause is ${cause}. Fix: close other work on the host; for a canvas or WebGL view capture with --gpu on; use --width 1024 --height 576 --scale 2 when the zoom allows; or let the motion take more time (a shot "speed" below 1) and keep the app's own animation short. The camera and the cursor are drawn at 60 fps, so a UI shot is smooth as soon as new frames are kept.`;
}

/**
 * Gate 12: every shot with motion shows at least 20 new frames a second. The
 * capture writes the runs of repeated frames (stills); a shot's picture length is
 * in plan.json. A busy host, a slow WebGL draw or a big --scale fills the capture
 * with the same image, and the render then shows a slideshow.
 */
export function gateSmoothness(plan, events) {
	const shots = plan.shots;
	if (!Array.isArray(shots) || shots.length === 0) return gate("smoothness", "skip", "the plan has no shot frame ranges; run wv compose again");
	if (!Array.isArray(events?.stills)) return gate("smoothness", "skip", "events.json has no still runs (captured by an older wv); capture again to measure smoothness");
	const fps = plan.fps || 60;
	const drawP95 = events?.stats?.frameMs?.p95 ?? null;
	const drawSlow = typeof drawP95 === "number" && drawP95 >= SLOW_DRAW_MS;
	const rows = [];
	for (const [index, shot] of shots.entries()) {
		const frames = shot.to - shot.from + 1;
		const seconds = shot.picture;
		if (!(frames > 1) || !(seconds > 0)) continue;
		const distinct = frames - stillFramesIn(events.stills, shot.from, shot.to);
		const paused = longStillFrames(events.stills, shot.from, shot.to, fps);
		// Motion is a steady stream of changes, or a capture that could not keep up while it changed.
		const motion = distinct >= MIN_MOTION_FRAMES && (drawSlow || paused < MOTION_STILL_SHARE * frames);
		rows.push({ index, frames, distinct, seconds, rate: distinct / seconds, motion });
	}
	const moving = rows.filter((row) => row.motion);
	if (moving.length === 0) return gate("smoothness", "skip", `${rows.length} shot(s) change in steps, not in motion: nothing to smooth`);
	const slow = moving.filter((row) => row.rate < MIN_NEW_FPS - 1e-9);
	const detail = (row) => `shot ${row.index + 1}: ${row.rate.toFixed(1)} new frames a second (${row.distinct} of ${row.frames} frames are new), floor ${MIN_NEW_FPS}`;
	if (slow.length === 0) {
		const lowest = moving.reduce((min, row) => Math.min(min, row.rate), Infinity);
		return gate("smoothness", "pass", `${moving.length} shot(s) with motion at ${MIN_NEW_FPS} new frames a second or more (lowest ${lowest.toFixed(1)})`, { checked: moving.length });
	}
	const worst = slow.reduce((a, b) => (b.rate < a.rate ? b : a));
	return gate("smoothness", "fail", `${slow.length} of ${moving.length} shot(s) with motion are below ${MIN_NEW_FPS} new frames a second: ${slow.map(detail).join("; ")}`, { checked: moving.length, fix: smoothFix(events, worst) });
}

/** Gate 7: each voice line is shorter than its window. */
export function gateVoiceFits(plan) {
	const lines = plan.voice ?? [];
	if (lines.length === 0) return gate("voice_fits", "skip", "no voice lines");
	const bad = lines.filter((line) => line.end - line.start < line.seconds);
	if (bad.length === 0) return gate("voice_fits", "pass", `${lines.length} voice line(s) fit`, { checked: lines.length });
	const line = bad[0];
	return gate("voice_fits", "fail", `${line.seconds.toFixed(1)} s of voice in a ${(line.end - line.start).toFixed(1)} s window at ${t3(line.start)}; ${bad.length} of ${lines.length} too long`, { checked: lines.length, fix: "Move the window start earlier, extend the window end, or shorten the line text." });
}
