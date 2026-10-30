/**
 * The plan advice: what the storyboard and the captured clips already say
 * before the first render. The film2 author saw a middle pace, a small flyer
 * and no proof of control in the contact sheets and the storyboard numbers,
 * but the kit looked only after the render, and three critics named the same
 * three. Advice, not defects: each line is a question for the director.
 *
 * - family: the storyboard does not say which family it is in.
 * - pace: the planned pace sits between the families without a reason, or
 *   outside the band of the family it names.
 * - proof: no shot shows the viewer doing the product's key action, or the
 *   proof shot's clip has no input while the shot is on screen.
 * - plateau: a value that the shot follows (a HUD readout in the clip's
 *   text samples) stops for over 1 s while the shot is on screen. film2's
 *   readout sat within 0.4 % for 2 to 2.9 s in three of its four climb shots,
 *   and the third critic named it first.
 * - follow: the followed value has too few samples in the shot to tell.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shotStats } from "./measure.mjs";

const FILMS = JSON.parse(readFileSync(new URL("../../references/films.json", import.meta.url), "utf8"));

/** Event kinds that are a viewer's input: the action of a proof shot. */
export const INPUT_KINDS = new Set(["click", "type", "key", "scroll"]);

/** The family bands from the reference films: cuts a minute of each family. */
export function familyBands(films = FILMS.films) {
	const of = (family) => films.filter((f) => f.family === family).map((f) => f.cuts_per_min);
	const montage = of("montage");
	const oneTake = of("one-take");
	const between = of("between");
	return {
		oneTakeMax: Math.ceil(Math.max(...oneTake)),
		montageMin: Math.floor(Math.min(...montage) * 10) / 10,
		montage: [Math.min(...montage), Math.max(...montage)],
		between: { count: between.length, min: Math.min(...between), max: Math.max(...between) },
		total: films.length,
	};
}

/** The pace that the storyboard plans: cuts a minute, shot median and CV, and its band. */
export function plannedPace(norm, bands = familyBands()) {
	const stats = shotStats(norm.shots.map((s) => (s.endFrame - s.startFrame) / norm.fps), norm.frames / norm.fps);
	const band = stats.cutsPerMin <= bands.oneTakeMax ? "one-take" : stats.cutsPerMin >= bands.montageMin ? "montage" : "middle";
	return { ...stats, band };
}

const s2 = (n) => n.toFixed(2);

/** The part of a clip that a shot shows, in clip seconds. */
export function clipWindow(shot, fps) {
	const from = Number(shot.params?.clip?.from ?? 0);
	return { from, to: from + (shot.endFrame - shot.startFrame) / fps };
}

/** The inputs of a capture (click, type, key, scroll) with their time in clip seconds. */
export function inputEvents(events) {
	const fps = events?.fps || 60;
	return (events?.events ?? []).filter((e) => INPUT_KINDS.has(e.kind)).map((e) => ({ kind: e.kind, name: e.name ?? "", t: e.startFrame / fps }));
}

/** A plateau: the value stays within `tolerance` of itself for minS; a followed value needs a sample every sampleEveryS. */
export const PLATEAU = { tolerance: 0.01, minS: 1, sampleEveryS: 1.5 };

/** The first number in a text: "12,348" is 12348, "MACH 9.89" is 9.89. */
function numberIn(text) {
	const m = /-?\d[\d,]*(?:\.\d+)?/.exec(String(text));
	return m ? Number(m[0].replace(/,/g, "")) : null;
}

/**
 * The time series of a followed value: one number per text sample of the
 * clip, in clip seconds. `follow` is a selector ("b") or { selector, match }
 * (match is a regular expression on the text).
 */
export function followSeries(events, follow) {
	const spec = typeof follow === "string" ? { selector: follow } : (follow ?? {});
	const re = spec.match ? new RegExp(spec.match) : null;
	const fps = events?.fps || 60;
	const out = [];
	for (const snap of events?.texts ?? []) {
		const item = snap.items.find((i) => (!spec.selector || i.selector === spec.selector) && (!re || re.test(i.text)) && numberIn(i.text) !== null);
		if (item) out.push({ t: snap.f / fps, v: numberIn(item.text) });
	}
	return out.sort((a, b) => a.t - b.t);
}

/**
 * The longest stretch inside [from, to] (clip seconds) where the value stays
 * within `tolerance` of itself, if it lasts minS or more. The last sample of
 * the capture holds to its end. Returns [] or [{ from, to, value, last }].
 */
export function plateaus(series, { from, to, end = Infinity, tolerance = PLATEAU.tolerance, minS = PLATEAU.minS }) {
	let best = null;
	for (let i = 0; i < series.length; i++) {
		let lo = series[i].v;
		let hi = series[i].v;
		let j = i;
		while (j + 1 < series.length) {
			const v = series[j + 1].v;
			const nlo = Math.min(lo, v);
			const nhi = Math.max(hi, v);
			if (nhi - nlo > tolerance * Math.max(Math.abs(nlo), Math.abs(nhi))) break;
			lo = nlo;
			hi = nhi;
			j++;
		}
		const a = Math.max(from, series[i].t);
		const b = Math.min(to, j === series.length - 1 ? end : series[j].t);
		if (b - a >= minS - 1e-9 && (!best || b - a > best.to - best.from)) best = { from: a, to: b, value: series[i].v, last: series[j].v };
	}
	return best ? [best] : [];
}

function followAdvice(norm, clips) {
	const out = [];
	for (const shot of norm.shots) {
		const follow = shot.params?.follow;
		if (follow === undefined || !shot.params?.clip) continue;
		const events = clips.get(shot.id);
		const name = JSON.stringify(typeof follow === "string" ? follow : (follow.selector ?? follow.match));
		if (!events) {
			out.push({ kind: "follow", shot: shot.id, message: `shot "${shot.id}" follows ${name}, but its clip has no events.json beside it`, fix: "copy the capture's events.json beside the clip (assets/<clip>.events.json)" });
			continue;
		}
		const win = clipWindow(shot, norm.fps);
		const series = followSeries(events, follow);
		const inside = series.filter((p) => p.t >= win.from && p.t <= win.to).length;
		if (inside < Math.max(2, Math.ceil((win.to - win.from) / PLATEAU.sampleEveryS))) {
			out.push({ kind: "follow", shot: shot.id, message: `shot "${shot.id}" follows ${name}, but its clip has ${inside} sample(s) of it in clip time ${s2(win.from)} to ${s2(win.to)} s, too few to see if it stops`, fix: "capture again with wv capture --text-every 250 (a text sample every 250 ms), or wait in 1 s steps in the flow" });
			continue;
		}
		for (const p of plateaus(series, { from: win.from, to: win.to, end: (events.frames ?? Infinity) / (events.fps || 60) }))
			out.push({ kind: "plateau", shot: shot.id, message: `shot "${shot.id}": the followed value ${name} stays at ${p.value} to ${p.last} (within ${Math.round(PLATEAU.tolerance * 100)} %) for ${s2(p.to - p.from)} s, shot time ${s2(p.from - win.from)} to ${s2(p.to - win.from)} s: the climb stops while the shot is on screen`, fix: `cut the shot when the value stops (about ${s2(p.from - win.from + 0.3)} s), move clip.from later, or say in the shot's what line why the stop is the point` });
	}
	return out;
}

function familyAdvice(norm, pace, bands) {
	const out = [];
	const between = `taste.md section 2: few good films sit between the families, because a middle pace reads as neither energy nor calm. ${bands.between.count} of ${bands.total} reference films are "between" (${bands.between.min} to ${bands.between.max} cuts a minute)`;
	const planned = `the planned pace is ${pace.cutsPerMin.toFixed(1)} cuts a minute (shot median ${s2(pace.shotMedianS)} s, CV ${s2(pace.shotCv)})`;
	const bandName = pace.band === "middle" ? `the middle band (${bands.oneTakeMax} to ${bands.montageMin} cuts a minute)` : `the ${pace.band} band`;
	if (norm.family === null)
		out.push({ kind: "family", message: `the storyboard names no family; ${planned}, in ${bandName}`, fix: 'pick the family first: family: "montage" (27 to 38 cuts a minute, shots of 0.6 to 1.6 s), "one-take" (0 to 2 cuts, the camera travels in a held frame), or { middle: "<the reason>" }' });
	const declared = typeof norm.family === "object" && norm.family ? "middle" : norm.family;
	if (declared && declared !== "middle" && declared !== pace.band)
		out.push({ kind: "pace", message: `the storyboard says family "${declared}", but ${planned}, in ${bandName}${pace.band === "middle" ? `. ${between}` : ""}`, fix: `change the shot lengths to the ${declared} band, or change the family` });
	else if (pace.band === "middle" && !declared)
		out.push({ kind: "pace", message: `${planned}: the middle band, with no reason in the storyboard. ${between}`, fix: 'cut faster toward a montage or hold longer toward a one-take; or say why in family: { middle: "<the reason>" }' });
	return out;
}

function proofAdvice(norm, clips) {
	if (!norm.proof)
		return [{ kind: "proof", message: "the storyboard names no proof shot: no shot is marked as the viewer doing the product's key action, and a film with only results gives no proof of control", fix: 'add proof: { shot: "<id>", action: "<the key action>" }, and capture a take that shows the input and its effect (a key, a click, a drag) on screen' }];
	const shot = norm.shots.find((s) => s.id === norm.proof.shot);
	if (!shot.params?.clip) return [];
	const events = clips.get(shot.id);
	if (!events) return [{ kind: "proof", shot: shot.id, message: `proof shot "${shot.id}" has a clip with no events.json beside it, so the kit cannot see its input`, fix: "copy the capture's events.json beside the clip (assets/<clip>.events.json)" }];
	const win = clipWindow(shot, norm.fps);
	const inputs = inputEvents(events);
	if (inputs.some((e) => e.t >= win.from - 1e-6 && e.t <= win.to + 1e-6)) return [];
	const near = inputs.length ? `; its inputs: ${inputs.map((e) => `${e.kind} "${e.name}" at ${s2(e.t)} s`).join(", ")}` : "; the clip has no input at all";
	return [{ kind: "proof", shot: shot.id, message: `proof shot "${shot.id}" ("${norm.proof.action}") shows clip time ${s2(win.from)} to ${s2(win.to)} s, and no input happens in it${near}`, fix: "move clip.from so the shot opens just before the input, or capture a take where the input and its effect are both on screen" }];
}

/**
 * Every plan advice line for a storyboard and its clips' events (a map from
 * shot id to the parsed events.json).
 * @param {{norm: any, clips: Map<string, any>}} options
 */
export function planAdvice({ norm, clips }) {
	const bands = familyBands();
	const pace = plannedPace(norm, bands);
	return [...familyAdvice(norm, pace, bands), ...proofAdvice(norm, clips), ...followAdvice(norm, clips)];
}

/** The events.json beside each shot's clip (assets/<clip>.events.json), by shot id; a clip without one is left out. */
export function loadClipEvents(dir, norm) {
	const out = new Map();
	for (const shot of norm.shots) {
		const src = shot.params?.clip?.src;
		if (typeof src !== "string") continue;
		const file = join(dir, src.replace(/\.[^./]+$/, "") + ".events.json");
		if (existsSync(file)) out.set(shot.id, JSON.parse(readFileSync(file, "utf8")));
	}
	return out;
}

/** Advice lines as the commands print them: one advice line and one Fix line each. */
export function formatAdvice(advice) {
	return advice.map((a) => `advice ${a.kind}: ${a.message}\n  Fix: ${a.fix}`).join("\n");
}
