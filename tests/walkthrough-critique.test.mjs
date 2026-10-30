/**
 * wv film critique: the frames, the sound picture and the shot list that a
 * fresh reviewer gets, from the rendered film and its whole-frame timing.
 * The end-to-end packet (ffmpeg on a real film) runs with WV_INTEGRATION=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { anchorScale, clipSheetFrames, clipText, critiqueFrames, critiqueBrief, cueList, loadAnchors, loudnessArgs, MAX_ANCHORS, planBrief, planTable, selectArgs, shotFrames, shotTable, waveArgs, writeCritique, writePlanCritique } from "../skills/walkthrough-video/scripts/film/critique.mjs";

const FILM = {
	title: "T",
	shots: [
		{ id: "a", scene: "claim", what: "the promise", text: "Hi" },
		{ id: "b", scene: "product", what: "the proof", holds: [[0.5, 1]] },
		{ id: "c", scene: "end", what: "end card" },
	],
	cues: [{ sound: "land", t: 2.25, shot: "b" }, { sound: "end", t: 4.1, shot: "c", peak: -12 }],
	timing: {
		fps: 60,
		width: 1920,
		height: 1080,
		duration: 5,
		frames: 300,
		shots: [
			{ id: "a", start: 0, end: 2, startFrame: 0, endFrame: 120 },
			{ id: "b", start: 2, end: 4, startFrame: 120, endFrame: 240 },
			{ id: "c", start: 4, end: 5, startFrame: 240, endFrame: 300 },
		],
	},
};

test("each cut gets the two frames before it, the cut frame and the two after it", () => {
	const { cuts } = critiqueFrames(FILM.timing);
	assert.equal(cuts.length, 2);
	assert.deepEqual(cuts[0].frames, [118, 119, 120, 121, 122]);
	assert.equal(cuts[0].from, "a");
	assert.equal(cuts[0].to, "b");
	assert.deepEqual(cuts[1].frames, [238, 239, 240, 241, 242]);
});

test("the timeline samples the film evenly, at most 48 cells, and names the shot of each", () => {
	const { timeline } = critiqueFrames(FILM.timing);
	assert.equal(timeline[0].frame, 0);
	assert.equal(timeline[1].frame - timeline[0].frame, 15);
	assert.equal(timeline.at(-1).frame, 299);
	assert.equal(timeline.find((c) => c.frame === 150).shot, "b");
	const long = critiqueFrames({ ...FILM.timing, duration: 90, frames: 5400, shots: [{ id: "x", start: 0, end: 90, startFrame: 0, endFrame: 5400 }] });
	assert.ok(long.timeline.length <= 48);
	assert.equal(long.cuts.length, 0);
});

test("one select pass takes every wanted frame, in order, without duplicates", () => {
	const args = selectArgs({ video: "f.mp4", frames: [3, 1, 3, 2], width: 480, dir: "/d" });
	const vf = args[args.indexOf("-vf") + 1];
	assert.match(vf, /^select='eq\(n\\,1\)\+eq\(n\\,2\)\+eq\(n\\,3\)',scale=480:-2$/);
	assert.ok(args.includes("passthrough"));
	assert.equal(args.at(-1), "/d/%04d.png");
});

test("the sound picture marks each cue and each cut at its time", () => {
	const args = waveArgs({ audio: "m.wav", out: "w.png", duration: 5, cues: FILM.cues, cuts: [2, 4], width: 1000, height: 200 });
	const graph = args[args.indexOf("-filter_complex") + 1];
	assert.match(graph, /showwavespic=s=1000x200/);
	assert.match(graph, /drawbox=x=450:y=0:w=2:h=200:color=0xff5040/);
	assert.match(graph, /drawbox=x=400:y=0:w=2:h=200:color=0x40a0ff/);
	const odd = waveArgs({ audio: "m.wav", out: "w.png", duration: 9, cues: [], cuts: [4], width: 1600, height: 240 });
	assert.match(odd[odd.indexOf("-filter_complex") + 1], /drawbox=x=712:/);
	assert.match(graph, /drawbox=x=800:/);
});

test("the shot list gives times, lengths, intent and the planned holds", () => {
	const table = shotTable(FILM);
	assert.match(table, /\| a \| claim \| 0\.00 \| 2\.00 \| the promise \|/);
	assert.match(table, /\| b \| product \| 2\.00 \| 2\.00 \| the proof \| 0\.5-1 \|/);
	assert.match(table, /land 2\.25/);
});

test("the brief carries the reviewer's instructions, the taste text and the file list", () => {
	const brief = critiqueBrief({ taste: "# Taste\nrule", files: ["timeline.jpg", "cuts.jpg"] });
	assert.match(brief, /fresh reviewer/i);
	assert.match(brief, /P0/);
	assert.match(brief, /- timeline\.jpg/);
	assert.ok(brief.indexOf("# Taste") > brief.indexOf("P0"));
});

test("the brief asks about the bed only when the film has one, and caps a film without one", () => {
	const withBed = critiqueBrief({ taste: "t", files: [], music: { bed: true } });
	assert.match(withBed, /bed there from the first frame to the last/);
	assert.doesNotMatch(withBed, /scores 5 or less/);
	const without = critiqueBrief({ taste: "t", files: [], music: { bed: false, none: "the owner asked for app sounds only" } });
	assert.doesNotMatch(without, /bed there from the first frame/);
	assert.match(without, /complete and alive/);
	assert.match(without, /no music bed/i);
	assert.match(without, /the owner asked for app sounds only/);
	assert.match(without, /5 or less unless/);
});

test("the brief starts with a cold read, names each anchor and the scale rules, and makes a rejected sound P0", () => {
	const anchors = [
		{ name: "pointer-golden", score: 7, note: "owner score 2026-10-29", folder: "7-pointer-golden" },
		{ name: "pointer-gate", score: 4, note: "", folder: "4-pointer-gate" },
	];
	const brief = critiqueBrief({ taste: "t", files: [], music: { bed: true }, anchors, tasteDate: "2026-10-29T17:00:00Z" });
	assert.match(brief, /cold\//);
	assert.match(brief, /Before you read `shots\.md`/);
	assert.match(brief, /what is the product, its promise and the best moment/i);
	assert.match(brief, /`anchors\/7-pointer-golden\/`: "pointer-golden", owner score 7 \(owner score 2026-10-29\)/);
	assert.match(brief, /`anchors\/4-pointer-gate\/`: "pointer-gate", owner score 4\./);
	assert.ok(brief.indexOf("7-pointer-golden") < brief.indexOf("4-pointer-gate"), "high to low");
	assert.match(brief, /worse than an anchor in two of the four scores less than that anchor/);
	assert.match(brief, /more than an anchor only when it is better in two of the four and worse in none/);
	assert.match(brief, /Against the anchors/);
	assert.doesNotMatch(brief, /`anchor\/`/);
	assert.match(brief, /\*\*P0\*\*[^\n]*\n[^\n]*\n[^\n]*rejected/);
	assert.match(brief, /frames\//);
	assert.match(brief, /2026-10-29T17:00:00Z/);
	assert.match(critiqueBrief({ taste: "t", files: [], music: { bed: true } }), /No anchor film is set/);
});

test("the packet has the first, middle and last frame of every shot at full size", () => {
	const list = shotFrames(FILM.timing);
	assert.deepEqual(list.slice(0, 3), [{ shot: "a", which: "first", frame: 0 }, { shot: "a", which: "mid", frame: 60 }, { shot: "a", which: "last", frame: 119 }]);
	assert.equal(list.length, 9);
});

test("the loudness picture draws the -30 LUFS line, each cue and each cut", () => {
	const args = loudnessArgs({ points: [{ t: 0.5, m: -20 }, { t: 1, m: -45 }], duration: 5, cues: [{ t: 2.25 }], cuts: [2, 4], out: "/o/l.png" });
	const graph = args[args.indexOf("-vf") + 1] ?? args.join(" ");
	assert.match(args.join(" "), /color=0xff5040/);
	assert.match(args.join(" "), /color=0x40a0ff/);
	assert.match(args.join(" "), /color=0xffd040/, "the -30 LUFS line");
	assert.equal(args.at(-1), "/o/l.png");
	assert.ok(graph.length > 0);
});

test("the cue list names each cue's sound file from the mix report", () => {
	const text = cueList(FILM.cues, { cues: [{ t: 2.25, sound: "land", file: "land-02.wav", peak: -18 }, { t: 4.1, sound: "end", file: "end.wav", peak: -12 }] });
	assert.match(text, /2\.25 s.*land-02\.wav/);
	assert.match(text, /4\.10 s.*end\.wav/);
	assert.match(cueList(FILM.cues, null), /no mix report/);
});

test("anchors come from a folder with anchors.json, not from the package", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-anchor-"));
	try {
		writeFileSync(join(dir, "golden.mp4"), "x");
		writeFileSync(join(dir, "anchors.json"), JSON.stringify([{ file: "golden.mp4", score: 7, name: "pointer-golden", note: "owner score" }]));
		const [anchor] = loadAnchors({ WV_ANCHORS: dir });
		assert.equal(anchor.score, 7);
		assert.equal(anchor.file, join(dir, "golden.mp4"));
		assert.deepEqual(loadAnchors({ WV_ANCHORS: join(dir, "missing") }), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("all anchors load high to low, each with its own packet folder", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-anchor-"));
	try {
		for (const f of ["gate.mp4", "golden.mp4", "flight.mp4", "twin.mp4"]) writeFileSync(join(dir, f), "x");
		writeFileSync(
			join(dir, "anchors.json"),
			JSON.stringify([
				{ file: "golden.mp4", score: 7, name: "Pointer golden film" },
				{ file: "gate.mp4", score: 4, name: "Pointer gate film" },
				{ file: "gone.mp4", score: 9, name: "missing file" },
				{ file: "flight.mp4", score: 5, name: "Earth Flight / test 2" },
				{ file: "twin.mp4", score: 5, name: "Earth Flight  test 2" },
			]),
		);
		const list = loadAnchors({ WV_ANCHORS: dir });
		assert.deepEqual(list.map((a) => a.score), [7, 5, 5, 4]);
		assert.deepEqual(list.map((a) => a.folder), ["7-pointer-golden-film", "5-earth-flight-test-2", "5-earth-flight-test-2-3", "4-pointer-gate-film"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a long anchor list keeps at most MAX_ANCHORS, spread from the highest score to the lowest", () => {
	const list = [9, 8, 7, 6, 5, 4, 3, 2].map((score) => ({ score, name: `s${score}` }));
	assert.deepEqual(anchorScale(list).map((a) => a.score), [9, 7, 4, 2]);
	assert.equal(anchorScale(list).length, MAX_ANCHORS);
	assert.deepEqual(anchorScale(list.slice(0, 3)).map((a) => a.score), [9, 8, 7]);
	assert.deepEqual(anchorScale([]), []);
	assert.deepEqual(anchorScale(list, 1).map((a) => a.score), [9], "one anchor is the highest");
	assert.deepEqual(anchorScale(list, 0), []);
});

test("writeCritique makes the whole packet from a real film (WV_INTEGRATION=1)", { skip: process.env.WV_INTEGRATION !== "1" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-critique-"));
	try {
		mkdirSync(join(dir, "out"));
		const video = join(dir, "out", "film-sound.mp4");
		const make = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60:duration=5", "-f", "lavfi", "-i", "sine=f=440:duration=5", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
		assert.equal(make.status, 0, String(make.stderr));
		writeFileSync(join(dir, "out", "film.json"), JSON.stringify(FILM));
		// The anchor is a film the owner scored, from the user's folder.
		const anchors = join(dir, "anchors");
		mkdirSync(anchors);
		for (const f of ["a.mp4", "b.mp4"]) spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=60:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(anchors, f)]);
		writeFileSync(join(anchors, "anchors.json"), JSON.stringify([{ file: "b.mp4", score: 4, name: "gate" }, { file: "a.mp4", score: 7, name: "golden" }]));
		const saved = process.env.WV_ANCHORS;
		process.env.WV_ANCHORS = anchors;
		let result;
		try {
			result = await writeCritique(dir, { video, check: false, measure: false, taste: "# Taste" });
		} finally {
			if (saved === undefined) delete process.env.WV_ANCHORS;
			else process.env.WV_ANCHORS = saved;
		}
		for (const name of ["cold/timeline.jpg", "cold/cuts.jpg", "cold/film.mp4", "sound.png", "loudness.png", "cues.txt", "shots.md", "brief.md", "films.md", "frames/a-first.jpg", "frames/c-last.jpg", "anchors/7-golden/timeline.jpg", "anchors/7-golden/film.mp4", "anchors/4-gate/timeline.jpg", "anchors/4-gate/film.mp4"]) assert.ok(existsSync(join(result.dir, name)), name);
		const brief = readFileSync(join(result.dir, "brief.md"), "utf8");
		assert.match(brief, /cold\/cuts\.jpg/);
		assert.match(brief, /`anchors\/7-golden\/`: "golden", owner score 7/);
		assert.match(brief, /`anchors\/4-gate\/`: "gate", owner score 4/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A plan: a claim, a footage shot on a clip, an end card. */
const PLAN = {
	...FILM,
	family: { middle: "flight shots need time" },
	proof: { shot: "b", action: "press 7" },
	shots: [FILM.shots[0], { ...FILM.shots[1], clip: { src: "assets/fly.mp4", from: 1.5 }, follow: "b" }, FILM.shots[2]],
};
const FLY = {
	fps: 30,
	frames: 150,
	events: [{ kind: "key", name: "speed", startFrame: 60, endFrame: 60, settleFrame: 70 }, { kind: "wait", name: "fly", startFrame: 70, endFrame: 100, settleFrame: 100 }],
	texts: [{ f: 30, items: [{ text: "216", selector: "b" }, { text: "km/h", selector: "span" }] }, { f: 70, items: [{ text: "900", selector: "b" }] }, { f: 120, items: [{ text: "905", selector: "b" }] }],
};

test("the plan table gives each shot's planned time, length, intent and the part of its clip, then the pace and the proof", () => {
	const md = planTable(PLAN, new Map([["b", { fps: 30, frames: 150, events: FLY }]]));
	assert.match(md, /\| b \| product \| 2\.00 \| 2\.00 \| the proof \| assets\/fly\.mp4 1\.50 to 3\.50 s \|/);
	assert.match(md, /cuts a minute/);
	assert.match(md, /middle.*flight shots need time/);
	assert.match(md, /Proof: shot "b": press 7/);
	assert.match(md, /key "speed" at 2\.00 s/);
});

test("a clip sheet takes even steps over the part of the clip that the shot shows", () => {
	const cells = clipSheetFrames({ from: 1.5, to: 3.5, fps: 30, frames: 150, cells: 5 });
	assert.deepEqual(cells.map((c) => c.frame), [45, 60, 75, 89, 104]);
	assert.equal(cells[0].shotT, 0);
	assert.equal(cells.at(-1).clipT.toFixed(2), "3.47");
	// A clip shorter than the shot stops at its last frame.
	assert.equal(clipSheetFrames({ from: 4, to: 6, fps: 30, frames: 150, cells: 4 }).at(-1).frame, 149);
});

test("the clip text gives each sample in the shot with its times, and the inputs", () => {
	const text = clipText(FLY, { from: 1.5, to: 3.5 });
	assert.match(text, /shot 0\.83 s \| clip 2\.33 s: "900" \(b\)/);
	assert.doesNotMatch(text, /216/);
	assert.match(text, /input key "speed" at clip 2\.00 s \(shot 0\.50 s\)/);
});

test("the plan brief asks for the story, the proof, the subject size, the motion, the family and the strongest moment", () => {
	const brief = planBrief({ taste: "# Taste\n\nOwner note.", files: ["plan.md: the plan"] });
	for (const word of [/story/i, /proof of control/i, /subject size/i, /motion/i, /family/i, /strongest moment/i, /films\.md/, /plan\.md: the plan/, /Owner note\./]) assert.match(brief, word);
});

test("writePlanCritique makes the plan packet from the storyboard and the clips, with no render (WV_INTEGRATION=1)", { skip: process.env.WV_INTEGRATION !== "1" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-plan-"));
	try {
		mkdirSync(join(dir, "out"));
		mkdirSync(join(dir, "assets"));
		const make = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "assets", "fly.mp4")]);
		assert.equal(make.status, 0, String(make.stderr));
		writeFileSync(join(dir, "assets", "fly.events.json"), JSON.stringify(FLY));
		writeFileSync(join(dir, "out", "film.json"), JSON.stringify(PLAN));
		writeFileSync(join(dir, "out", "advice.json"), JSON.stringify([{ kind: "plateau", message: "m", fix: "f" }]));
		const result = await writePlanCritique(dir, { taste: "# Taste" });
		assert.match(result.dir, /plan-1$/);
		for (const name of ["plan.md", "clips/b.jpg", "clips/b.txt", "advice.txt", "films.md", "brief.md"]) assert.ok(existsSync(join(result.dir, name)), name);
		assert.match(readFileSync(join(result.dir, "advice.txt"), "utf8"), /advice plateau: m/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
