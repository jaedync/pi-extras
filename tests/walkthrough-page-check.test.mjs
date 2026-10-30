/**
 * wv check --page: the page checks on the built film. The rules are pure
 * functions over the facts that the page collector returns; the browser
 * run is in the WV_INTEGRATION test at the end.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brandColors, clipPrivateFindings, clipTextFacts, offBrand, pageDefects, privateFindings, sampleTimes, subjectAdvice, subjectOnScreen, subjectSamples, textAt, textDefects } from "../skills/walkthrough-video/scripts/film/page-check.mjs";
import { normalizeStoryboard } from "../skills/walkthrough-video/scripts/film/storyboard.mjs";

const SB = normalizeStoryboard({ fps: 60, shots: [{ id: "a", seconds: 2 }, { id: "b", seconds: 1, smallText: true }] });

test("samples: four settled times in each shot, late in the shot", () => {
	const times = sampleTimes(SB);
	assert.deepEqual(times.filter((s) => s.shot === "a").map((s) => s.t), [0.8, 1.2, 1.6, 1.9833]);
	assert.equal(times.length, 8);
});

test("colours: brand colours and neutrals pass, a colour from nowhere fails", () => {
	const palette = brandColors({ palette: { "--bg": "#faf5f2" }, ground: { color: "#2e2320" }, accent: { color: "#d4856a" }, inksByGround: { "#2e2320": [{ color: "#c9bcae" }] } });
	assert.ok(palette.includes("#c9bcae"));
	assert.equal(offBrand("rgb(46, 35, 32)", palette), false);
	assert.equal(offBrand("rgb(214, 135, 104)", palette), false, "within a few steps of the accent");
	assert.equal(offBrand("rgb(255, 255, 255)", palette), false, "white is neutral");
	assert.equal(offBrand("rgb(128, 128, 130)", palette), false, "grey is neutral");
	assert.equal(offBrand("rgb(30, 144, 255)", palette), true);
	assert.equal(offBrand("rgba(30, 144, 255, 0.2)", palette), false, "a faint tint is not judged");
});

test("private data: addresses, local hosts, keys and home paths", () => {
	const kinds = (s) => privateFindings(s).map((f) => f.kind);
	assert.deepEqual(kinds("Copy 127.0.0.1:47811/eh4n7"), ["local address"]);
	assert.deepEqual(kinds("open http://localhost:3000/room"), ["local address"]);
	assert.deepEqual(kinds("mail maya.r@acme-corp.com"), ["email"]);
	assert.deepEqual(kinds("10.0.0.5"), ["private IP"]);
	assert.deepEqual(kinds("key sk-ant-api03-abcdefghijklmnopqrstuv"), ["secret"]);
	assert.deepEqual(kinds("ghp_0123456789abcdefghij0123456789abcdef"), ["secret"]); // gitleaks:allow: a fake token for the detector test
	assert.deepEqual(kinds("/home/user/dev/x"), ["home path"]);
	assert.deepEqual(kinds("pointer.jaedyn.me/eh4n7 and hello@example.com"), [], "a public URL and example.com are fine");
});

test("a clip's own text snapshots are checked for private data, inside the part its shot shows", () => {
	// The shot shows clip 2.00 s to 3.00 s: frames 120 to 180 of a 60 fps capture.
	const clip = {
		fps: 60,
		from: 2,
		start: 1,
		texts: [
			{ f: 100, items: [{ text: "before@trim.io" }] },
			{ f: 150, items: [{ text: "open http://localhost:3000/board" }, { text: "Board" }] },
			{ f: 175, items: [{ text: "later@acme.io" }] },
			{ f: 260, items: [{ text: "after@cut.io" }] },
		],
	};
	const shot = { id: "real", start: 1, end: 2 };
	const found = clipPrivateFindings(clip, shot, 60);
	assert.deepEqual(found.map((f) => f.match), ["localhost:3000", "later@acme.io"], "the trims and the cut hide the rest");
	assert.equal(found[0].frame, 90, "the defect sits at the film frame that shows the snapshot");
	assert.equal(found[1].frame, 115);
	assert.match(found[0].message, /shot real:/);
});

test("a content hash is not a secret unless a key word is near it, and the bundle scan skips hashes", () => {
	assert.deepEqual(privateFindings("assets 9f2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e.png"), [], "a content hash is public");
	assert.deepEqual(privateFindings("9F2C4D5E6F7A8B9C0D1E2F3A4B5C6D7E"), []);
	assert.equal(privateFindings("api key 9f2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e").length, 1, "a hash beside a key word is a secret");
	assert.equal(privateFindings("token: 9f2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e").length, 1); // gitleaks:allow: a fake token for the detector test
	assert.deepEqual(privateFindings("api key 9f2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e", { hashes: false }), [], "the bundle scan skips the hash rule");
});

const fact = (over) => ({ shot: "a", t: 1, text: "Hello", selector: "h1", px: 60, color: "rgb(255, 255, 255)", rect: { x: 100, y: 100, w: 300, h: 60 }, ...over });

test("text: small text and cut text count only when they hold for two samples", () => {
	const frame = { width: 1920, height: 1080 };
	const small = [fact({ px: 14, t: 1.2 }), fact({ px: 14, t: 1.6 })];
	const once = [fact({ text: "Pop", px: 6, t: 0.8 })];
	const cut = [fact({ text: "Wide", rect: { x: 1800, y: 100, w: 400, h: 60 }, t: 1.2 }), fact({ text: "Wide", rect: { x: 1800, y: 100, w: 400, h: 60 }, t: 1.6 })];
	const exempt = [fact({ shot: "b", px: 10, t: 2.1 }), fact({ shot: "b", px: 10, t: 2.3 })];
	const defects = textDefects([...small, ...once, ...cut, ...exempt], { frame, sb: SB });
	assert.deepEqual(defects.map((d) => d.kind), ["text_small", "text_cut"]);
	assert.match(defects[0].message, /"Hello" is 14 px/);
	assert.match(defects[1].message, /"Wide" runs out of the frame/);
});

test("clip text: the capture's text at a film time is the last snapshot at or before the clip frame", () => {
	const texts = [{ f: 0, items: [{ text: "Home" }] }, { f: 120, items: [{ text: "Form" }] }, { f: 300, items: [{ text: "Room" }] }];
	// The shot starts at 2 s and shows the clip from 1.5 s: film 3 s is clip 2.5 s, frame 150 at 60 fps.
	assert.equal(textAt(texts, { t: 3, shotStart: 2, from: 1.5, fps: 60 })?.items[0].text, "Form");
	assert.equal(textAt(texts, { t: 2, shotStart: 2, from: 0, fps: 60 })?.items[0].text, "Home");
	assert.equal(textAt([], { t: 2, shotStart: 2, from: 0, fps: 60 }), null);
});

test("clip text: capture sizes scale by the clip's width on screen, and text out of view is left out", () => {
	// A 1280x720 capture drawn 1920 px wide at x 0: 1.5 times. A 16 px label is 24 px on screen.
	const items = [
		{ text: "Your name", selector: "label", px: 16, rect: { x: 100, y: 200, w: 80, h: 20 } },
		{ text: "Create game", selector: "button", px: 22, rect: { x: 100, y: 300, w: 140, h: 30 } },
		{ text: "Footer", selector: "p", px: 12, rect: { x: 100, y: 700, w: 60, h: 14 } },
	];
	const view = { content: { x: 0, y: 0, w: 1920, h: 1080 }, visible: { x: 0, y: 0, w: 1920, h: 900 } };
	const facts = clipTextFacts(items, { view, capture: { width: 1280, height: 720 }, shot: "real", t: 3 });
	assert.deepEqual(facts.map((f) => [f.text, f.px]), [["Your name", 24], ["Create game", 33]]);
	assert.deepEqual(facts[0].rect, { x: 150, y: 300, w: 120, h: 30 });
	assert.equal(facts[0].source, "clip");
	// A push to 1.6x on the field makes the same label readable.
	const pushed = clipTextFacts(items, { view: { content: { x: -100, y: -300, w: 3072, h: 1728 }, visible: { x: 0, y: 0, w: 1920, h: 1080 } }, capture: { width: 1280, height: 720 }, shot: "real", t: 3 });
	assert.equal(pushed.find((f) => f.text === "Your name").px, 38.4);
});

test("clip text: small text in a clip fails with a fix for footage, and is never text_cut", () => {
	const frame = { width: 1920, height: 1080 };
	const clip = (over) => fact({ source: "clip", text: "Your name", px: 21, ...over });
	const defects = textDefects(
		[clip({ t: 1.2 }), clip({ t: 1.6 }), clip({ text: "Join", px: 18, t: 1.2 }), clip({ text: "Join", px: 18, t: 1.6 }), clip({ text: "Edge", px: 40, rect: { x: 1800, y: 100, w: 400, h: 60 }, t: 1.2 }), clip({ text: "Edge", px: 40, rect: { x: 1800, y: 100, w: 400, h: 60 }, t: 1.6 })],
		{ frame, sb: SB },
	);
	// One defect per shot, smallest first: an app view has many labels and one fix.
	assert.deepEqual(defects.map((d) => d.kind), ["text_small"]);
	assert.match(defects[0].message, /shot a: 2 texts in the captured clip are under 30 px on screen: "Join" 18 px, "Your name" 21 px/);
	assert.match(defects[0].fix, /push|frame tighter/);
	assert.match(defects[0].fix, /2\.5x/);
});

const skip = process.env.WV_INTEGRATION === "1" ? false : "set WV_INTEGRATION=1 to run the page checks in a browser";

test("page checks on a page: each defect is found once, at its shot", { skip, timeout: 60000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-page-"));
	try {
		const page = join(work, "index.html");
		writeFileSync(
			page,
			`<!doctype html><html><head><style>body{margin:0;width:1920px;height:1080px;background:#2e2320;font-family:sans-serif} .shot{position:absolute;inset:0;display:none}
			h1{position:absolute;left:100px;top:100px;margin:0;font-size:120px;color:#f0e8e2}</style>
			<script>/* build 9f2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e */ const leaked = "ghp_0123456789abcdefghij0123456789abcdef"; /* gitleaks:allow: a fake token */
			window.__timelines={main:{_t:0,seek(t){this._t=t;document.getElementById("a").style.display=t<2?"block":"none";document.getElementById("b").style.display=t>=2?"block":"none";return this},duration(){return 3}}};</script></head><body>
			<section class="shot" id="a"><h1>Big claim</h1><p style="position:absolute;left:100px;top:400px;font-size:13px;color:#f0e8e2">tiny footnote</p>
			<div style="position:absolute;left:1700px;top:600px;font-size:60px;color:#f0e8e2;white-space:nowrap">Runs off the edge</div></section>
			<section class="shot" id="b"><div style="position:absolute;left:100px;top:100px;width:600px;height:200px;background:#1e90ff"></div>
			<p style="position:absolute;left:100px;top:500px;font-size:48px;color:#f0e8e2">Copy 127.0.0.1:47811/eh4n7</p></section>
			</body></html>`,
		);
		const tokens = join(work, "tokens.json");
		writeFileSync(tokens, JSON.stringify({ ground: { color: "#2e2320" }, ink: { color: "#f0e8e2" }, palette: {} }));
		const sb = normalizeStoryboard({ fps: 60, shots: [{ id: "a", seconds: 2 }, { id: "b", seconds: 1 }] });
		const defects = await pageDefects({ page, tokens, storyboard: sb });
		const summary = defects.map((d) => `${d.kind}@${d.shot}`).sort();
		// private@null is the token in the built bundle; the bare content hash beside it is not a defect.
		assert.deepEqual(summary, ["color@b", "private@b", "private@null", "text_cut@a", "text_small@a"]);
		assert.match(defects.find((d) => d.shot === null).message, /built bundle has secret "ghp_/);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("page checks on a page: small text inside a captured clip fails at the size the film draws it", { skip, timeout: 60000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-page-clip-"));
	try {
		mkdirSync(join(work, "assets"));
		const page = join(work, "index.html");
		// Shot "wide" draws the 1280x720 capture 1280 px wide (1x); shot "push" draws it 3840 px wide (3x) in a cropping window.
		writeFileSync(
			page,
			`<!doctype html><html><head><style>body{margin:0;width:1920px;height:1080px;background:#2e2320} .shot{position:absolute;inset:0;display:none}
			.win{position:absolute;left:320px;top:180px;width:1280px;height:720px;overflow:hidden} video{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}
			#push .inner{position:absolute;left:-200px;top:-300px;width:3840px;height:2160px}</style>
			<script>window.__timelines={main:{seek(t){document.getElementById("wide").style.display=t<2?"block":"none";document.getElementById("push").style.display=t>=2?"block":"none";return this}}};</script></head><body>
			<section class="shot" id="wide"><div class="win"><video id="clip-wide" src="assets/cap.mp4"></video></div></section>
			<section class="shot" id="push"><div class="win"><div class="inner"><video id="clip-push" src="assets/cap.mp4"></video></div></div></section>
			</body></html>`,
		);
		const items = [
			{ text: "Your name", selector: "label", px: 16, rect: { x: 100, y: 120, w: 80, h: 20 } },
			{ text: "Far away", selector: "p", px: 16, rect: { x: 1100, y: 650, w: 80, h: 20 } },
			// A local URL in the recorded app: the recreated page is clean, the clip is not.
			{ text: "Copy 127.0.0.1:47811/eh4n7", selector: "p", px: 16, rect: { x: 100, y: 400, w: 300, h: 20 } },
		];
		writeFileSync(join(work, "assets", "cap.events.json"), JSON.stringify({ version: 1, fps: 60, viewport: { width: 1280, height: 720, scale: 2 }, texts: [{ f: 0, items }, { f: 60, items }] }));
		const sb = normalizeStoryboard({ fps: 60, shots: [{ id: "wide", seconds: 2, clip: { src: "assets/cap.mp4" } }, { id: "push", seconds: 2, clip: { src: "assets/cap.mp4", from: 0.5 } }] });
		const notes = [];
		const defects = await pageDefects({ page, storyboard: sb, notes });
		const summary = defects.map((d) => `${d.kind}@${d.shot}:${d.message.match(/"([^"]+)"/)[1]}`).sort();
		// Wide: both labels are 16 px. Push: "Your name" is 48 px; "Far away" is outside the window.
		// The clip's own local URL is private data on screen, reported once even though both shots show it.
		assert.deepEqual(summary, ["private@wide:127.0.0.1:47811", "text_small@wide:Your name"]);
		assert.match(defects.find((d) => d.kind === "text_small").message, /3 texts .*"Your name" 16 px, "Far away" 16 px/);
		assert.deepEqual(notes, []);
		rmSync(join(work, "assets", "cap.events.json"));
		await pageDefects({ page, storyboard: sb, notes });
		assert.match(notes[0], /assets\/cap\.events\.json/);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("subject: a box per time samples at those times, a fixed box or a selector at five times in the shot", () => {
	const sb = normalizeStoryboard({ fps: 30, shots: [{ id: "a", seconds: 2 }, { id: "orbit", seconds: 4, subject: { boxes: [{ t: 1, box: [948, 526, 24, 19] }, { t: 3, box: [940, 520, 40, 30] }] } }, { id: "c", seconds: 2, subject: ".card" }] });
	assert.deepEqual(subjectSamples(sb.shots[1]).map((s) => [s.t, s.box?.[2]]), [[3, 24], [5, 40]]);
	const c = subjectSamples(sb.shots[2]);
	assert.equal(c.length, 5);
	assert.equal(c[0].selector, ".card");
	assert.ok(c.every((s) => s.t > 6 && s.t < 8));
	assert.deepEqual(subjectSamples(sb.shots[0]), []);
});

test("subject: a box in clip pixels lands on screen at the size the film draws the clip", () => {
	// A 1920 px clip drawn 1987 px wide (a 3.5 % drift), from x = -33.
	const view = { content: { x: -33.6, y: -18.9, w: 1987.2, h: 1117.8 }, visible: { x: 0, y: 0, w: 1920, h: 1080 } };
	const r = subjectOnScreen([948, 526, 24, 19], view, 1920);
	assert.equal(Math.round(r.w * 10) / 10, 24.8);
	// Out of the visible part: nothing on screen.
	assert.equal(subjectOnScreen([1950, 10, 40, 40], { ...view, content: { x: 0, y: 0, w: 1920, h: 1080 } }, 1920).w, 0);
});

test("subject: under 5 % of the frame width at its largest is advice, with the phone size", () => {
	const sb = normalizeStoryboard({ fps: 30, shots: [{ id: "orbit", seconds: 4 }, { id: "card", seconds: 2 }] });
	const facts = [
		{ shot: "orbit", t: 1, w: 21 },
		{ shot: "orbit", t: 2, w: 25 },
		{ shot: "card", t: 5, w: 600 },
	];
	const advice = subjectAdvice(facts, sb);
	assert.equal(advice.length, 1);
	assert.equal(advice[0].kind, "subject");
	assert.match(advice[0].message, /shot "orbit".*25 px.*1\.3 % of the frame width.*shot time 2\.00 s.*6 px/);
	assert.match(advice[0].fix, /closer|tighter/);
});

test("page checks on a page: a subject box is measured at the size the film draws the clip (advice, not a defect)", { skip, timeout: 60000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-page-subject-"));
	try {
		mkdirSync(join(work, "assets"));
		const page = join(work, "index.html");
		writeFileSync(
			page,
			`<!doctype html><html><head><style>body{margin:0;width:1920px;height:1080px;background:#000} .shot{position:absolute;inset:0}
			video{position:absolute;left:0;top:0;width:1920px;height:1080px;object-fit:cover}</style>
			<script>window.__timelines={main:{seek(t){return this}}};</script></head><body>
			<section class="shot" id="orbit"><video id="clip-orbit" src="assets/fly.mp4"></video></section></body></html>`,
		);
		writeFileSync(join(work, "assets", "fly.events.json"), JSON.stringify({ version: 1, fps: 30, viewport: { width: 960, height: 540, scale: 2 }, texts: [] }));
		const sb = normalizeStoryboard({ fps: 30, shots: [{ id: "orbit", seconds: 2, clip: { src: "assets/fly.mp4" }, subject: { box: [948, 526, 24, 19] } }] });
		const advice = [];
		const defects = await pageDefects({ page, storyboard: sb, advice });
		assert.deepEqual(defects, []);
		assert.equal(advice.length, 1);
		assert.match(advice[0].message, /24 px/);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("clip text: a small HUD label at the frame edge gets the scale it needs and the CSS fix, because a push would crop it", () => {
	const frame = { width: 1920, height: 1080 };
	// film2: "MACH 8.79" 27 px, 56 px from the right and bottom edges.
	const hud = (t) => fact({ source: "clip", text: "MACH 8.79", px: 27, rect: { x: 1740, y: 1000, w: 124, h: 24 }, t });
	const [d] = textDefects([hud(1.2), hud(1.6)], { frame, sb: SB });
	assert.match(d.fix, /needs 1\.12x/);
	assert.match(d.fix, /crop/);
	assert.match(d.fix, /addInitScript.*font-size/);
	// A label near the centre needs the same scale, and a push keeps it in the frame.
	const mid = (t) => fact({ source: "clip", text: "Join", px: 27, rect: { x: 900, y: 500, w: 80, h: 24 }, t });
	assert.doesNotMatch(textDefects([mid(1.2), mid(1.6)], { frame, sb: SB })[0].fix, /crop/);
});
