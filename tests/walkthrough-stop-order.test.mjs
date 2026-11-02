/**
 * The order of a stop: a render's own finally must not clean up while a
 * descendant that ignores SIGTERM still runs. If it does, the descendant writes
 * into the folder again, and the shutdown has no cleanup left to remove it,
 * because the finally unregistered that cleanup. The shutdown owns the cleanup
 * during a stop, and runs it after the child trees are gone.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan } from "../skills/walkthrough-video/scripts/compose.mjs";
import { sleep } from "../skills/walkthrough-video/scripts/lib/proc.mjs";

const WV = fileURLToPath(new URL("../skills/walkthrough-video/scripts/wv.mjs", import.meta.url));

async function waitForFile(file, ms = 10000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (existsSync(file)) return;
		await sleep(50);
	}
	assert.fail(`${file} never appeared`);
}

const kill = (pid) => {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
};

function project(root) {
	const dir = join(root, "proj");
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(join(dir, "assets", "gsap.min.js"), "// gsap");
	const plan = buildPlan(
		{
			version: 1, fps: 60, viewport: { width: 1280, height: 720, scale: 2 }, frames: 300,
			cursor: [{ f: 0, x: 900, y: 600 }],
			events: [{ id: "e1", kind: "goto", name: "open", startFrame: 0, endFrame: 20, settleFrame: 30, target: null, caret: null, changed: null, fontPx: null }],
			cues: [],
		},
		{ shots: [{ events: ["e1"], caption: "Open" }] },
	);
	writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
	return dir;
}

/**
 * A stand-in for HyperFrames. Its grandchild ignores SIGTERM and keeps writing
 * a frame into the render's cache folder, as a frame extractor would, until
 * the shutdown escalates to SIGKILL. It has its own stdio, as an ffmpeg that
 * HyperFrames starts with its own pipes: so wv's pipe closes when the
 * HyperFrames process ends, and the render's await returns before the
 * grandchild stops.
 */
function stubbornHyperframes(home, pidFile) {
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(
		bin,
		`#!/bin/sh
cache=""
while [ $# -gt 0 ]; do [ "$1" = "--frames-cache-dir" ] && cache="$2"; shift; done
sh -c 'trap "" TERM; while :; do mkdir -p "$0" && touch "$0/frame"; sleep 0.05; done' "$cache" </dev/null >/dev/null 2>&1 &
echo $! > ${JSON.stringify(pidFile)}
wait
`,
	);
	chmodSync(bin, 0o755);
}

for (const command of ["render", "preview"]) {
	test(`a SIGTERM during wv ${command} removes the cache folder after a stubborn grandchild stops`, { timeout: 40000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), `wv-stop-order-${command}-`));
		const home = join(root, "home");
		const base = join(root, "cache");
		mkdirSync(base, { recursive: true });
		const pidFile = join(root, "grandchild.pid");
		stubbornHyperframes(home, pidFile);
		const dir = project(root);
		const args = command === "render" ? [WV, "render", dir, "--out", join(root, "film.mp4")] : [WV, "preview", dir];
		const watcher = spawn(process.execPath, args, {
			env: { ...process.env, XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		watcher.stderr.on("data", (chunk) => (stderr += chunk));
		let grandchild = 0;
		try {
			await waitForFile(pidFile);
			grandchild = Number(readFileSync(pidFile, "utf8").trim());
			const [cache] = readdirSync(base);
			assert.ok(cache, "the render made its own cache folder");
			await waitForFile(join(base, cache, "frame"));
			watcher.kill("SIGTERM");
			const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
			assert.equal(code, 143, stderr);
			assert.deepEqual(readdirSync(base), [], `the cache folder is gone after the stop: ${stderr}`);
			if (command === "preview") assert.equal(existsSync(join(dir, "preview.html")), false, "preview.html is gone");
		} finally {
			watcher.kill("SIGKILL");
			if (grandchild) kill(grandchild);
			rmSync(root, { recursive: true, force: true });
		}
	});
}
