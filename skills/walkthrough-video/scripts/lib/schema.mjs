/**
 * Shape checks for events.json (written by `wv capture`, read by the composer)
 * and plan.json (written by `wv compose`, read by the gates). They name the
 * exact path of every problem so a flow or a plan can be fixed without guessing.
 */

const KINDS = ["goto", "click", "type", "hover", "scroll", "wait", "mark", "key"];
const FOCUS_BOXES = ["caret", "changed", "target"];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isInt = (value) => Number.isInteger(value);
const isString = (value) => typeof value === "string";

function checkBox(problems, path, box, { nullable = true } = {}) {
	if (box === null || box === undefined) {
		if (!nullable) problems.push(`${path}: a box is required`);
		return;
	}
	if (!isObject(box)) {
		problems.push(`${path}: must be an object or null`);
		return;
	}
	for (const key of ["x", "y", "width", "height"]) {
		if (!isNumber(box[key])) problems.push(`${path}.${key}: must be a finite number`);
	}
	if (isNumber(box.width) && box.width < 0) problems.push(`${path}.width: must not be negative`);
	if (isNumber(box.height) && box.height < 0) problems.push(`${path}.height: must not be negative`);
}

export function validateEvents(events) {
	const problems = [];
	if (!isObject(events)) return { ok: false, problems: ["events.json: must be a JSON object"] };
	if (events.version !== 1) problems.push("version: must be 1");
	if (!isInt(events.fps) || events.fps <= 0) problems.push("fps: must be a positive integer");
	if (!isObject(events.viewport)) problems.push("viewport: must be an object");
	else for (const key of ["width", "height", "scale"]) if (!isNumber(events.viewport[key]) || events.viewport[key] <= 0) problems.push(`viewport.${key}: must be a positive number`);
	if (!isString(events.video) || !events.video) problems.push("video: must be a file name");
	if (!isInt(events.frames) || events.frames < 0) problems.push("frames: must be a non-negative integer");
	if (!isObject(events.stats)) problems.push("stats: must be an object");
	else for (const key of ["unique", "repeated", "maxLagMs"]) if (!isInt(events.stats[key]) || events.stats[key] < 0) problems.push(`stats.${key}: must be a non-negative integer`);
	if (isObject(events.stats) && typeof events.stats.gpu !== "boolean") problems.push("stats.gpu: must be true or false");
	if (isObject(events.stats) && events.stats.distinct !== undefined && (!isInt(events.stats.distinct) || events.stats.distinct < 0)) problems.push("stats.distinct: must be a non-negative integer");
	if (isObject(events.stats) && events.stats.frameMs !== undefined) {
		const ms = events.stats.frameMs;
		if (!isObject(ms) || !isInt(ms.p50) || !isInt(ms.p95)) problems.push("stats.frameMs: must be {p50, p95} in whole milliseconds");
	}
	if (isObject(events.stats) && events.stats.load !== undefined && !(Array.isArray(events.stats.load) && events.stats.load.every((v) => isNumber(v) && v >= 0))) problems.push("stats.load: must be an array of load averages");
	if (isObject(events.stats) && events.stats.cores !== undefined && (!isInt(events.stats.cores) || events.stats.cores <= 0)) problems.push("stats.cores: must be a positive integer");

	if (events.stills !== undefined) {
		if (!Array.isArray(events.stills)) problems.push("stills: must be an array of [from, to] frame ranges");
		else
			events.stills.forEach((run, index) => {
				if (!Array.isArray(run) || run.length !== 2 || !isInt(run[0]) || !isInt(run[1]) || run[0] < 0 || run[1] < run[0]) problems.push(`stills[${index}]: must be [from, to] frame indices with to not before from`);
				else if (isInt(events.frames) && run[1] >= events.frames) problems.push(`stills[${index}].to: ${run[1]} is past the last frame ${events.frames - 1}`);
			});
	}

	if (!Array.isArray(events.cursor)) problems.push("cursor: must be an array");
	else {
		events.cursor.forEach((point, index) => {
			const path = `cursor[${index}]`;
			if (!isObject(point)) {
				problems.push(`${path}: must be an object`);
				return;
			}
			if (!isInt(point.f) || point.f < 0) problems.push(`${path}.f: must be a frame index`);
			else if (isInt(events.frames) && point.f > events.frames) problems.push(`${path}.f: ${point.f} is past the last frame ${events.frames}`);
			if (!isNumber(point.x) || !isNumber(point.y)) problems.push(`${path}: x and y must be numbers`);
		});
	}

	if (!Array.isArray(events.events)) problems.push("events: must be an array");
	else {
		events.events.forEach((event, index) => {
			const path = `events[${index}]`;
			if (!isObject(event)) {
				problems.push(`${path}: must be an object`);
				return;
			}
			if (!isString(event.id) || !event.id) problems.push(`${path}.id: must be a non-empty string`);
			if (!KINDS.includes(event.kind)) problems.push(`${path}.kind: ${JSON.stringify(event.kind)} is not one of ${KINDS.join(", ")}`);
			if (!isString(event.name) || !event.name) problems.push(`${path}.name: must be a non-empty string`);
			for (const key of ["startFrame", "endFrame", "settleFrame"]) {
				if (!isInt(event[key]) || event[key] < 0) problems.push(`${path}.${key}: must be a frame index`);
				else if (isInt(events.frames) && event[key] > events.frames) problems.push(`${path}.${key}: ${event[key]} is past the last frame ${events.frames}`);
			}
			if (isInt(event.startFrame) && isInt(event.endFrame) && event.endFrame < event.startFrame) problems.push(`${path}.endFrame: ${event.endFrame} is before startFrame ${event.startFrame}`);
			if (isInt(event.endFrame) && isInt(event.settleFrame) && event.settleFrame < event.endFrame) problems.push(`${path}.settleFrame: ${event.settleFrame} is before endFrame ${event.endFrame}`);
			checkBox(problems, `${path}.target`, event.target);
			checkBox(problems, `${path}.caret`, event.caret);
			checkBox(problems, `${path}.changed`, event.changed);
			if (event.fontPx !== null && (!isNumber(event.fontPx) || event.fontPx <= 0)) problems.push(`${path}.fontPx: must be a positive number or null`);
			if (event.plannedMs !== undefined && event.plannedMs !== null && (!isNumber(event.plannedMs) || event.plannedMs < 0)) problems.push(`${path}.plannedMs: must be 0 or more milliseconds, or null`);
			for (const key of ["text", "label", "caption"]) if (event[key] !== null && !isString(event[key])) problems.push(`${path}.${key}: must be a string or null`);
		});
	}

	if (!Array.isArray(events.cues)) problems.push("cues: must be an array");
	else {
		events.cues.forEach((cue, index) => {
			if (!isObject(cue)) problems.push(`cues[${index}]: must be an object`);
			else {
				if (!isInt(cue.f) || cue.f < 0) problems.push(`cues[${index}].f: must be a frame index`);
				if (!isString(cue.text) || !cue.text) problems.push(`cues[${index}].text: must be a non-empty string`);
			}
		});
	}
	return { ok: problems.length === 0, problems };
}

export function validatePlan(plan) {
	const problems = [];
	if (!isObject(plan)) return { ok: false, problems: ["plan.json: must be a JSON object"] };
	if (plan.version !== 1) problems.push("version: must be 1");
	if (!isInt(plan.fps) || plan.fps <= 0) problems.push("fps: must be a positive integer");
	for (const key of ["source", "output"]) {
		if (!isObject(plan[key])) problems.push(`${key}: must be an object`);
		else for (const side of ["width", "height"]) if (!isNumber(plan[key][side]) || plan[key][side] <= 0) problems.push(`${key}.${side}: must be a positive number`);
	}
	if (isObject(plan.source) && (!isNumber(plan.source.scale) || plan.source.scale <= 0)) problems.push("source.scale: must be a positive number");

	if (!Array.isArray(plan.clips)) problems.push("clips: must be an array");
	else {
		plan.clips.forEach((clip, index) => {
			const path = `clips[${index}]`;
			if (!isObject(clip)) {
				problems.push(`${path}: must be an object`);
				return;
			}
			for (const key of ["from", "to"]) if (!isInt(clip[key]) || clip[key] < 0) problems.push(`${path}.${key}: must be a frame index`);
			if (isInt(clip.from) && isInt(clip.to) && clip.to < clip.from) problems.push(`${path}.to: ${clip.to} is before from ${clip.from}`);
			if (!isNumber(clip.at) || clip.at < 0) problems.push(`${path}.at: must be an output second`);
			if (!isNumber(clip.speed) || clip.speed <= 0) problems.push(`${path}.speed: must be greater than 0`);
			if (clip.hold !== undefined && (!isNumber(clip.hold) || clip.hold < 0)) problems.push(`${path}.hold: must be 0 or more seconds`);
		});
	}

	if (!Array.isArray(plan.camera)) problems.push("camera: must be an array");
	else {
		plan.camera.forEach((keyframe, index) => {
			const path = `camera[${index}]`;
			if (!isObject(keyframe)) {
				problems.push(`${path}: must be an object`);
				return;
			}
			for (const key of ["t", "cx", "cy", "zoom"]) if (!isNumber(keyframe[key])) problems.push(`${path}.${key}: must be a finite number`);
			if (isNumber(keyframe.zoom) && keyframe.zoom <= 0) problems.push(`${path}.zoom: must be greater than 0`);
			const before = plan.camera[index - 1];
			if (index > 0 && isNumber(keyframe.t) && isNumber(before?.t) && keyframe.t < before.t) problems.push(`${path}.t: ${keyframe.t} is before camera[${index - 1}].t ${before.t}; keys must be in time order`);
		});
	}

	if (!Array.isArray(plan.cursor)) problems.push("cursor: must be an array");
	else {
		plan.cursor.forEach((point, index) => {
			const path = `cursor[${index}]`;
			if (!isObject(point)) {
				problems.push(`${path}: must be an object`);
				return;
			}
			for (const key of ["t", "x", "y"]) if (!isNumber(point[key])) problems.push(`${path}.${key}: must be a finite number`);
			if (point.click !== undefined && typeof point.click !== "boolean") problems.push(`${path}.click: must be true or false`);
		});
	}

	if (!Array.isArray(plan.focus)) problems.push("focus: must be an array");
	else {
		plan.focus.forEach((window, index) => {
			const path = `focus[${index}]`;
			if (!isObject(window)) {
				problems.push(`${path}: must be an object`);
				return;
			}
			if (!isNumber(window.start) || !isNumber(window.end)) problems.push(`${path}: start and end must be seconds`);
			if (!isString(window.event)) problems.push(`${path}.event: must be an event id`);
			if (!FOCUS_BOXES.includes(window.box)) problems.push(`${path}.box: must be one of ${FOCUS_BOXES.join(", ")}`);
		});
	}

	if (plan.shots !== undefined) {
		if (!Array.isArray(plan.shots)) problems.push("shots: must be an array of shot frame ranges");
		else
			plan.shots.forEach((shot, index) => {
				const path = `shots[${index}]`;
				if (!isObject(shot)) {
					problems.push(`${path}: must be an object`);
					return;
				}
				for (const key of ["from", "to"]) if (!isInt(shot[key]) || shot[key] < 0) problems.push(`${path}.${key}: must be a frame index`);
				if (isInt(shot.from) && isInt(shot.to) && shot.to < shot.from) problems.push(`${path}.to: ${shot.to} is before from ${shot.from}`);
				for (const key of ["start", "end", "picture"]) if (!isNumber(shot[key]) || shot[key] < 0) problems.push(`${path}.${key}: must be 0 or more seconds`);
			});
	}

	for (const key of ["captions", "voice"]) {
		if (!Array.isArray(plan[key])) problems.push(`${key}: must be an array`);
		else {
			plan[key].forEach((item, index) => {
				const path = `${key}[${index}]`;
				if (!isObject(item)) {
					problems.push(`${path}: must be an object`);
					return;
				}
				if (!isNumber(item.start) || !isNumber(item.end)) problems.push(`${path}: start and end must be seconds`);
				if (item.end < item.start) problems.push(`${path}.end: ${item.end} is before start ${item.start}`);
				if (!isString(item.text)) problems.push(`${path}.text: must be a string`);
				if (key === "voice" && (!isNumber(item.seconds) || item.seconds < 0)) problems.push(`${path}.seconds: must be 0 or more`);
			});
		}
	}
	return { ok: problems.length === 0, problems };
}

/** A short message for the CLI: the first problems, with a count of the rest. */
const FOCUS_MODES = ["auto", "target", "caret", "changed", "overview"];
const CAPTION_PLACES = ["top", "bottom"];
// Values that reach CSS. One rule, shared with compose-html: a look colour is #hex only, because
// that is what the composer writes into the page, and a font is a plain family name. A value
// outside the rule is a validation error, never a silent default.
export const LOOK_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const LOOK_FONT = /^[A-Za-z0-9 ]{1,60}$/;

/**
 * shots.json is written by an agent; its values reach the ffmpeg filter graph and index.html.
 * Returns problems as "path: message" strings, like the other validators.
 */
export function validateShots(shots, events) {
	const problems = [];
	if (!isObject(shots)) return ["shots.json: the top level must be an object"];
	const byIndex = new Map((events ?? []).map((e, i) => [e.id, i]));
	if (shots.output !== undefined) {
		const o = shots.output;
		if (!isObject(o) || !isInt(o.width) || !isInt(o.height) || o.width < 320 || o.height < 180 || o.width > 7680 || o.height > 4320 || o.width % 2 || o.height % 2) problems.push("output: width and height must be even integers from 320x180 to 7680x4320");
	}
	if (shots.look !== undefined) {
		if (!isObject(shots.look)) problems.push("look: must be an object");
		else {
			for (const key of ["ground", "ink", "accent"]) if (shots.look[key] !== undefined && !(isString(shots.look[key]) && LOOK_COLOUR.test(shots.look[key]))) problems.push(`look.${key}: must be a #hex colour with 3, 6 or 8 digits, such as "#faf5f2"`);
			if (shots.look.font !== undefined && !(isString(shots.look.font) && LOOK_FONT.test(shots.look.font))) problems.push('look.font: must be a font family name of up to 60 letters, digits and spaces, such as "Karla"');
		}
	}
	for (const key of ["intro", "outro"]) {
		const card = shots[key];
		if (card === undefined) continue;
		if (!isObject(card) || (card.title !== undefined && !isString(card.title)) || (card.sub !== undefined && !isString(card.sub))) problems.push(`${key}: title and sub must be strings`);
	}
	if (!Array.isArray(shots.shots) || shots.shots.length === 0) return [...problems, "shots: must be a non-empty array"];
	let last = -1;
	shots.shots.forEach((shot, i) => {
		const path = `shots[${i}]`;
		if (!isObject(shot)) {
			problems.push(`${path}: must be an object`);
			return;
		}
		if (!Array.isArray(shot.events) || shot.events.length === 0 || !shot.events.every(isString)) problems.push(`${path}.events: must be a non-empty array of event ids`);
		else for (const id of shot.events) {
			const at = byIndex.get(id);
			if (at === undefined) problems.push(`${path}.events: unknown event "${id}"; use an id from events.json`);
			else if (at <= last) problems.push(`${path}.events: "${id}" is out of capture order or used twice; shots and their events must follow the order of events.json`);
			else last = at;
		}
		if (shot.speed !== undefined && !(isNumber(shot.speed) && shot.speed >= 0.25 && shot.speed <= 12)) problems.push(`${path}.speed: must be a number from 0.25 to 12`);
		if (shot.focus !== undefined && !FOCUS_MODES.includes(shot.focus)) problems.push(`${path}.focus: must be one of ${FOCUS_MODES.join(", ")}`);
		if (shot.cursor !== undefined && !["show", "hide"].includes(shot.cursor)) problems.push(`${path}.cursor: must be "show" or "hide"`);
		if (shot.cut !== undefined && typeof shot.cut !== "boolean") problems.push(`${path}.cut: must be true or false`);
		if (shot.trim !== undefined) {
			const trim = shot.trim;
			if (!isObject(trim)) problems.push(`${path}.trim: must be an object such as {"start": 0.5, "end": 2}`);
			else {
				for (const key of Object.keys(trim)) {
					if (key !== "start" && key !== "end") problems.push(`${path}.trim.${key}: unknown field; use start and end`);
					else if (!isNumber(trim[key])) problems.push(`${path}.trim.${key}: must be a number of seconds`);
					else if (key === "start" && trim.start < 0) problems.push(`${path}.trim.start: must be 0 or more seconds`);
					else if (key === "end" && trim.end <= 0) problems.push(`${path}.trim.end: must be more than 0 seconds`);
				}
				if (isNumber(trim.start) && isNumber(trim.end) && trim.end <= trim.start) problems.push(`${path}.trim: end must be later than start`);
			}
		}
		for (const key of ["caption", "voice"]) {
			const value = shot[key];
			if (value === undefined || value === null) continue;
			if (key === "caption" && isObject(value)) continue;
			if (!isString(value)) problems.push(`${path}.${key}: must be a string${key === "caption" ? ', or {"text": "...", "place": "top"}' : ""}`);
		}
		if (shot.caption !== undefined && shot.caption !== null && isObject(shot.caption)) {
			if (!isString(shot.caption.text) || !shot.caption.text.trim()) problems.push(`${path}.caption.text: must be a non-empty string`);
			if (shot.caption.place !== undefined && !CAPTION_PLACES.includes(shot.caption.place)) problems.push(`${path}.caption.place: must be one of ${CAPTION_PLACES.join(", ")}`);
			for (const key of Object.keys(shot.caption)) if (!["text", "place"].includes(key)) problems.push(`${path}.caption.${key}: unknown field; use text and place`);
		}
	});
	return problems;
}

export function describeProblems(problems, limit = 5) {
	const shown = problems.slice(0, limit).join("\n  ");
	return problems.length > limit ? `${shown}\n  ... and ${problems.length - limit} more` : shown;
}

export { CAPTION_PLACES, KINDS, FOCUS_BOXES, FOCUS_MODES };
