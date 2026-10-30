/**
 * Frame-exact capture, opt-in: set WV_INTEGRATION=1.
 *
 * A page runs a CSS animation (a bar that moves 1 px per frame of app time),
 * a requestAnimationFrame counter (drawn as 12 bit blocks) and a setInterval
 * counter. wv capture records it while busy loops load every core. Each
 * captured frame must show exactly one more animation frame, the bar exactly
 * 1 px further, and the interval counter one step every 6 frames.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const skip = process.env.WV_INTEGRATION === "1" ? false : "set WV_INTEGRATION=1 to run the frame-exact capture end to end";
const W = 640;
const H = 360;

const PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #000; width: ${W}px; height: ${H}px; overflow: hidden; }
  #bar { position: absolute; left: 0; top: 0; width: 8px; height: 40px; background: #fff; animation: slide 10s linear forwards; }
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(600px); } }
  .bit { position: absolute; width: 40px; height: 40px; background: #fff; visibility: hidden; }
</style></head><body><div id="bar"></div><div id="raf"></div><div id="tick"></div><script>
  const row = (id, y) => { const host = document.getElementById(id); const cells = [];
    for (let k = 0; k < 12; k++) { const d = document.createElement("div"); d.className = "bit"; d.style.left = (k * 50) + "px"; d.style.top = y + "px"; host.append(d); cells.push(d); }
    return (n) => cells.forEach((d, k) => { d.style.visibility = (n >> k) & 1 ? "visible" : "hidden"; }); };
  const showRaf = row("raf", 100), showTick = row("tick", 200);
  let n = 0, m = 0;
  const loop = () => { n++; showRaf(n); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { m++; showTick(m); }, 100);
</script></body></html>`;

const FLOW = `export default async function (wv) {
	await wv.goto(process.env.WV_FIXTURE_URL, { name: "open" });
	await wv.wait(2500, { name: "run" });
}
`;

function serve() {
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(PAGE);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

function run(args, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		child.on("close", (status) => resolve({ status, out }));
	});
}

/** Reads the bar position and both counters from every frame. */
function readFrames(video) {
	const r = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", "format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
	assert.equal(r.status, 0, String(r.stderr));
	const size = W * H;
	const rows = [];
	for (let off = 0; off + size <= r.stdout.length; off += size) {
		const px = (x, y) => r.stdout[off + y * W + x];
		let bar = -1;
		for (let x = 0; x < W; x++)
			if (px(x, 20) > 128) {
				bar = x;
				break;
			}
		const bits = (y) => Array.from({ length: 12 }, (_, k) => (px(k * 50 + 20, y + 20) > 128 ? 1 << k : 0)).reduce((a, b) => a + b, 0);
		rows.push({ bar, raf: bits(100), tick: bits(200), page: px(W - 1, H - 1) < 64 });
	}
	return rows;
}

test("frame-exact capture: one frame of app time per captured frame on a loaded host", { skip, timeout: 300000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-vclock-"));
	const { server, url } = await serve();
	const burners = Array.from({ length: availableParallelism() }, () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
	try {
		writeFileSync(join(work, "flow.mjs"), FLOW);
		const out = join(work, "cap");
		const result = await run([WV, "capture", join(work, "flow.mjs"), "--out", out, "--width", String(W), "--height", String(H), "--scale", "1", "--fps", "60"], { ...process.env, WV_FIXTURE_URL: url });
		assert.equal(result.status, 0, result.out);
		const events = JSON.parse(readFileSync(join(out, "events.json"), "utf8"));
		assert.equal(events.clock, "virtual");
		const rows = readFrames(join(out, "capture.mp4"));
		// Frames before the page paints are white (about:blank), so only frames on the black page count.
		const live = rows.filter((row) => row.page && row.raf > 0);
		assert.ok(live.length >= 140, `the page ran for ${live.length} frames`);
		const badRaf = [];
		const badBar = [];
		for (let i = 1; i < live.length; i++) {
			if (live[i].raf - live[i - 1].raf !== 1) badRaf.push([i, live[i - 1].raf, live[i].raf]);
			if (live[i].bar >= 0 && live[i - 1].bar >= 0 && live[i].bar < 590 && live[i].bar - live[i - 1].bar !== 1) badBar.push([i, live[i - 1].bar, live[i].bar]);
		}
		assert.deepEqual(badRaf, [], "the animation frame counter steps by exactly 1 per captured frame");
		assert.deepEqual(badBar, [], "the CSS animation moves exactly 1 px per captured frame");
		// The interval runs every 100 ms of app time: a step every 6 frames.
		const steps = [];
		for (let i = 1; i < live.length; i++) if (live[i].tick !== live[i - 1].tick) steps.push(i);
		const gaps = steps.slice(1).map((s, k) => s - steps[k]);
		assert.ok(gaps.length >= 15 && gaps.every((g) => g === 6), `interval steps every ${gaps.join(",")} frames`);
	} finally {
		for (const burner of burners) burner.kill("SIGKILL");
		server.close();
		rmSync(work, { recursive: true, force: true });
	}
});

// A page that writes what its own clock said at load, and clears its storage first: the
// start time must come from the capture controller, not from anything the app keeps.
const PAGE_LOADED = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #000; width: ${W}px; height: ${H}px; overflow: hidden; color: #fff; font: 18px monospace; }
</style></head><body><div id="readout">LOAD 0 DATE 0</div><script>
  try { sessionStorage.clear(); sessionStorage.setItem("wv:clock", "0"); } catch {}
  document.getElementById("readout").textContent = "LOAD " + Math.round(performance.now()) + " DATE " + Date.now();
</script></body></html>`;

const FLOW_LOADED = `export default async function (wv) {
	await wv.goto(process.env.WV_URL_A, { name: "open" });
	await wv.wait(1000, { name: "hold-a" });
	await wv.goto(process.env.WV_URL_B, { name: "to-b" });
	await wv.wait(1000, { name: "hold-b" });
	await wv.goto(process.env.WV_URL_A + "?again=1", { name: "to-a" });
	await wv.wait(1000, { name: "hold-a2" });
}
`;

test("A to B to A: every document reads the capture time at load, and the date never goes back", { skip, timeout: 300000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-load-"));
	const page = (request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(PAGE_LOADED);
	};
	const serverA = createServer(page);
	const serverB = createServer(page);
	const urlA = await new Promise((resolve) => serverA.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${serverA.address().port}/`)));
	const urlB = await new Promise((resolve) => serverB.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${serverB.address().port}/`)));
	try {
		writeFileSync(join(work, "flow.mjs"), FLOW_LOADED);
		const out = join(work, "cap");
		const result = await run([WV, "capture", join(work, "flow.mjs"), "--out", out, "--width", String(W), "--height", String(H), "--scale", "1", "--fps", "60", "--text-every", "100"], { ...process.env, WV_URL_A: urlA, WV_URL_B: urlB });
		assert.equal(result.status, 0, result.out);
		const events = JSON.parse(readFileSync(join(out, "events.json"), "utf8"));
		const stops = ["open", "to-b", "to-a"].map((name) => {
			const event = events.events.find((entry) => entry.name === name);
			assert.ok(event, `the flow navigated: ${name}`);
			return event;
		});
		const read = (snap) => {
			const text = snap.items.map((item) => item.text).join(" ");
			const match = /LOAD (\d+) DATE (\d+)/.exec(text);
			assert.ok(match, `a sample reads the page: ${text}`);
			return { load: Number(match[1]), date: Number(match[2]), frame: snap.f };
		};
		const frameMs = (frame) => (frame * 1000) / 60;
		let previousDate = 0;
		for (let i = 0; i < stops.length; i++) {
			const event = stops[i];
			const from = event.settleFrame ?? event.startFrame;
			const to = (stops[i + 1]?.settleFrame ?? stops[i + 1]?.startFrame) ?? Infinity;
			const samples = events.texts.filter((snap) => snap.f >= from && snap.f < to).map(read);
			assert.ok(samples.length >= 3, `${["A", "B", "A again"][i]}: ${samples.length} samples after the navigation`);
			const first = samples[0];
			// The document loaded between the navigation's start and its settle, at the last
			// advance before that; the reading is that capture time and nothing else.
			// No slack below: a document that opens during the navigation starts at that frame
			// or later, never one frame behind the document it replaces.
			const low = frameMs(event.startFrame);
			const high = frameMs(from) + 100;
			assert.ok(first.load >= low && first.load <= high, `${["A", "B", "A again"][i]}: the load reading ${first.load} ms is the capture time of the navigation (${Math.round(low)} to ${Math.round(high)} ms, frame ${first.frame})`);
			// The first document loads at capture time 0; a later one must not read 0 again.
			if (i > 0) assert.ok(first.load > 0, `document ${i + 1} read 0 at load although the capture was at ${Math.round(frameMs(from))} ms`);
			assert.ok(first.date >= previousDate, `${["A", "B", "A again"][i]}: Date.now() never goes back (${first.date} after ${previousDate})`);
			previousDate = first.date;
			const cleared = samples.every((sample) => sample.date >= first.date - 1);
			assert.equal(cleared, true, `${["A", "B", "A again"][i]}: the date moves forward in the document`);
		}
		// The two origins really were different, and storage was cleared in each document.
		assert.notEqual(new URL(urlA).port, new URL(urlB).port);
	} finally {
		serverA.close();
		serverB.close();
		rmSync(work, { recursive: true, force: true });
	}
});

// The app navigates itself after 2 s of app time: the capture must move the
// install script with every advance, or the new document reads an old value.
const PAGE_SELF_NAV = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #000; width: ${W}px; height: ${H}px; overflow: hidden; color: #fff; font: 18px monospace; }
</style></head><body><div id="readout">LOAD 0 DATE 0</div><script>
  document.getElementById("readout").textContent = "LOAD " + Math.round(performance.now()) + " DATE " + Date.now();
  if (!location.hash) setTimeout(() => { location.hash = "#two"; location.reload(); }, 2000);
</script></body></html>`;

const FLOW_SELF_NAV = `export default async function (wv) {
	await wv.goto(process.env.WV_FIXTURE_URL, { name: "open" });
	await wv.wait(3500, { name: "let it reload" });
}
`;

test("an app-initiated navigation starts at the capture time of the last advance", { skip, timeout: 300000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-selfnav-"));
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(PAGE_SELF_NAV);
	});
	const url = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`)));
	try {
		writeFileSync(join(work, "flow.mjs"), FLOW_SELF_NAV);
		const out = join(work, "cap");
		const result = await run([WV, "capture", join(work, "flow.mjs"), "--out", out, "--width", String(W), "--height", String(H), "--scale", "1", "--fps", "60", "--text-every", "100"], { ...process.env, WV_FIXTURE_URL: url });
		assert.equal(result.status, 0, result.out);
		const events = JSON.parse(readFileSync(join(out, "events.json"), "utf8"));
		const samples = events.texts.map((snap) => {
			const text = snap.items.map((item) => item.text).join(" ");
			const match = /LOAD (\d+) DATE (\d+)/.exec(text);
			return match ? { load: Number(match[1]), frame: snap.f } : null;
		}).filter(Boolean);
		assert.ok(samples.length > 0, "the page text was sampled");
		// The page reloads at 2 s of app time. Every sample after frame 130 (a little over
		// 2 s) belongs to the reloaded document, and its load reading is 2000 ms or more.
		const reloaded = samples.filter((sample) => sample.frame >= 130);
		assert.ok(reloaded.length > 0, `the reload was sampled: ${samples.map((sample) => `${sample.frame}:${sample.load}`).join(", ")}`);
		const stale = reloaded.filter((sample) => sample.load < 1900);
		assert.deepEqual(stale, [], `the reloaded document reads the capture time, not an old value: ${samples.map((sample) => `${sample.frame}:${sample.load}`).join(", ")}`);
		const first = reloaded[0];
		assert.ok(first.load <= (first.frame * 1000) / 60 + 100, `the load reading ${first.load} ms is not ahead of the capture time at frame ${first.frame}`);
	} finally {
		server.close();
		rmSync(work, { recursive: true, force: true });
	}
});

// The real clock: no clock script at all. A document that loads at 2.5 s of
// capture time must still read a small performance.now(), as a real browser does.
const PAGE_REAL_NAV = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #000; width: ${W}px; height: ${H}px; overflow: hidden; color: #fff; font: 18px monospace; }
</style></head><body><div id="readout">LOAD 0</div><script>
  document.getElementById("readout").textContent = "LOAD " + Math.round(performance.now());
  if (!location.hash) setTimeout(() => { location.hash = "#two"; location.reload(); }, 2500);
</script></body></html>`;

test("a capture on the real clock installs no clock script, also after a navigation", { skip, timeout: 300000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-realclock-"));
	const server = createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(PAGE_REAL_NAV);
	});
	const url = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`)));
	try {
		writeFileSync(join(work, "flow.mjs"), `export default async function (wv) {\n\tawait wv.goto(process.env.WV_FIXTURE_URL, { name: "open" });\n\tawait wv.wait(4000, { name: "let it reload" });\n}\n`);
		const out = join(work, "cap");
		const result = await run([WV, "capture", join(work, "flow.mjs"), "--out", out, "--width", String(W), "--height", String(H), "--scale", "1", "--fps", "30", "--clock", "real", "--text-every", "100"], { ...process.env, WV_FIXTURE_URL: url });
		assert.equal(result.status, 0, result.out);
		const events = JSON.parse(readFileSync(join(out, "events.json"), "utf8"));
		assert.equal(events.clock, "real");
		const samples = events.texts.map((snap) => {
			const match = /LOAD (\d+)/.exec(snap.items.map((item) => item.text).join(" "));
			return match ? { load: Number(match[1]), frame: snap.f } : null;
		}).filter(Boolean);
		assert.ok(samples.length > 0, "the page text was sampled");
		// 30 fps: frame 75 is 2.5 s, where the page reloads. A virtual clock would read 2500 ms or more.
		const after = samples.filter((sample) => sample.frame >= 90);
		assert.ok(after.length > 0, "the reloaded document was sampled");
		const virtual = after.filter((sample) => sample.load >= 2000);
		assert.deepEqual(virtual, [], `the real clock stays real: ${after.map((sample) => `${sample.frame}:${sample.load}`).join(", ")}`);
	} finally {
		server.close();
		rmSync(work, { recursive: true, force: true });
	}
});
