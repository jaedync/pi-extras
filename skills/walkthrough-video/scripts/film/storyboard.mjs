/**
 * The storyboard is the one source of timing for a film. The author writes it
 * as data (storyboard.ts, or JSON); this module turns it into whole frames:
 * each shot's start and end, the true cut list, and the frames where the
 * author asked for a still picture. wv check, wv measure, wv sound and the
 * film runtime read the same numbers.
 *
 * A shot gives its length as `seconds`, `frames` or `beats` (with a top-level
 * `bpm`). `holds: [[from, to], ...]` (seconds from the shot start) or
 * `still: true` declare a planned still picture; every other still run of
 * frames is a freeze that wv check reports.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LENGTH_KEYS = ["seconds", "frames", "beats"];

function fail(message) {
	throw new Error(`storyboard: ${message}`);
}

function positive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The length of one shot in seconds. */
function shotSeconds(shot, sb, fps) {
	const given = LENGTH_KEYS.filter((key) => shot[key] !== undefined);
	if (given.length !== 1) fail(`shot "${shot.id}" needs exactly one of seconds, frames or beats (got ${given.length ? given.join(" and ") : "none"})`);
	const key = given[0];
	const value = shot[key];
	if (!positive(value)) fail(`shot "${shot.id}" has ${key} ${JSON.stringify(value)}; it must be a number above 0`);
	if (key === "seconds") return value;
	if (key === "frames") return value / fps;
	if (!positive(sb.bpm)) fail(`shot "${shot.id}" gives its length in beats, so the storyboard needs a bpm`);
	return (value * 60) / sb.bpm;
}

/**
 * Whole-frame shots, cuts and planned holds. Shot edges are rounded from the
 * running time in seconds, so rounding never drifts across a long film.
 */
export function normalizeStoryboard(sb) {
	if (!sb || typeof sb !== "object") fail("expected an object with fps and shots");
	const fps = sb.fps ?? 60;
	if (!Number.isInteger(fps) || fps <= 0) fail(`fps must be a whole number above 0 (got ${JSON.stringify(sb.fps)}): the frame timing is whole frames, and HyperFrames renders at an integer rate`);
	for (const key of ["width", "height"]) if (sb[key] !== undefined && (!Number.isInteger(sb[key]) || sb[key] <= 0)) fail(`${key} must be a whole number of pixels above 0 (got ${JSON.stringify(sb[key])})`);
	if (!Array.isArray(sb.shots) || sb.shots.length === 0) fail("needs at least one shot");
	const offset = Number(sb.offset ?? 0) || 0;
	const seen = new Set();
	const shots = [];
	let t = offset;
	for (const [index, raw] of sb.shots.entries()) {
		if (!raw || typeof raw !== "object") fail(`shot ${index + 1} is not an object`);
		const id = String(raw.id ?? `shot${index + 1}`);
		if (seen.has(id)) fail(`has the shot id "${id}" twice`);
		seen.add(id);
		const shot = { ...raw, id };
		const start = t;
		const end = start + shotSeconds(shot, sb, fps);
		t = end;
		const startFrame = Math.round(start * fps);
		const endFrame = Math.round(end * fps);
		const holds = [];
		if (raw.still === true) holds.push([startFrame, endFrame]);
		for (const hold of raw.holds ?? []) {
			// [from, "end"] holds to the end of the shot, so a re-time keeps it.
			const ok = (v, i) => (typeof v === "number" && Number.isFinite(v)) || (i === 1 && v === "end");
			if (!Array.isArray(hold) || hold.length !== 2 || !hold.every(ok)) fail(`shot "${id}" has a hold that is not [from, to] in seconds (to may be "end")`);
			const from = hold[0];
			const to = hold[1] === "end" ? end - start : hold[1];
			if (from < 0 || to <= from || start + to > end + 1e-6) fail(`shot "${id}" has a hold from ${from} to ${to} s that is not inside the shot (0 to ${(end - start).toFixed(3)} s)`);
			holds.push([startFrame + Math.round(from * fps), startFrame + Math.round(to * fps)]);
		}
		const { id: _id, holds: _holds, still: _still, ...params } = raw;
		shots.push({ id, start: round(start), end: round(end), startFrame, endFrame, holds, params });
	}
	if (sb.music && sb.music.none !== undefined && (typeof sb.music.none !== "string" || !sb.music.none.trim())) fail('music.none must say why the film has no bed, in the owner\'s words (for example "the owner asked for app sounds only")');
	const family = sb.family ?? null;
	if (family !== null && family !== "montage" && family !== "one-take") {
		if (!family || typeof family !== "object" || !("middle" in family)) fail(`family is ${JSON.stringify(family)}; use "montage", "one-take" or { middle: "<the reason>" }`);
		if (typeof family.middle !== "string" || !family.middle.trim()) fail('family { middle } needs the reason in words (for example { middle: "each flight shot needs 2.4 s to read" })');
	}
	const proof = sb.proof ?? null;
	if (proof !== null) {
		if (!proof || typeof proof !== "object" || !seen.has(String(proof.shot))) fail(`proof.shot is ${JSON.stringify(proof?.shot)}, which is not a shot id`);
		if (typeof proof.action !== "string" || !proof.action.trim()) fail("proof needs an action: the product's key action that the shot shows, in words");
	}
	const last = shots[shots.length - 1];
	return {
		fps,
		width: sb.width ?? 1920,
		height: sb.height ?? 1080,
		duration: round(last.end),
		frames: last.endFrame,
		shots,
		cuts: shots.slice(1).map((shot) => shot.startFrame),
		holds: shots.flatMap((shot) => shot.holds),
		cues: Array.isArray(sb.cues) ? sb.cues : [],
		music: sb.music ?? null,
		family,
		proof,
	};
}

function round(value) {
	return Math.round(value * 1e6) / 1e6;
}

/**
 * Reads a storyboard from JSON, a .ts/.mjs module (its default export), a
 * built film manifest (film.json), or a film project directory. `fps` times
 * it for a render at another frame rate.
 */
export async function loadStoryboard(path, { fps = null } = {}) {
	let file = resolve(path);
	if (existsSync(file) && statSync(file).isDirectory()) {
		const candidates = [join(file, "out", "film.json"), join(file, "storyboard.ts"), join(file, "storyboard.json"), join(file, "storyboard.mjs")];
		const found = candidates.find((candidate) => existsSync(candidate));
		if (!found) fail(`no out/film.json, storyboard.ts or storyboard.json in ${file}`);
		file = found;
	}
	if (!existsSync(file)) fail(`${file} does not exist`);
	const ext = extname(file);
	let data;
	if (ext === ".json") data = JSON.parse(readFileSync(file, "utf8"));
	else if ([".ts", ".mts", ".mjs", ".js"].includes(ext)) {
		const module = await import(`${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`);
		data = module.default ?? module.storyboard;
	} else fail(`cannot read ${file}: use .json, .ts or .mjs`);
	// A preview runs at another fps than the film: the same seconds, other frames.
	return normalizeStoryboard(fps ? { ...data, fps } : data);
}
