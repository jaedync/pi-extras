// Camera, cursor, focus windows, captions and voice for plan.json, from the laid-out shots.
import { SPEC, captionOf, centreFor, focusFor, outTime, outTimeOr, textPxAt, textReadsAt } from "./compose-plan.mjs";
import { captionConflicts } from "./plantime.mjs";

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** True when the box already sits in the safe area of the current view at a zoom that reads. */
function alreadyFramed(cam, f, source) {
	if (!f.box || cam.zoom < f.zRead - 0.01 || cam.zoom < f.zoom - 0.15) return false;
	const halfW = (source.width / cam.zoom / 2) * SPEC.safeFrac, halfH = (source.height / cam.zoom / 2) * SPEC.safeFrac;
	const { box } = f;
	return box.x >= cam.cx - halfW && box.x + box.width <= cam.cx + halfW && box.y >= cam.cy - halfH && box.y + box.height <= cam.cy + halfH;
}

function cameraFor(f, source) {
	if (!f.box) return { cx: source.width / 2, cy: source.height / 2, zoom: 1 };
	return { ...centreFor(f.box, f.zoom, source), zoom: f.zoom };
}

/** The kinds of event that change the page themselves: only these earn a pull-back to the overview. */
const ACTION_KINDS = ["click", "type", "key", "scroll"];

/** Builds camera keyframes (t = arrival time), focus windows and warnings for every shot. */
export function buildCamera(spans, clips, capture, source, output, startAt, endAt) {
	const fps = capture.fps;
	const camera = [{ t: round(startAt), cx: source.width / 2, cy: source.height / 2, zoom: 1, ease: "none" }];
	const focus = [], warnings = [];
	let cam = camera[0], windowCam = null;
	// A focus window ends when the next camera move starts.
	const move = (key) => {
		const prev = focus.at(-1);
		if (prev) prev.end = round(Math.max(prev.start + 0.3, Math.min(prev.end, key.t - SPEC.cameraMoveS)));
		camera.push(key);
		return key;
	};
	for (const span of spans) for (const ev of span.dropped ?? []) warnings.push(`shot ${span.index + 1}: "trim" drops ${ev.id} (its frames are outside the kept part of the shot). Fix: trim less, or remove the event from the shot.`);
	// Every stop first, so a move can see whether another focus is close behind it.
	const stops = [];
	for (const span of spans) for (const ev of span.evs) stops.push({ ev, span, f: focusFor(ev, source, output, span.shot.focus ?? "auto"), arrive: outTimeOr(clips, ev.startFrame, fps, span.start) - SPEC.leadS * 0.4 });
	// A shot's focus mode that frames the same box as auto does nothing: say so once per shot, because
	// the agent picked it to change a frame the review showed as wrong.
	const sameStop = (a, b) => a.kind === b.kind && JSON.stringify(a.box) === JSON.stringify(b.box);
	for (const span of spans) {
		const mode = span.shot.focus;
		if (!mode || mode === "auto") continue;
		const pointless = span.evs.some((ev) => sameStop(focusFor(ev, source, output, mode), focusFor(ev, source, output, "auto")));
		if (pointless) {
			const why = mode === "overview" ? "the camera would show the whole page anyway" : `its events have no ${mode} box, or the camera already frames them`;
			warnings.push(`shot ${span.index + 1}: "focus": "${mode}" changes nothing (${why}). Fix: use another mode, or remove "focus" from the shot.`);
		}
	}
	/** The arrival time of the next stop that frames a box, or null. */
	const nextFocusAt = (index) => stops.slice(index + 1).find((stop) => stop.f.box)?.arrive ?? null;
	let index = -1;
	for (const span of spans) {
		span.evs.forEach((ev, k) => {
			index++;
			const f = stops[index].f;
			const last = k === span.evs.length - 1;
			// A "cut" shot starts on a hard cut: the camera is in place on the first frame, with no move.
			if (k === 0 && span.shot.cut) {
				const prev = focus.at(-1);
				if (prev) prev.end = round(Math.min(prev.end, span.start));
				const snap = { t: round(span.start), ...roundCam(cameraFor(f, source)), ease: "none" };
				if (snap.cx !== cam.cx || snap.cy !== cam.cy || snap.zoom !== cam.zoom) {
					camera.push(snap);
					cam = snap;
				}
			}
			if (f.kind === "stay") {
				// The pause belongs to the shot: the framed result stays framed until the wait ends, and
				// through the shot's caption and voice line when it is the shot's last event.
				const prev = focus.at(-1);
				const holdTo = last ? span.end : outTimeOr(clips, ev.settleFrame ?? ev.endFrame, fps, span.start);
				if (prev && cam === windowCam && prev.end >= span.start - 1e-6) prev.end = round(Math.max(prev.end, holdTo));
				return;
			}
			const arrive = Math.max(cam.t + SPEC.cameraMoveS, outTimeOr(clips, ev.startFrame, fps, span.start) - SPEC.leadS * 0.4);
			if (arrive > span.end) warnings.push(`${ev.id}: the camera cannot reach this action before its shot ends (actions too close together). Fix: give the shot "speed" below 1, or wait between the actions.`);
			if (ev.fontPx && !textReadsAt(ev.fontPx, f.zMax, source, output)) warnings.push(`${ev.id}: text of ${ev.fontPx} px reaches ${textPxAt(ev.fontPx, f.zMax, source, output).toFixed(1)} px at this capture's limit of zoom ${f.zMax.toFixed(2)}; the floor is ${(SPEC.minTextFrac * Math.min(output.width, output.height)).toFixed(1)} px. Fix: capture again with --scale 3 or more (more pixels, but a slower and choppier capture), or mark a smaller element.`);
			const next = roundCam(cameraFor(f, source));
			const same = next.cx === cam.cx && next.cy === cam.cy && next.zoom === cam.zoom;
			if (!same && !alreadyFramed(cam, f, source)) cam = move({ t: round(arrive), ...next, ease: "power3.inOut" });
			const endF = ev.settleFrame ?? ev.endFrame;
			const bigChange = ev.changed && ev.changed.width * ev.changed.height >= 0.35 * source.width * source.height;
			// After a change that fills the screen, the camera pulls back to show it; the focus window
			// on the control ends when that move starts.
			// It counts from this event: a control that was already framed added no key of its own.
			// Never before the key it leaves: camera keys must stay in time order for the tweens.
			// The camera stays on what the caption explains until that caption and its voice line end,
			// and it does not pull back at all when the next focus window starts within churnGapS:
			// that would be an in, out and in again for one idea.
			const contentEnd = span.end - 0.1;
			const wanted = Math.max(cam.t + SPEC.cameraMoveS, Math.max(cam.t, arrive) + SPEC.cameraMoveS + 0.3);
			const at = round(Math.max(wanted, contentEnd - SPEC.cameraMoveS));
			const nextArrival = nextFocusAt(index);
			const pullBack = last && bigChange && ACTION_KINDS.includes(ev.kind) && (nextArrival === null || nextArrival - at >= SPEC.churnGapS) ? at : null;
			let end = last ? span.end : Math.max(arrive + 0.3, outTimeOr(clips, endF, fps, arrive + 0.3));
			if (pullBack !== null) end = Math.min(end, pullBack - SPEC.cameraMoveS);
			if (f.box) {
				focus.push({ start: round(arrive), end: round(Math.max(end, arrive + 0.3)), event: ev.id, box: f.kind === "changed" ? "changed" : f.kind });
				windowCam = cam;
			}
			if (pullBack !== null && !(cam.zoom === 1 && cam.cx === source.width / 2 && cam.cy === source.height / 2)) {
				cam = move({ t: pullBack, cx: source.width / 2, cy: source.height / 2, zoom: 1, ease: "power3.inOut" });
			}
		});
	}
	if (cam.zoom !== 1) move({ t: round(Math.max(cam.t + SPEC.cameraMoveS, endAt)), cx: source.width / 2, cy: source.height / 2, zoom: 1, ease: "power3.inOut" });
	return { camera, focus, warnings };
}

const roundCam = (c) => ({ cx: round(c.cx, 1), cy: round(c.cy, 1), zoom: round(c.zoom, 3) });

/** Cursor keyframes: travel, arrive just before the action, press on the action's first frame. */
export function buildCursor(spans, clips, capture, source) {
	const fps = capture.fps;
	const first = capture.cursor?.[0] ?? { x: source.width * 0.75, y: source.height * 0.8 };
	const cursor = [];
	let last = { t: 0, x: first.x, y: first.y };
	for (const span of spans) {
		for (const ev of span.evs) {
			if (!["click", "type", "hover"].includes(ev.kind) || !ev.target) continue;
			const when = outTime(clips, ev.startFrame, fps);
			const at = ev.kind === "type" && ev.caret ? { x: ev.target.x + Math.min(ev.target.width / 2, 40), y: ev.target.y + ev.target.height / 2 } : centre(ev.target);
			if (when === null) {
				// The trim cut the action's first frames: the kept part starts with it already done.
				const press = { t: round(span.start), x: round(at.x, 1), y: round(at.y, 1), event: ev.id };
				if (ev.kind !== "hover") press.click = true;
				cursor.push(press);
				last = press;
				continue;
			}
			const t = when;
			const depart = Math.max(last.t + 0.05, t - SPEC.cursorTravelS - 0.12);
			cursor.push({ t: round(depart), x: round(last.x, 1), y: round(last.y, 1) });
			cursor.push({ t: round(Math.max(depart + 0.05, t - 0.12)), x: round(at.x, 1), y: round(at.y, 1) });
			const press = { t: round(t), x: round(at.x, 1), y: round(at.y, 1), event: ev.id };
			if (ev.kind !== "hover") press.click = true;
			cursor.push(press);
			last = press;
		}
	}
	return cursor;
}

/** The drawn cursor stays after its last event for this long, then fades out. */
export const CURSOR_IDLE_S = 1.5;
export const CURSOR_FADE_IN_S = 0.2;
export const CURSOR_FADE_OUT_S = 0.25;

/**
 * The output windows in which the drawn cursor is visible: from just before each
 * pointer key to CURSOR_IDLE_S after it, minus the shots that set "cursor": "hide".
 * A parked cursor is not part of the story and can cover the payoff.
 */
export function cursorVisibility(plan, shots) {
	const times = [...(plan.cursor ?? [])].map((k) => k.t).sort((a, b) => a - b);
	const visible = [];
	for (const t of times) {
		const window = [Math.max(0, t - 0.05), t + CURSOR_IDLE_S];
		const last = visible.at(-1);
		if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
		else visible.push(window);
	}
	const hidden = [];
	const beats = plan.beats ?? [];
	(shots?.shots ?? []).forEach((shot, index) => {
		if (shot.cursor !== "hide") return;
		const start = beats[index]?.t;
		const end = beats[index + 1]?.t ?? (plan.edit ? plan.edit.start + plan.edit.duration : null);
		if (typeof start === "number" && typeof end === "number") hidden.push([start, end]);
	});
	const out = [];
	for (const [from, to] of visible) {
		let parts = [[from, to]];
		for (const [hideFrom, hideTo] of hidden) parts = parts.flatMap(([a, b]) => (hideTo <= a || hideFrom >= b ? [[a, b]] : [[a, Math.min(b, hideFrom)], [Math.max(a, hideTo), b]].filter(([x, y]) => y > x)));
		out.push(...parts);
	}
	return out.filter(([from, to]) => to - from >= 0.4);
}

/**
 * Captions sit at the bottom unless a control of their shot is under them there; then at the top.
 * `plan` needs fps, source, output, clips and camera; the check is the same as gate 9.
 */
export function buildCaptions(spans, plan, events) {
	return spans.filter((s) => captionOf(s.shot)).map((s) => {
		const caption = captionOf(s.shot);
		const c = { start: round(s.start + 0.15), end: round(s.end - 0.1), text: caption.text, place: caption.place ?? "bottom" };
		// A place in shots.json wins: the agent saw the frame and chose. Otherwise move the caption up
		// when a control of the shot is under it at the bottom.
		if (caption.place === null && captionConflicts(plan, events, c).length && !captionConflicts(plan, events, { ...c, place: "top" }).length) c.place = "top";
		return c;
	});
}

export function buildVoice(spans) {
	// start/end is the window the line may fill (its shot); seconds is how long it speaks.
	return spans.filter((s) => s.voice).map((s) => ({ start: round(s.start + 0.2), end: round(s.end), text: s.voice.text, file: s.voice.file, seconds: s.voice.seconds }));
}
