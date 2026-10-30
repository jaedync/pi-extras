/**
 * wv lift end to end, opt-in: set WV_INTEGRATION=1. A fixture app with a
 * dark landing, a light room behind a button, a font file, a spring and a
 * keyframe; lift with a --flow must find all of them.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));
const skip = process.env.WV_INTEGRATION === "1" ? false : "set WV_INTEGRATION=1 to run wv lift in a browser";

const PAGE = `<!doctype html><html><head><style>
  @font-face { font-family: 'Fixture Sans'; src: url('/fonts/fixture.woff2') format('woff2'); font-weight: 400 800; }
  :root { --ground: #1d2433; --paper: #fbf7ef; --ink: #eef1f6; --muted: #9aa4b8; --accent: #e0663a; --accent-soft: rgba(224,102,58,0.2); }
  body { margin: 0; font-family: 'Fixture Sans', sans-serif; }
  .landing { background: var(--ground); color: var(--ink); height: 100vh; }
  .landing h1 { font-size: 72px; font-weight: 800; margin: 0; }
  .landing p { color: var(--muted); font-size: 20px; }
  .landing button { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .room { display: none; background: var(--paper); color: #222; height: 100vh; }
  body.in .landing { display: none; } body.in .room { display: block; }
  @keyframes deal { from { transform: translateY(40px); } to { transform: none; } }
</style></head><body>
  <div class="landing"><h1>Fixture</h1><p>A tagline that is long enough to count</p><button id="go">Start</button></div>
  <div class="room"><h2>The room</h2><p>Room text in the app</p></div>
  <script>document.getElementById("go").onclick = () => document.body.classList.add("in");</script>
</body></html>`;

const FLOW = `export default async function (page, lift) {
	await page.click("#go");
	await page.waitForSelector(".room h2", { state: "visible" });
	await lift.state("room");
}
`;

function serve() {
	const server = createServer((request, response) => {
		if (request.url.startsWith("/fonts/")) {
			response.writeHead(200, { "content-type": "font/woff2" });
			return response.end(Buffer.from("not a real font"));
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(PAGE);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

function run(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		child.on("close", (status) => resolve({ status, out }));
	});
}

test("wv lift takes the ground, inks, fonts, springs and the stylesheet from the live page", { skip, timeout: 120000 }, async () => {
	const work = mkdtempSync(join(tmpdir(), "wv-lift-"));
	const { server, url } = await serve();
	try {
		writeFileSync(join(work, "flow.mjs"), FLOW);
		const out = join(work, "lift");
		const result = await run([WV, "lift", url, "--flow", join(work, "flow.mjs"), "--out", out, "--width", "1280", "--height", "720", "--wait", "200"]);
		assert.equal(result.status, 0, result.out);
		const t = JSON.parse(readFileSync(join(out, "tokens.json"), "utf8"));
		assert.equal(t.ground.color, "#1d2433");
		assert.equal(t.ground.var, "--ground");
		assert.equal(t.ink.color, "#eef1f6");
		assert.equal(t.inkSecondary[0].color, "#9aa4b8");
		assert.equal(t.accent.color, "#e0663a");
		assert.deepEqual(t.surfaces.map((s) => s.color), ["#fbf7ef"]);
		assert.equal(t.fonts[0].family, "Fixture Sans");
		assert.equal(t.fonts[0].weight, 800);
		assert.equal(t.motion.springs[0].value, "cubic-bezier(0.34, 1.56, 0.64, 1)");
		assert.deepEqual(t.motion.keyframes, ["deal"]);
		assert.deepEqual(t.states.map((s) => [s.name, s.ground.color]), [["start", "#1d2433"], ["room", "#fbf7ef"]]);
		assert.equal(t.inksByGround["#fbf7ef"][0].color, "#222222");
		assert.ok(existsSync(join(out, "fonts", "fixture.woff2")), "the font file is copied");
		assert.ok(existsSync(join(out, "lift-room.png")));
		const markup = readFileSync(join(out, "markup-room.html"), "utf8");
		assert.match(markup, /<div class="room"><h2>The room<\/h2>/);
		assert.doesNotMatch(markup, /<script/);
		const css = readFileSync(join(out, "app.css"), "utf8");
		assert.doesNotMatch(css, /transition/);
		assert.match(css, /url\("?fonts\/fixture\.woff2/);
		assert.match(readFileSync(join(out, "brand.css"), "utf8"), /--wv-spring: cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/);
	} finally {
		server.close();
		rmSync(work, { recursive: true, force: true });
	}
});
