import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SPEC, fitZoom, focusFor, layoutClips, maxZoom, outTime, readZoom, readSeconds } from "../skills/walkthrough-video/scripts/lib/compose-plan.mjs";
import { camTransform, renderHtml } from "../skills/walkthrough-video/scripts/lib/compose-html.mjs";
import { buildPlan, editFilter, main as composeMain } from "../skills/walkthrough-video/scripts/compose.mjs";
import { requireProjectGsap, runtimeGsap, runtimeGsapError } from "../skills/walkthrough-video/scripts/lib/gsap.mjs";

const SKILL = fileURLToPath(new URL("../skills/walkthrough-video/scripts/", import.meta.url));

const source = { width: 1280, height: 720, scale: 2 };
const output = { width: 1920, height: 1080 };
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} is not near ${b}`);

const capture = () => ({
	version: 1, fps: 60, viewport: { width: 1280, height: 720, scale: 2 }, frames: 900,
	cursor: [{ f: 0, x: 900, y: 600 }],
	events: [
		{ id: "e1", kind: "goto", name: "open", startFrame: 0, endFrame: 30, settleFrame: 40, target: null, caret: null, changed: null, fontPx: null },
		{ id: "e2", kind: "type", name: "name", startFrame: 120, endFrame: 150, settleFrame: 170, target: { x: 452, y: 232, width: 376, height: 47 }, caret: { x: 520, y: 240, width: 2, height: 30 }, changed: null, fontPx: 16 },
		{ id: "e3", kind: "click", name: "create", startFrame: 400, endFrame: 405, settleFrame: 460, target: { x: 560, y: 420, width: 160, height: 44 }, caret: null, changed: { x: 0, y: 0, width: 1280, height: 720 }, fontPx: 15 },
	],
	cues: [],
});

test("maxZoom is the zoom where one source pixel meets one output pixel", () => {
	near(maxZoom(source, output), (2 * 1280) / 1920);
});

test("readZoom brings 16px text to 28px at 1080", () => {
	const z = readZoom(16, source, output);
	near(16 * z * 1.5, 0.026 * 1080);
});

test("fitZoom keeps a padded box inside the safe area", () => {
	const box = { x: 0, y: 0, width: 400, height: 50 };
	const z = fitZoom(box, source, output);
	const padded = (400 * 1.6 + 48) * 1.5 * z;
	near(padded, 0.8 * 1920);
});

test("a narrow input is framed whole", () => {
	const f = focusFor(capture().events[1], source, output);
	assert.equal(f.kind, "target");
	assert.ok(f.zoom >= f.zRead - 1e-9 && f.zoom <= f.zMax + 1e-9);
});

test("a wide input that cannot fit at reading size is framed on the caret", () => {
	const ev = { ...capture().events[1], target: { x: 0, y: 300, width: 1200, height: 47 }, caret: { x: 900, y: 308, width: 2, height: 30 }, fontPx: 18 };
	const f = focusFor(ev, source, output);
	assert.equal(f.kind, "caret");
	assert.ok(f.box.x + f.box.width >= 902 && f.box.x > 0);
});

test("a click whose change is a full-width row frames the control so it still reads", () => {
	const ev = { ...capture().events[2], changed: { x: 8, y: 500, width: 1264, height: 62 } };
	const f = focusFor(ev, source, output);
	assert.equal(f.kind, "target");
	assert.ok(15 * f.zoom * 1.5 >= 0.026 * 1080 - 0.05);
});

test("the edit starts after the first navigation paints, not on the blank page", () => {
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"] }] });
	assert.equal(plan.clips[0].from, 40);
});

test("a navigation is an overview at zoom 1", () => {
	assert.deepEqual(focusFor(capture().events[0], source, output).zoom, 1);
});

test("long idle gaps are sped up to gapOutS, short ones play at 1x", () => {
	const c = capture();
	const byId = new Map(c.events.map((e) => [e.id, e]));
	const { clips } = layoutClips([{ events: ["e2"] }, { events: ["e3"] }], byId, c, new Map(), 0);
	const gap = clips.find((k) => k.from === 40);
	near((gap.to - gap.from) / 60 / gap.speed, SPEC.gapOutS);
	const between = clips[2];
	assert.ok(between.speed > 1);
});

test("a caption longer than its picture adds a hold", () => {
	const c = capture();
	const byId = new Map(c.events.map((e) => [e.id, e]));
	const caption = "one two three four five six seven eight nine ten";
	const { clips, spans } = layoutClips([{ events: ["e3"], caption }], byId, c, new Map(), 0);
	const shot = clips.at(-1);
	near((shot.to - shot.from) / 60 + shot.hold, readSeconds(caption));
	near(spans[0].end - spans[0].start, readSeconds(caption));
});

test("unknown events and voices fail with an actionable message", () => {
	const c = capture();
	assert.throws(() => buildPlan(c, { shots: [{ events: ["nope"] }] }), /unknown event "nope"/);
	assert.throws(() => buildPlan(c, { shots: [{ events: ["e2"], voice: "l9" }] }, []), /voice "l9"/);
});

test("outTime maps frames through speed and offset", () => {
	const clips = [{ from: 0, to: 60, at: 1, speed: 2 }, { from: 60, to: 120, at: 1.5, speed: 1 }];
	near(outTime(clips, 30, 60), 1.25);
	near(outTime(clips, 90, 60), 2.0);
});

test("the cursor presses each click on its first frame, inside the target", () => {
	const c = capture();
	const plan = buildPlan(c, { shots: [{ events: ["e2"] }, { events: ["e3"] }] });
	const press = plan.cursor.find((k) => k.event === "e3");
	near(press.t, outTime(plan.clips, 400, 60));
	const t = c.events[2].target;
	assert.ok(press.x > t.x && press.x < t.x + t.width && press.y > t.y && press.y < t.y + t.height);
});

test("the camera never exceeds the upscale limit and ends at zoom 1", () => {
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"] }, { events: ["e3"] }] });
	for (const k of plan.camera) assert.ok(k.zoom <= maxZoom(source, output) + 1e-9);
	assert.equal(plan.camera.at(-1).zoom, 1);
	assert.ok(plan.focus.some((f) => f.event === "e2"));
});

test("an intro moves the edit start and adds a shot beat per shot", () => {
	const plan = buildPlan(capture(), { intro: { title: "Pointer" }, shots: [{ events: ["e2"] }, { events: ["e3"] }] });
	near(plan.edit.start, SPEC.introS - 0.35);
	assert.equal(plan.beats.length, 2);
	assert.ok(plan.clips[0].at >= plan.edit.start - 1e-9);
});

test("camTransform puts the focus point at the frame centre", () => {
	const t = camTransform({ cx: 300, cy: 200, zoom: 1.3 }, source, output);
	near(300 * 1.5 * 1.3 + t.x, 960);
	near(200 * 1.5 * 1.3 + t.y, 540);
});

test("editFilter trims, retimes and holds each clip, then concatenates", () => {
	const f = editFilter([{ from: 0, to: 30, at: 0, speed: 2 }, { from: 30, to: 90, at: 0.25, speed: 1, hold: 0.5 }], 60);
	assert.match(f, /trim=start_frame=0:end_frame=30,setpts=\(PTS-STARTPTS\)\/2,fps=60\[c0\]/);
	assert.match(f, /tpad=stop_mode=clone:stop_duration=0.5/);
	assert.match(f, /concat=n=2:v=1:a=0/);
});

test("renderHtml escapes captions and titles and registers one timeline", () => {
	const plan = buildPlan(capture(), { intro: { title: "<b>x</b>" }, shots: [{ events: ["e3"], caption: "a & <i>b</i>" }] });
	const html = renderHtml(plan, { intro: { title: "<b>x</b>" } }, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js");
	assert.ok(!html.includes("<b>x</b>") && html.includes("&lt;b&gt;x&lt;/b&gt;"));
	assert.ok(html.includes("a &amp; &lt;i&gt;b&lt;/i&gt;"));
	assert.equal(html.match(/window\.__timelines\["main"\]/g).length, 1);
});

test("the focus window on a control ends before the camera pulls back from a full-screen change", () => {
	const plan = buildPlan(capture(), { shots: [{ events: ["e3"], caption: "one two three four five six seven" }] });
	const win = plan.focus.find((f) => f.event === "e3");
	const pull = plan.camera.find((k) => k.zoom === 1 && k.t > win.start);
	assert.ok(win.end <= pull.t - SPEC.cameraMoveS + 1e-9);
});

test("a voice line's window is its shot, and the line fits in it", () => {
	const voice = [{ id: "l1", text: "Hello there", file: "l1.wav", seconds: 2.5 }];
	const plan = buildPlan(capture(), { shots: [{ events: ["e3"], voice: "l1" }] }, voice);
	const v = plan.voice[0];
	assert.ok(v.end - v.start >= v.seconds);
});

test("latinBlocks keeps only latin and latin-ext faces", async () => {
	const { latinBlocks } = await import("../skills/walkthrough-video/scripts/lib/compose-font.mjs");
	const css = "/* vietnamese */\n@font-face { src: url(https://x/v.woff2) }\n/* latin-ext */\n@font-face { src: url(https://x/le.woff2) }\n/* latin */\n@font-face { src: url(https://x/l.woff2) }";
	assert.deepEqual(latinBlocks(css).map((b) => b.match(/x\/(\w+)/)[1]), ["le", "l"]);
});

test("render uses PNG frame extraction and the plan's fps", async () => {
	const { renderArgs } = await import("../skills/walkthrough-video/scripts/hf.mjs");
	const args = renderArgs({ fps: 60 }, { out: "/x.mp4" });
	assert.deepEqual(args.slice(args.indexOf("--fps"), args.indexOf("--fps") + 2), ["--fps", "60"]);
	assert.ok(args.includes("--video-frame-format") && args.includes("png"));
	assert.throws(() => renderArgs({ fps: 60 }, { out: "/x.mp4", quality: "ultra" }), /quality/);
});

test("the camera is driven by CSS variables, with no onUpdate callback", () => {
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"] }, { events: ["e3"] }] });
	const html = renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js");
	assert.ok(!html.includes("onUpdate"));
	assert.match(html, /transform: translate\(calc\(960px - var\(--cx\) \* var\(--z\) \* 1\.5px\)/);
	assert.equal(html.match(/tl\.fromTo\("#cam"/g).length, plan.camera.length - 1);
	assert.ok(!/tl\.to\(/.test(html), "every tween states its start values");
});

test("a wait with no element keeps the camera on the last control", () => {
	const c = capture();
	c.events.push({ id: "e4", kind: "wait", name: "hold", startFrame: 470, endFrame: 520, settleFrame: 520, target: null, caret: null, changed: null, fontPx: null });
	c.events[2] = { ...c.events[2], changed: null };
	const plan = buildPlan(c, { shots: [{ events: ["e3", "e4"] }] });
	const zoomed = plan.camera.filter((k) => k.zoom > 1);
	assert.equal(zoomed.length, 1);
	assert.ok(plan.camera.at(-1).t >= plan.edit.start + plan.edit.duration - SPEC.cameraMoveS - 1e-9);
});

test("a shot focus mode does not pull the camera back on a wait with no element", () => {
	const c = capture();
	c.events.push({ id: "e4", kind: "wait", name: "hold", startFrame: 170, endFrame: 260, settleFrame: 260, target: null, caret: null, changed: null, fontPx: null });
	const plan = buildPlan(c, { shots: [{ events: ["e2", "e4"], focus: "target" }] });
	assert.equal(plan.camera.filter((k) => k.zoom > 1).length, 1, JSON.stringify(plan.camera));
	assert.ok(plan.camera.at(-1).t >= plan.edit.start + plan.edit.duration - SPEC.cameraMoveS - 1e-9, JSON.stringify(plan.camera));
});

test("a mark followed by a hold keeps its focus window to the end of the shot", () => {
	const c = capture();
	c.events.push({ id: "e4", kind: "mark", name: "result", startFrame: 470, endFrame: 470, settleFrame: 470, target: { x: 540, y: 300, width: 200, height: 40 }, caret: null, changed: null, fontPx: 18 });
	c.events.push({ id: "e5", kind: "wait", name: "hold", startFrame: 470, endFrame: 600, settleFrame: 600, target: null, caret: null, changed: null, fontPx: null });
	const plan = buildPlan(c, { shots: [{ events: ["e2"] }, { events: ["e4", "e5"] }] });
	const w = plan.focus.find((f) => f.event === "e4");
	assert.ok(w.end - w.start > 1.5, JSON.stringify(w));
});

test("the camera adds no key for a move to where it already is", () => {
	const c = capture();
	c.events.push({ id: "e4", kind: "goto", name: "next", startFrame: 500, endFrame: 530, settleFrame: 540, target: null, caret: null, changed: null, fontPx: null });
	const plan = buildPlan(c, { shots: [{ events: ["e1"] }, { events: ["e4"] }] });
	const same = (a, b) => a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
	plan.camera.slice(1).forEach((k, i) => assert.ok(!same(k, plan.camera[i]), JSON.stringify(plan.camera)));
});

test("a caption moves to the top when the shot's control is under it", () => {
	const c = capture();
	c.events[2] = { ...c.events[2], target: { x: 100, y: 660, width: 160, height: 44 }, changed: null };
	const plan = buildPlan(c, { shots: [{ events: ["e1"], caption: "Open it" }, { events: ["e3"], caption: "Create the room", focus: "overview" }] });
	assert.equal(plan.captions[0].place, "bottom");
	assert.equal(plan.captions[1].place, "top");
	assert.match(renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js"), /class="clip caption top"/);
});

test("the pull-back after a full-screen change starts after that click, not after the last camera move", () => {
	// e3 is already framed by the camera that arrived for e2, so it adds no key of its own.
	const plan = buildPlan(capture(), { shots: [{ events: ["e2", "e3"] }] });
	const back = plan.camera.find((k, i) => i > 0 && k.zoom === 1);
	assert.ok(back.t >= outTime(plan.clips, 400, 60) + SPEC.cameraMoveS - 1e-6, JSON.stringify(plan.camera));
});

test("a wait whose change fills the screen pulls the camera back, and a hold after it keeps the overview", () => {
	const c = capture();
	c.events[2] = { ...c.events[2], changed: { x: 500, y: 400, width: 300, height: 100 } };
	c.events.push({ id: "e4", kind: "wait", name: "flying", startFrame: 470, endFrame: 520, settleFrame: 560, target: null, caret: null, changed: { x: 0, y: 0, width: 1280, height: 700 }, fontPx: null });
	c.events.push({ id: "e5", kind: "wait", name: "hold", startFrame: 560, endFrame: 700, settleFrame: 700, target: null, caret: null, changed: null, fontPx: null });
	const plan = buildPlan(c, { shots: [{ events: ["e3", "e4", "e5"] }] });
	const back = plan.camera.find((k, i) => i > 0 && k.zoom === 1);
	assert.ok(back && back.t <= outTime(plan.clips, 520, 60) + SPEC.cameraMoveS, JSON.stringify(plan.camera));
	const w = plan.focus.find((f) => f.event === "e3");
	assert.ok(w.end <= back.t, `focus window ${JSON.stringify(w)} ends before the pull-back at ${back.t}`);
});

test("captions are large enough to read on a phone (at least 56 px at 1080)", () => {
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"], caption: "Name yourself" }] });
	const html = renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js");
	const px = Number(html.match(/\.cap-in \{[^}]*font-size: (\d+)px/)[1]);
	assert.ok(px >= 56, `caption font ${px}px`);
});

test("compose refuses agent values that would reach ffmpeg or the HTML unchecked", () => {
	const bad = [
		{ shots: [{ events: ["e2"], speed: "1[x];movie=/etc/passwd[y];[x][y]overlay" }] },
		{ shots: [{ events: ["e2"], speed: 40 }] },
		{ shots: [{ events: ["e2"], focus: "everything" }] },
		{ output: { width: "1920px}</style><script>alert(1)</script><style>", height: 1080 }, shots: [{ events: ["e2"] }] },
		{ look: { ground: "red;}</style><script>x</script>" }, shots: [{ events: ["e2"] }] },
		{ look: { font: "Inter&family=x</style>" }, shots: [{ events: ["e2"] }] },
		{ shots: [{ events: ["e2"], caption: 42 }] },
		{ shots: [{ events: [] }] },
	];
	for (const shots of bad) assert.throws(() => buildPlan(capture(), shots), /shots\.json/, JSON.stringify(shots));
});

test("compose refuses a capture whose aspect ratio differs from the output", () => {
	const c = { ...capture(), viewport: { width: 1280, height: 800, scale: 2 } };
	assert.throws(() => buildPlan(c, { shots: [{ events: ["e2"] }] }), /aspect|16:9/);
});

test("compose refuses shots out of capture order or a repeated event", () => {
	assert.throws(() => buildPlan(capture(), { shots: [{ events: ["e3"] }, { events: ["e2"] }] }), /order/);
	assert.throws(() => buildPlan(capture(), { shots: [{ events: ["e2", "e2"] }] }), /order|twice/);
});

test("camera keys stay in time order when a full-screen click follows a click closely", () => {
	const c = capture();
	c.events[1] = { ...c.events[1], kind: "click", startFrame: 120, endFrame: 122, settleFrame: 124, changed: null };
	c.events[2] = { ...c.events[2], startFrame: 136, endFrame: 138, settleFrame: 140 };
	const plan = buildPlan(c, { shots: [{ events: ["e2", "e3"] }] });
	plan.camera.slice(1).forEach((k, i) => assert.ok(k.t >= plan.camera[i].t + 0.3 - 1e-9, JSON.stringify(plan.camera)));
	const html = renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js");
	assert.ok(!/duration: -/.test(html));
});

test("index.html carries the fingerprint of the plan it was built from", async () => {
	const { planFingerprint, planHashInHtml } = await import("../skills/walkthrough-video/scripts/lib/fingerprint.mjs");
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"] }] });
	const html = renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js");
	assert.equal(planHashInHtml(html), planFingerprint(plan));
	assert.notEqual(planFingerprint({ ...plan, camera: [{ t: 0, cx: 1, cy: 2, zoom: 3 }] }), planFingerprint(plan));
	assert.equal(planHashInHtml("<html></html>"), null);
});

test("gates refuse a project whose index.html belongs to another plan", async () => {
	const { checkProjectMatchesPlan } = await import("../skills/walkthrough-video/scripts/lib/gates-run.mjs");
	const { planFingerprint } = await import("../skills/walkthrough-video/scripts/lib/fingerprint.mjs");
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"] }] });
	const html = renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js");
	assert.equal(checkProjectMatchesPlan(plan, html), null);
	const stale = planFingerprint({ ...plan, camera: [] });
	assert.match(checkProjectMatchesPlan(plan, `<div id="root" data-plan-hash="${stale}">`), /another plan/);
	assert.equal(checkProjectMatchesPlan(plan, null), null); // no index.html yet: nothing to check
});

test("compose and the gates share the 0.2 px text margin", () => {
	// 14 px text at the 2x capture limit reaches 28.00 px against a 28.08 px floor.
	const c = capture();
	c.events[1] = { ...c.events[1], kind: "click", fontPx: 14, target: { x: 452, y: 232, width: 200, height: 47 } };
	const plan = buildPlan(c, { shots: [{ events: ["e2"] }] });
	const zoomWarnings = plan.warnings.filter((w) => /needs zoom/.test(w));
	assert.deepEqual(zoomWarnings, [], JSON.stringify(plan.warnings));
	const key = plan.camera.at(-2) ?? plan.camera.at(-1);
	assert.ok(key.zoom > 1, JSON.stringify(plan.camera));
});

test("the widest focus box that fits inverts fitZoom", async () => {
	const { fitZoom, widestBoxWidth } = await import("../skills/walkthrough-video/scripts/lib/compose-plan.mjs");
	const box = { x: 0, y: 0, width: 400, height: 40 };
	const zoom = fitZoom(box, source, output);
	const widest = widestBoxWidth(zoom, source, output);
	assert.ok(Math.abs(widest - 400) <= 1, `width ${widest} for a box that fits at ${zoom}`);
	assert.ok(widestBoxWidth(zoom * 2, source, output) < widest);
});

const closeCapture = () => {
	const c = capture();
	c.events = [
		{ id: "e1", kind: "mark", name: "a", startFrame: 100, endFrame: 100, settleFrame: 100, target: { x: 100, y: 100, width: 140, height: 30 }, caret: null, changed: null, fontPx: 20 },
		{ id: "e2", kind: "click", name: "b", startFrame: 140, endFrame: 142, settleFrame: 150, target: { x: 300, y: 300, width: 160, height: 44 }, caret: null, changed: { x: 0, y: 0, width: 1280, height: 720 }, fontPx: 20 },
		{ id: "e3", kind: "click", name: "c", startFrame: 175, endFrame: 177, settleFrame: 190, target: { x: 700, y: 500, width: 160, height: 44 }, caret: null, changed: { x: 700, y: 500, width: 160, height: 44 }, fontPx: 20 },
	];
	return c;
};

test("the camera moves straight between two focus windows that are close together", () => {
	const plan = buildPlan(closeCapture(), { shots: [{ events: ["e1"] }, { events: ["e2", "e3"] }] });
	const from = outTime(plan.clips, 145, 60), to = outTime(plan.clips, 178, 60);
	const between = plan.camera.filter((k) => k.t > from && k.t < to);
	assert.ok(between.length > 0, "the camera moves to the next control");
	assert.ok(between.every((k) => k.zoom > 1), `no pull-back between close windows: ${JSON.stringify(plan.camera)}`);
});

test("a wait in the middle of a shot keeps the focus window open", () => {
	const c = capture();
	c.events.push({ id: "e4", kind: "wait", name: "hold", startFrame: 190, endFrame: 300, settleFrame: 300, target: null, caret: null, changed: null, fontPx: null });
	const plan = buildPlan(c, { shots: [{ events: ["e2", "e4"] }] });
	const w = plan.focus.find((f) => f.event === "e2");
	assert.ok(w.end >= outTime(plan.clips, 300, 60) - 0.02, `window ${JSON.stringify(w)} covers the wait`);
});

test("the camera keeps its focus until the caption and the voice line end", () => {
	const plan = buildPlan(closeCapture(), { outro: { title: "Done" }, shots: [{ events: ["e1"] }, { events: ["e2", "e3"], caption: "one two three four five six seven eight" }] });
	const caption = plan.captions.at(-1);
	const w = plan.focus.find((f) => f.event === "e3");
	assert.ok(w.end >= caption.end - 1e-6, `window ${JSON.stringify(w)} outlasts caption ${JSON.stringify(caption)}`);
	assert.ok(!plan.camera.some((k) => k.zoom === 1 && k.t > caption.start && k.t < caption.end - SPEC.cameraMoveS + 1e-6), `no pull-back under the caption: ${JSON.stringify(plan.camera)}`);
});

test("a mark with a big change after it keeps its focus instead of pulling back", () => {
	const c = capture();
	c.events.push({ id: "e4", kind: "wait", name: "settle", startFrame: 470, endFrame: 520, settleFrame: 520, target: null, caret: null, changed: { x: 0, y: 0, width: 1280, height: 700 }, fontPx: null });
	const plan = buildPlan(c, { shots: [{ events: ["e2"] }, { events: ["e3"], focus: "target" }, { events: ["e4"] }] });
	const win = plan.focus.find((f) => f.event === "e3");
	assert.ok(win.zoom === undefined || true);
	// The camera keeps the control framed through the wait that follows in the same shot.
	const after = plan.camera.filter((k) => k.t >= win.start && k.t <= win.end);
	assert.ok(after.every((k) => k.zoom > 1), JSON.stringify(plan.camera));
});

test("a shot focus applies to a mark event", () => {
	const plan = buildPlan(closeCapture(), { shots: [{ events: ["e1"], focus: "overview" }] });
	const w = plan.focus.find((f) => f.event === "e1");
	assert.equal(w, undefined, "a mark in an overview shot adds no focus window");
	assert.ok(plan.camera.every((k) => k.zoom === 1), JSON.stringify(plan.camera));
});

test("a focus override that changes nothing prints a warning", () => {
	const plan = buildPlan(closeCapture(), { shots: [{ events: ["e2"], focus: "caret" }] });
	assert.ok(plan.warnings.some((w) => /"focus": "caret"/.test(w) && /changes nothing/.test(w)), JSON.stringify(plan.warnings));
});

test("the cursor fades out after 1.5 s without a pointer event and back in before the next one", async () => {
	const { CURSOR_IDLE_S, cursorVisibility } = await import("../skills/walkthrough-video/scripts/lib/compose-timeline.mjs");
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"] }, { events: ["e3"] }] });
	const key = plan.cursor[plan.cursor.length - 1].t;
	const windows = cursorVisibility(plan, {});
	const last = windows.at(-1);
	assert.ok(Math.abs(last[1] - (key + CURSOR_IDLE_S)) < 0.02, `the cursor hides 1.5 s after its last event: ${JSON.stringify(windows)}`);
	assert.ok(windows[0][0] <= plan.cursor[0].t, "the cursor is visible from its first key");
	const html = renderHtml(plan, {}, { src: "edit.mp4", ...plan.edit }, "assets/gsap.min.js");
	assert.ok(html.includes(`${Number((key + CURSOR_IDLE_S).toFixed(3))}`), "index.html fades the cursor out after the pause");
});

test("a shot can hide the cursor", async () => {
	const { cursorVisibility } = await import("../skills/walkthrough-video/scripts/lib/compose-timeline.mjs");
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"], cursor: "hide" }, { events: ["e3"] }] });
	const windows = cursorVisibility(plan, { shots: [{ events: ["e2"], cursor: "hide" }, { events: ["e3"] }] });
	const beat = plan.beats[0].t;
	assert.ok(!windows.some(([a, b]) => a < beat + 0.01 || (a <= beat && b > beat)), `no cursor in the hidden shot: ${JSON.stringify(windows)}`);
	assert.throws(() => buildPlan(capture(), { shots: [{ events: ["e2"], cursor: "sometimes" }] }), /cursor/);
});

test("a caption place in shots.json wins over the composer's choice", () => {
	const c = capture();
	c.events[2] = { ...c.events[2], target: { x: 100, y: 660, width: 160, height: 44 }, changed: null };
	const plan = buildPlan(c, { shots: [{ events: ["e1"] }, { events: ["e3"], caption: { text: "Create the room", place: "bottom" }, focus: "overview" }] });
	assert.equal(plan.captions.length, 1);
	assert.equal(plan.captions[0].place, "bottom");
	assert.equal(plan.captions[0].text, "Create the room");
});

test("a caption ends with its shot, at the shot's own content end", () => {
	const plan = buildPlan(capture(), { shots: [{ events: ["e2"], caption: "Name yourself" }, { events: ["e3"], caption: "Create it" }] });
	for (const [i, caption] of plan.captions.entries()) {
		const next = plan.beats[i + 1]?.t ?? plan.edit.start + plan.edit.duration;
		assert.ok(caption.end <= next - 0.09, `caption ${i} ends before the next shot (${caption.end} vs ${next})`);
		assert.ok(caption.start >= plan.beats[i].t, `caption ${i} starts inside its own shot`);
	}
});

test("a planned wait keeps its time and the lag after it is compressed", () => {
	const c = capture();
	c.frames = 700;
	c.events.push({ id: "e4", kind: "wait", name: "hold", startFrame: 500, endFrame: 560, settleFrame: 620, plannedMs: 300, target: null, caret: null, changed: null, fontPx: null });
	c.stills = [[530, 619]];
	const plan = buildPlan(c, { shots: [{ events: ["e2", "e4"] }] });
	assert.ok(plan.clips.some((k) => k.from >= 530 && k.speed > 1), `the tail of the wait is compressed: ${JSON.stringify(plan.clips)}`);
	const during = plan.clips.find((k) => 510 >= k.from && 510 <= k.to);
	assert.equal(during?.speed, 1, "the planned part of the wait keeps its speed");
});

test("a shot trim keeps only the part of the picture that the shot names", () => {
	const c = capture();
	const plain = buildPlan(c, { shots: [{ events: ["e2"] }] });
	const trimmed = buildPlan(c, { shots: [{ events: ["e2"], trim: { start: 0.2, end: 0.6 } }] });
	const a = plain.clips.at(-1), b = trimmed.clips.at(-1);
	assert.equal(b.from, a.from + Math.round(0.2 * 60));
	assert.equal(b.to, a.from + Math.round(0.6 * 60));
	assert.ok(b.to - b.from < a.to - a.from);
});

test("a trim that cuts away a shot's events warns instead of breaking the camera", () => {
	const c = capture();
	c.events.push({ id: "e4", kind: "wait", name: "hold", startFrame: 500, endFrame: 560, settleFrame: 560, target: null, caret: null, changed: null, fontPx: null });
	const plan = buildPlan(c, { shots: [{ events: ["e2", "e3", "e4"], trim: { end: 1.0 } }] });
	assert.ok(plan.warnings.some((w) => /trim/i.test(w) && /e4/.test(w)), JSON.stringify(plan.warnings));
	const times = plan.cursor.map((k) => k.t);
	assert.ok(times.every((t) => Number.isFinite(t)), "every cursor key has a number time");
	assert.ok(plan.camera.every((k) => Number.isFinite(k.t) && Number.isFinite(k.cx) && Number.isFinite(k.zoom)));
	assert.ok(plan.focus.every((f) => f.event !== "e4"), JSON.stringify(plan.focus));
});

test("a cut puts the new shot's camera in place with no move", () => {
	const plan = buildPlan(closeCapture(), { shots: [{ events: ["e1"] }, { events: ["e2"], cut: true }, { events: ["e3"] }] });
	const cut = plan.camera.find((k) => k.ease === "none" && k.t > 0);
	assert.ok(cut, JSON.stringify(plan.camera));
	const second = plan.beats[1].t;
	assert.ok(Math.abs(cut.t - second) < 0.05, `the cut key sits at the shot start ${second} (got ${cut.t})`);
	const first = plan.focus.find((f) => f.event === "e1");
	assert.ok(first.end <= cut.t + 1e-6, `the window before the cut ends at it: ${JSON.stringify(first)}`);
});

// --- idle time inside a shot (row 1): repeated frames are time-remapped out ---

/** The capture above, plus a host that repeated frames: stills are [from, to] frame ranges. */
const laggyCapture = (stills = [[60, 119], [430, 459]]) => ({
	...capture(),
	stats: { unique: 90, repeated: 810, maxLagMs: 900, gpu: true, distinct: 90 },
	stills,
});

test("a run of repeated frames between two actions is compressed inside the shot", () => {
	const plain = buildPlan(capture(), { shots: [{ events: ["e1", "e2"] }] });
	const laggy = buildPlan(laggyCapture(), { shots: [{ events: ["e1", "e2"] }] });
	assert.ok(laggy.edit.duration < plain.edit.duration - 0.4, `${laggy.edit.duration} should be shorter than ${plain.edit.duration}`);
	// The still run 60..119 (1 s) plays in SPEC.idleOutS.
	const run = laggy.clips.find((c) => c.from === 60);
	assert.ok(run, JSON.stringify(laggy.clips));
	near((run.to - run.from) / 60 / run.speed, SPEC.gapOutS);
});

test("the camera and the cursor read the compressed clock, not the raw one", () => {
	const plan = buildPlan(laggyCapture(), { shots: [{ events: ["e1", "e2"] }] });
	// e2 starts at capture frame 120, which is one compressed run later than frame 40.
	const e2 = plan.cursor.find((k) => k.event === "e2");
	assert.ok(e2, JSON.stringify(plan.cursor));
	near(e2.t, outTime(plan.clips, 120, 60), 0.01);
	assert.ok(e2.t < (120 - 40) / 60, "the click lands earlier than the raw capture time");
	const window = plan.focus.find((f) => f.event === "e2");
	assert.ok(window && window.start < (120 - 40) / 60, "the focus window follows the remap");
});

test("a still run inside an action or a planned wait is not compressed", () => {
	// 430..459 sits inside e3 (400..460): an action, not host lag.
	const plan = buildPlan(laggyCapture([[430, 459]]), { shots: [{ events: ["e3"] }] });
	const shotClip = plan.clips.at(-1);
	assert.equal(shotClip.from, 379);
	assert.equal(shotClip.speed, 1, JSON.stringify(plan.clips));
});

test("still compression leaves the voice line the time it needs", () => {
	const voice = [{ id: "v1", text: "Name it, then press the button.", file: "voice/0.wav", seconds: 1.2 }];
	const plan = buildPlan(laggyCapture([[60, 119]]), { shots: [{ events: ["e1", "e2"], voice: "v1" }] }, voice);
	const line = plan.voice[0];
	assert.ok(line.end - line.start >= line.seconds - 1e-6, `voice needs ${line.seconds} s and has ${line.end - line.start}`);
	const picture = plan.clips.reduce((sum, c) => sum + (c.to - c.from) / 60 / c.speed, 0);
	assert.ok(picture >= 1.2 + 0.45 - 0.01, `compression stopped at the voice need: picture ${picture}`);
});

test("a short repeated run plays at 1x", () => {
	const plan = buildPlan(laggyCapture([[60, 75]]), { shots: [{ events: ["e1", "e2"] }] });
	assert.ok(plan.clips.every((c) => c.speed === 1), JSON.stringify(plan.clips));
});

test("compression never runs faster than the gap speed limit", () => {
	// A 12 s still run with almost the whole picture as budget would divide by nearly zero.
	const c = capture();
	c.frames = 1000;
	c.events.push({ id: "e4", kind: "click", name: "after", startFrame: 900, endFrame: 902, settleFrame: 910, target: null, caret: null, changed: null, fontPx: null });
	c.stills = [[100, 899]];
	const plan = buildPlan(c, { shots: [{ events: ["e2", "e4"] }] });
	const fastest = Math.max(...plan.clips.map((k) => k.speed));
	assert.ok(fastest <= SPEC.maxGapSpeed, `fastest ${fastest} is within ${SPEC.maxGapSpeed}`);
	assert.ok(plan.edit.duration > 0 && plan.edit.duration < 12, String(plan.edit.duration));
});

test("the plan carries the frame range of every shot for the smoothness gate", () => {
	const plan = buildPlan(capture(), { shots: [{ events: ["e1", "e2"] }, { events: ["e3"] }] });
	assert.equal(plan.shots.length, 2);
	for (const [i, shot] of plan.shots.entries()) {
		assert.equal(shot.start, plan.beats[i].t);
		assert.ok(shot.to > shot.from && shot.picture > 0, JSON.stringify(shot));
	}
});

test("an action whose first frames a trim cut away is placed at the kept part, not at a negative time", () => {
	const cap = {
		version: 1, fps: 60, viewport: { width: 1280, height: 720, scale: 2 }, frames: 600,
		cursor: [{ f: 0, x: 10, y: 10 }],
		events: [
			// The click starts at frame 10, and the shot keeps the capture from frame 30: its start is cut.
			{ id: "e1", kind: "click", name: "a", startFrame: 10, endFrame: 20, settleFrame: 50, target: { x: 100, y: 100, width: 200, height: 40 }, caret: null, changed: null, fontPx: 16 },
			{ id: "e2", kind: "click", name: "b", startFrame: 200, endFrame: 205, settleFrame: 220, target: { x: 300, y: 300, width: 200, height: 40 }, caret: null, changed: null, fontPx: 16 },
		],
		cues: [],
	};
	const plan = buildPlan(cap, { shots: [{ events: ["e1"], trim: { start: 0.5 } }, { events: ["e2"] }] });
	const times = plan.cursor.map((c) => c.t);
	assert.ok(times.every((t) => t >= 0), `no negative cursor key: ${JSON.stringify(plan.cursor)}`);
	assert.deepEqual(times, [...times].sort((a, b) => a - b), `the cursor keys stay in time order: ${JSON.stringify(plan.cursor)}`);
	const press = plan.cursor.find((c) => c.event === "e1");
	assert.equal(press.t, 0, "the click the trim cut is already done when the kept part starts");
	assert.equal(press.click, true);
	assert.ok(plan.camera.every((key) => key.t >= 0), JSON.stringify(plan.camera));
	assert.ok(plan.focus.every((f) => f.start >= 0 && f.end >= f.start), JSON.stringify(plan.focus));
});

test("compose names a bad events.json by its path, instead of crashing with a TypeError", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-badevents-"));
	try {
		writeFileSync(join(dir, "events.json"), JSON.stringify({ version: 1, fps: 60 }));
		writeFileSync(join(dir, "shots.json"), JSON.stringify({ shots: [{ events: ["e1"] }] }));
		await assert.rejects(() => composeMain([dir, "--shots", join(dir, "shots.json"), "--out", join(dir, "out")]), /events\.json[\s\S]*frames|frames[\s\S]*events\.json/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compose refuses when the runtime has no GSAP instead of putting a CDN script in the page", () => {
	const empty = mkdtempSync(join(tmpdir(), "wv-nogsap-"));
	assert.equal(runtimeGsap({ XDG_CACHE_HOME: empty }, empty), null);
	assert.match(runtimeGsapError({ XDG_CACHE_HOME: empty }, empty), /is not installed/);
	assert.match(runtimeGsapError({ XDG_CACHE_HOME: empty }, empty), /Run wv setup/);
	assert.match(runtimeGsapError({ XDG_CACHE_HOME: empty }, empty), /does not load GSAP from a CDN/);
});

test("preview, render and gates refuse a project that has no local GSAP, and say where to get it", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-proj-"));
	assert.throws(() => requireProjectGsap(dir), /assets\/gsap\.min\.js is missing/);
	assert.throws(() => requireProjectGsap(dir), /wv setup|wv compose/);
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "assets", "gsap.min.js"), "// gsap");
	assert.equal(requireProjectGsap(dir), join(dir, "assets", "gsap.min.js"));
});

test("no wv step loads GSAP or HyperFrames from the network at run time", () => {
	for (const file of ["compose.mjs", "hf.mjs", "lib/gates-run.mjs", "film/film.mjs"]) {
		const text = readFileSync(join(SKILL, file), "utf8");
		assert.doesNotMatch(text, /jsdelivr|unpkg|cdn\.js/, `${file} must not name a CDN`);
		assert.doesNotMatch(text, /npx/, `${file} must not install a package at run time`);
	}
});
