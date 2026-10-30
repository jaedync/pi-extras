/**
 * End to end capture, opt-in: set WV_INTEGRATION=1.
 *
 * Serves a fixture page (an input and a button that adds a list item with a
 * 300 ms transition), runs `wv capture` at scale 1 and 30 fps, then checks the
 * frame count and the event geometry. It uses the browsers in
 * ~/.cache/ms-playwright and the playwright-core in this repo's node_modules
 * when the cache install from `wv setup` is absent, so it runs before setup.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stagingDir } from "../skills/walkthrough-video/scripts/lib/capture.mjs";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const skip = process.env.WV_INTEGRATION === "1" ? false : "set WV_INTEGRATION=1 to run the capture end to end";

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture</title><style>
  body { font-family: system-ui, sans-serif; margin: 40px; background: #fff; color: #111; }
  label { display: block; font-size: 18px; margin-bottom: 6px; }
  input { width: 320px; height: 40px; font-size: 20px; padding: 4px 8px; }
  button { margin-top: 20px; font-size: 18px; padding: 10px 18px; }
  #list { margin-top: 16px; padding: 0; list-style: none; width: 320px; }
  #list li { height: 32px; font-size: 18px; background: #eef; opacity: 0; transform: translateY(-8px);
             transition: opacity 300ms ease, transform 300ms ease; }
  #list li.in { opacity: 1; transform: none; }
  #note { width: 320px; min-height: 40px; margin-top: 16px; border: 1px solid #888; font-size: 18px; padding: 4px 8px; }
</style></head>
<body>
  <h1>Walkthrough fixture</h1>
  <label for="name">Player name</label>
  <input id="name" placeholder="Your name">
  <button id="add">Add item</button>
  <div id="note" contenteditable="true" aria-label="Note"></div>
  <ul id="list"></ul>
  <input id="pw" type="password" style="width: 200px; font-size: 18px">
  <p id="short" style="width: 900px; font-size: 18px">Ready</p>
  <button id="vanish">Reveal</button>
  <div style="height: 900px"></div>
  <button id="far">Far below</button>
  <script>
    document.getElementById("vanish").addEventListener("click", (e) => e.target.remove());
    document.addEventListener("keydown", (e) => { if (e.key === "Enter") document.body.dataset.entered = "1"; });
    let count = 0;
    document.getElementById("add").addEventListener("click", () => {
      const item = document.createElement("li");
      item.textContent = "Item " + (++count);
      document.getElementById("list").append(item);
      requestAnimationFrame(() => item.classList.add("in"));
    });
  </script>
</body></html>`;

const FLOW = `export default async function (wv) {
	await wv.goto(process.env.WV_FIXTURE_URL, { name: "open" });
	await wv.type("#name", "Alice", { name: "type-name" });
	await wv.type("#note", "Hello", { name: "type-note" });
	await wv.click("#add", { name: "add-item", label: "Add item" });
	await wv.mark("new-item", { selector: "#list li", caption: "The item appears" });
	await wv.type("#pw", "hunter22", { name: "password" });
	await wv.mark("pw-value", { selector: "#pw" });
	await wv.mark("name-value", { selector: "#name" });
	await wv.mark("pause");
	await wv.mark("short", { selector: "#short" });
	await wv.click("#vanish", { name: "vanish" });
	await wv.key("Enter", { name: "enter" });
	await wv.waitFor(() => document.body.dataset.entered === "1", { name: "entered", timeoutMs: 2000 });
	const guest = await wv.secondary();
	await guest.goto(process.env.WV_FIXTURE_URL + "?guest=1");
	await guest.waitForSelector("#add");
	await wv.mark("guest-ready", { selector: "#add" });
	await wv.click("#far", { name: "far" });
	await wv.wait(400, { name: "hold" });
}
`;

// Fails after the page has painted, so the staging folder already has frames.
const FAILING_FLOW = `export default async function (wv) {
	await wv.goto(process.env.WV_FIXTURE_URL, { name: "open" });
	throw new Error("the flow stopped here");
}
`;

function serve() {
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(PAGE);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** spawnSync would block this process and with it the fixture server, so the capture runs async. */
function runCapture(args, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 200000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ status: -1, stdout, stderr: `${stderr}\n${error.message}` });
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});
}

test("wv capture writes an exact frame count and event geometry", { skip, timeout: 240000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-capture-"));
	const { server, url } = await serve();
	try {
		const flowPath = join(work, "flow.mjs");
		writeFileSync(flowPath, FLOW);
		const out = join(work, "capture");
		const run = await runCapture([WV, "capture", flowPath, "--out", out, "--scale", "1", "--fps", "30", "--gpu", "auto"], { ...process.env, WV_FIXTURE_URL: url });
		assert.equal(run.status, 0, `capture failed (status ${run.status}):\n${run.stderr}\n${run.stdout}`);

		const eventsPath = join(out, "events.json");
		assert.ok(existsSync(eventsPath), "events.json exists");
		assert.ok(existsSync(join(out, "capture.mp4")), "capture.mp4 exists");
		assert.ok(existsSync(join(out, "poster.png")), "poster.png exists");
		const events = JSON.parse(readFileSync(eventsPath, "utf8"));
		assert.equal(events.version, 1);
		assert.equal(events.fps, 30);
		assert.deepEqual(events.viewport, { width: 1280, height: 720, scale: 1 });

		const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", join(out, "capture.mp4")], { encoding: "utf8" });
		assert.equal(probe.status, 0, probe.stderr);
		assert.equal(Number(probe.stdout.trim()), events.frames, "ffprobe frame count equals events.json frames");
		assert.ok(events.frames > 0, "frames > 0");

		for (const event of events.events) {
			assert.ok(event.startFrame <= event.endFrame, `${event.id} start <= end`);
			assert.ok(event.endFrame <= event.settleFrame, `${event.id} end <= settle`);
		}

		const typed = events.events.find((event) => event.kind === "type");
		const clicked = events.events.find((event) => event.kind === "click");
		const marked = events.events.find((event) => event.name === "new-item");
		assert.ok(events.events.some((event) => event.name === "guest-ready"), "the secondary browser loaded the page without being captured");
		assert.ok(typed && typed.text === "Alice", "the type event records the text");
		assert.ok(typed.caret, "the type event has a caret box");
		// The text after each settle, for the text floor on a film's clips.
		assert.ok(events.texts.length >= events.events.filter((event) => Number.isFinite(event.settleFrame)).length - 1, `${events.texts.length} text snapshots`);
		const label = events.texts[0].items.find((item) => item.text === "Player name");
		assert.ok(label, "the first snapshot has the label");
		assert.equal(label.px, 18);
		assert.ok(label.rect.w > 20 && label.rect.h > 10, JSON.stringify(label.rect));
		assert.ok(typed.target, "the type event has a target box");
		assert.ok(typed.caret.x > typed.target.x, `caret x ${typed.caret.x} is right of the input left edge ${typed.target.x}`);
		assert.ok(typed.caret.x <= typed.target.x + typed.target.width, "caret is inside the input");
		assert.ok(typed.caret.y >= typed.target.y - 1 && typed.caret.y <= typed.target.y + typed.target.height + 1, "caret is inside the input vertically");

		const noted = events.events.find((event) => event.name === "type-note");
		assert.ok(noted && noted.caret, "the contenteditable type event has a caret box");
		assert.ok(noted.caret.x > noted.target.x, `contenteditable caret x ${noted.caret.x} is right of the box left edge ${noted.target.x}`);
		assert.ok(noted.caret.y >= noted.target.y - 1 && noted.caret.y <= noted.target.y + noted.target.height, "contenteditable caret is inside the box");

		assert.ok(clicked && clicked.changed, "the click changed something");
		assert.ok(marked && marked.target, "the mark recorded the new item box");
		assert.ok(overlaps(clicked.changed, marked.target), `click changed box ${JSON.stringify(clicked.changed)} overlaps the new item ${JSON.stringify(marked.target)}`);

		// A click that removes its own button must not wait for the element's font size.
		const vanish = events.events.find((event) => event.name === "vanish");
		assert.ok(vanish.settleFrame - vanish.startFrame < events.fps * 5, `vanish settle took ${vanish.settleFrame - vanish.startFrame} frames`);
		assert.equal(vanish.fontPx, 18, "the font size is read before the click");
		const password = events.events.find((event) => event.name === "password");
		assert.ok(!JSON.stringify(events).includes("hunter22"), "a typed password is not written to events.json");
		assert.equal(password.text, "[8 characters hidden]");
		assert.equal(events.events.find((event) => event.name === "pause").target, null, "a mark with no selector has no box");
		// A mark on an input frames the value text, not the empty part of the field.
		const nameValue = events.events.find((event) => event.name === "name-value");
		const nameInput = events.events.find((event) => event.name === "type-name").target;
		assert.ok(nameValue && nameValue.target, "the input mark has a box");
		assert.ok(nameValue.target.width > 20 && nameValue.target.width < 160, `input mark box ${JSON.stringify(nameValue.target)} is the value text`);
		assert.ok(nameValue.target.x > nameInput.x, "the value box starts inside the input");
		assert.ok(nameValue.target.y >= nameInput.y - 1 && nameValue.target.y <= nameInput.y + nameInput.height, "the value box is inside the input vertically");
		const pwValue = events.events.find((event) => event.name === "pw-value");
		assert.ok(pwValue.target.width < 150, `password mark box ${JSON.stringify(pwValue.target)} is the value text`);
		// A mark frames the text itself, not the 900 px block around it.
		const short = events.events.find((event) => event.name === "short");
		assert.ok(short.target.width < 200, `mark box ${JSON.stringify(short.target)} is the text, not the block`);
		// A control below the fold is measured after Playwright scrolls it into view.
		const far = events.events.find((event) => event.name === "far");
		assert.ok(far.target.y >= 0 && far.target.y + far.target.height <= 720, `far target ${JSON.stringify(far.target)} is inside the viewport`);
		const key = events.events.find((event) => event.name === "enter");
		assert.ok(key && key.kind === "key" && key.text === "Enter", "the key press is an event");

		const poster = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(out, "poster.png")], { encoding: "utf8" });
		assert.match(poster.stdout.trim(), /^1280,720/, `poster is 1280x720 (got ${poster.stdout.trim()})`);
	} finally {
		server.close();
		rmSync(work, { recursive: true, force: true });
	}
});

test("a failed capture keeps the last good capture in --out", { skip, timeout: 240000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-capture-keep-"));
	const { server, url } = await serve();
	try {
		const flowPath = join(work, "broken.mjs");
		writeFileSync(flowPath, FAILING_FLOW);
		const out = join(work, "cap");
		mkdirSync(out);
		for (const name of ["capture.mp4", "events.json", "poster.png"]) writeFileSync(join(out, name), "old capture");
		const run = await runCapture([WV, "capture", flowPath, "--out", out, "--scale", "1", "--fps", "30", "--gpu", "auto"], { ...process.env, WV_FIXTURE_URL: url });
		assert.notEqual(run.status, 0, "the capture failed");
		assert.match(run.stderr, /stopped here/, run.stderr);
		for (const name of ["capture.mp4", "events.json", "poster.png"]) assert.equal(readFileSync(join(out, name), "utf8"), "old capture", `${name} survived`);
		assert.equal(existsSync(stagingDir(out)), false, "the staging folder is gone");
	} finally {
		server.close();
		rmSync(work, { recursive: true, force: true });
	}
});

test("a --draft capture with --text-every writes a contact sheet and text samples on the interval", { skip, timeout: 240000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-capture-draft-"));
	const { server, url } = await serve();
	try {
		const flowPath = join(work, "flow.mjs");
		writeFileSync(flowPath, FLOW);
		const out = join(work, "draft");
		const run = await runCapture([WV, "capture", flowPath, "--out", out, "--draft", "--text-every", "500", "--gpu", "auto"], { ...process.env, WV_FIXTURE_URL: url });
		assert.equal(run.status, 0, `capture failed (status ${run.status}):\n${run.stderr}\n${run.stdout}`);
		assert.match(run.stderr, /scale 1, 10 fps, .*real clock/);
		assert.ok(existsSync(join(out, "sheet.jpg")), "sheet.jpg is published");
		const events = JSON.parse(readFileSync(join(out, "events.json"), "utf8"));
		assert.equal(events.fps, 10);
		// 500 ms at 10 fps: a sample every 5th frame, beside the settled samples of the events.
		const onInterval = events.texts.filter((snap) => snap.f > 0 && snap.f % 5 === 0);
		assert.ok(onInterval.length >= 3, `interval samples: ${events.texts.map((s) => s.f).join(",")}`);
		assert.ok(onInterval.some((snap) => snap.items.some((item) => item.text === "Walkthrough fixture")));
	} finally {
		server.close();
		rmSync(work, { recursive: true, force: true });
	}
});

test("SIGINT during a real capture runs wv's own shutdown, not Playwright's exit", { skip, timeout: 180000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-int-"));
	const pidFile = join(work, "stubborn.pid");
	const marker = join(work, "cleanup-ran");
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(PAGE);
	});
	const url = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`)));
	let watcher = null;
	try {
		const flow = join(work, "flow.mjs");
		const stubbornFile = join(work, "stubborn.sh");
		// A shell that ignores SIGTERM: only the tree walk and the escalation reach it.
		writeFileSync(stubbornFile, `#!/bin/sh\ntrap "" TERM\nwhile true; do sleep 0.2; done\n`);
		chmodSync(stubbornFile, 0o755);
		writeFileSync(
			flow,
			`import { writeFileSync } from "node:fs";
import { spawnChild } from ${JSON.stringify(fileURLToPath(new URL("../skills/walkthrough-video/scripts/lib/proc.mjs", import.meta.url)))};
import { onSignalCleanup } from ${JSON.stringify(fileURLToPath(new URL("../skills/walkthrough-video/scripts/lib/signals.mjs", import.meta.url)))};
export default async function (wv) {
	await wv.goto(process.env.WV_FIXTURE_URL, { name: "open" });
	// The marker proves that wv's shutdown reached its cleanups; Playwright's own exit does not.
	onSignalCleanup(() => writeFileSync(process.env.WV_MARKER, "the cleanups ran"), "the test cleanup");
	const stubborn = spawnChild(${JSON.stringify(stubbornFile)}, [], { stdio: "ignore" });
	writeFileSync(process.env.WV_CHILD_PID, String(stubborn.pid));
	await wv.wait(60000, { name: "hold" });
}
`,
		);
		const out = join(work, "cap");
		watcher = spawn(process.execPath, [WV, "capture", flow, "--out", out, "--width", "640", "--height", "360", "--scale", "1", "--fps", "30"], {
			env: { ...process.env, WV_FIXTURE_URL: url, WV_CHILD_PID: pidFile, WV_MARKER: marker },
			stdio: "ignore",
		});
		for (let i = 0; i < 1200 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(existsSync(pidFile), true, "the capture reached the flow");
		const child = Number(readFileSync(pidFile, "utf8"));
		watcher.kill("SIGINT");
		const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
		assert.equal(code, 130, "a Ctrl-C exits 130");
		assert.equal(existsSync(marker), true, "wv's own shutdown ran its cleanup; Playwright's handler would have exited first");
		const gone = async () => {
			for (let i = 0; i < 60; i++) {
				try {
					process.kill(child, 0);
				} catch {
					return true;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return false;
		};
		assert.equal(await gone(), true, `the stubborn child ${child} is still running`);
		assert.equal(existsSync(stagingDir(out)), false, "the capture staging folder is gone");
	} finally {
		server.close();
		watcher?.kill("SIGKILL");
		rmSync(work, { recursive: true, force: true });
	}
});
