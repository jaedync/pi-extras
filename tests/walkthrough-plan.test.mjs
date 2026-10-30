/**
 * The plan advice: what the storyboard and the captured clips say before the
 * first render. Advice only: the family, the planned pace, the proof shot.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { familyBands, followSeries, formatAdvice, loadClipEvents, planAdvice, plannedPace, plateaus } from "../skills/walkthrough-video/scripts/film/plan.mjs";
import { normalizeStoryboard } from "../skills/walkthrough-video/scripts/film/storyboard.mjs";

/** film2 round 3: 6 shots in 25 s, 12 cuts a minute. */
const film2 = (extra = {}) => ({
	fps: 30,
	shots: [
		{ id: "open", scene: "title", seconds: 2.4 },
		{ id: "city", scene: "footage", seconds: 2.4, clip: { src: "assets/city.mp4", from: 5.4 } },
		{ id: "alps", scene: "footage", seconds: 5.6, clip: { src: "assets/alpsbank.mp4", from: 5.3 } },
		{ id: "himal", scene: "footage", seconds: 4.8, clip: { src: "assets/mach10.mp4", from: 6.6 } },
		{ id: "orbit", scene: "footage", seconds: 4.6, clip: { src: "assets/orbit2.mp4", from: 5.6 } },
		{ id: "end", scene: "end", seconds: 5.2 },
	],
	...extra,
});

/** A clip's events: a key press at frame 139 (4.63 s at 30 fps), then waits. */
const orbitEvents = {
	fps: 30,
	frames: 307,
	events: [
		{ kind: "goto", name: "open", startFrame: 0, endFrame: 30, settleFrame: 39 },
		{ kind: "key", name: "speed", startFrame: 139, endFrame: 139, settleFrame: 149 },
		{ kind: "wait", name: "fly", startFrame: 149, endFrame: 179, settleFrame: 179 },
	],
	texts: [],
};

const kinds = (advice) => advice.map((a) => a.kind);

test("the reference films give the family bands: one-take under 3 cuts a minute, montage from 27", () => {
	const bands = familyBands();
	assert.ok(bands.oneTakeMax >= 2.2 && bands.oneTakeMax <= 3, `oneTakeMax ${bands.oneTakeMax}`);
	assert.ok(bands.montageMin >= 27 && bands.montageMin <= 27.1, `montageMin ${bands.montageMin}`);
	assert.equal(bands.total, 12);
	assert.equal(bands.between.count, 4);
});

test("the planned pace comes from the storyboard: cuts a minute, median, CV and the band", () => {
	const pace = plannedPace(normalizeStoryboard(film2()));
	assert.equal(pace.cuts, 5);
	assert.equal(pace.cutsPerMin, 12);
	assert.equal(pace.shotMedianS, 4.7);
	assert.equal(pace.band, "middle");
	assert.equal(plannedPace(normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 30 }] })).band, "one-take");
	assert.equal(plannedPace(normalizeStoryboard({ fps: 30, shots: Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, seconds: 2 })) })).band, "montage");
});

test("a storyboard with no family, a middle pace and no proof gets three advice lines", () => {
	const advice = planAdvice({ norm: normalizeStoryboard(film2()), clips: new Map() });
	assert.deepEqual(kinds(advice), ["family", "pace", "proof"]);
	assert.match(advice[1].message, /12\.0 cuts a minute.*middle/);
	assert.match(advice[1].message, /few good films sit between/i);
	assert.match(advice[1].message, /4 of 12 reference films/);
	for (const a of advice) assert.ok(a.fix, `${a.kind} has a fix`);
});

test("a middle family with a reason, and a proof whose clip shows the input, give no advice", () => {
	const norm = normalizeStoryboard(film2({ family: { middle: "flight shots need 2.4 to 3 s" }, proof: { shot: "orbit", action: "press 7 for Mach 20" } }));
	const shifted = { ...orbitEvents, events: orbitEvents.events.map((e) => (e.kind === "key" ? { ...e, startFrame: 180, endFrame: 180 } : e)) };
	assert.deepEqual(planAdvice({ norm, clips: new Map([["orbit", shifted]]) }), []);
});

test("a declared family that the planned pace does not match is advice", () => {
	const advice = planAdvice({ norm: normalizeStoryboard(film2({ family: "montage", proof: { shot: "end", action: "x" } })), clips: new Map() });
	assert.equal(advice[0].kind, "pace");
	assert.match(advice[0].message, /montage/);
});

test("a proof shot whose clip has its input before the shot starts is advice, with the input's time", () => {
	const norm = normalizeStoryboard(film2({ family: { middle: "flight" }, proof: { shot: "orbit", action: "press 7 for Mach 20" } }));
	const [a] = planAdvice({ norm, clips: new Map([["orbit", orbitEvents]]) });
	assert.equal(a.kind, "proof");
	assert.match(a.message, /orbit/);
	assert.match(a.message, /5\.60 to 10\.20 s/);
	assert.match(a.message, /key "speed" at 4\.63 s/);
});

test("the storyboard refuses a wrong family or a proof of an unknown shot", () => {
	assert.throws(() => normalizeStoryboard(film2({ family: "fast" })), /family/);
	assert.throws(() => normalizeStoryboard(film2({ family: { middle: " " } })), /family.*reason/);
	assert.throws(() => normalizeStoryboard(film2({ proof: { shot: "nope", action: "x" } })), /proof.*nope/);
	assert.throws(() => normalizeStoryboard(film2({ proof: { shot: "orbit" } })), /proof.*action/);
	const norm = normalizeStoryboard(film2({ family: "one-take", proof: { shot: "orbit", action: "a" } }));
	assert.equal(norm.family, "one-take");
	assert.deepEqual(norm.proof, { shot: "orbit", action: "a" });
});

test("clip events load from beside each clip, and the advice prints as advice and Fix lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-plan-"));
	try {
		mkdirSync(join(dir, "assets"));
		writeFileSync(join(dir, "assets", "orbit2.events.json"), JSON.stringify(orbitEvents));
		const clips = loadClipEvents(dir, normalizeStoryboard(film2()));
		assert.deepEqual([...clips.keys()], ["orbit"]);
		assert.equal(clips.get("orbit").frames, 307);
		const text = formatAdvice([{ kind: "proof", message: "m", fix: "f" }]);
		assert.equal(text, "advice proof: m\n  Fix: f");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** The alpsbank capture's HUD readout ("b") at each settle: it climbs to 900 and stops. */
const alpsEvents = {
	fps: 30,
	frames: 328,
	events: [{ kind: "key", name: "speed", startFrame: 138, endFrame: 138, settleFrame: 162 }],
	texts: [
		[129, "1"], [162, "663"], [211, "884"], [241, "897"], [271, "899"], [301, "900"], [325, "900"],
	].map(([f, v]) => ({ f, items: [{ text: "Zermatt", selector: "div", px: 22 }, { text: v, selector: "b", px: 63.6 }, { text: "km/h", selector: "span", px: 15.6 }] })),
};

test("a followed value is a time series of numbers from the clip's text samples", () => {
	const series = followSeries(alpsEvents, "b");
	assert.equal(series.length, 7);
	assert.deepEqual(series[1], { t: 162 / 30, v: 663 });
	assert.deepEqual(followSeries({ fps: 30, texts: [{ f: 30, items: [{ text: "12,348", selector: "b" }] }] }, "b"), [{ t: 1, v: 12348 }]);
	assert.deepEqual(followSeries({ fps: 30, texts: [{ f: 30, items: [{ text: "MACH 9.89", selector: "div" }] }] }, { match: "^MACH" }), [{ t: 1, v: 9.89 }]);
});

test("a value that stays within 1 % for over 1 s while the shot is on screen is a plateau", () => {
	const series = followSeries(alpsEvents, "b");
	const [p] = plateaus(series, { from: 5.3, to: 10.9, end: 328 / 30 });
	assert.ok(p, "a plateau");
	assert.equal(p.from, 241 / 30);
	assert.equal(p.to, 10.9);
	assert.equal(p.value, 897);
	assert.equal(plateaus(series, { from: 5.3, to: 7.5, end: 328 / 30 }).length, 0);
});

test("a shot that follows its HUD readout gets plateau advice with the shot times", () => {
	const sb = film2({ family: "one-take", proof: { shot: "alps", action: "bank" } });
	sb.shots[2] = { ...sb.shots[2], follow: "b" };
	const norm = normalizeStoryboard(sb);
	const advice = planAdvice({ norm, clips: new Map([["alps", alpsEvents]]) }).filter((a) => a.kind === "plateau");
	assert.equal(advice.length, 1);
	assert.match(advice[0].message, /shot "alps".*897.*2\.87 s.*2\.73 to 5\.60 s/);
	assert.match(advice[0].fix, /cut/);
});

test("a followed value with too few samples in the shot asks for an interval capture", () => {
	const sb = film2({ family: "one-take", proof: { shot: "alps", action: "bank" } });
	sb.shots[2] = { ...sb.shots[2], follow: "b" };
	const sparse = { ...alpsEvents, texts: alpsEvents.texts.filter((t) => t.f < 200) };
	const [a] = planAdvice({ norm: normalizeStoryboard(sb), clips: new Map([["alps", sparse]]) }).filter((x) => x.kind === "follow");
	assert.ok(a);
	assert.match(a.fix, /--text-every/);
});
