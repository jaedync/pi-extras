/**
 * Stopping wv: a host timeout, a Ctrl-C or systemd sends SIGTERM or SIGINT, and
 * Node skips every finally block. These tests run real processes, because the
 * whole point is what the kernel does when wv is told to stop.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan } from "../skills/walkthrough-video/scripts/compose.mjs";
import { run, sleep } from "../skills/walkthrough-video/scripts/lib/proc.mjs";

const SKILL = fileURLToPath(new URL("../skills/walkthrough-video/scripts/", import.meta.url));
const WV = join(SKILL, "wv.mjs");

/** Waits for a file to appear, or fails the wait. */
/** Bounded polling: a fixed sleep is a race, and one sample after it proves nothing. */
async function waitFor(predicate, ms = 10000, what = "the condition") {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

async function waitForFile(file, { tries = 200, ms = 50 } = {}) {
	for (let i = 0; i < tries; i++) {
		if (existsSync(file)) return;
		await sleep(ms);
	}
	assert.fail(`${file} never appeared`);
}

/** True when the process still exists. */
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a timeout kills the whole process group, not only the direct child", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-tree-"));
	const pidFile = join(dir, "grandchild.pid");
	const tree = join(dir, "tree.sh");
	// The shell is the direct child; sleep is its child, in the same process group.
	writeFileSync(tree, `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n`);
	chmodSync(tree, 0o755);
	const result = await run(tree, [], { timeoutMs: 700 });
	assert.notEqual(result.code, 0, "the timeout ends the run");
	const grandchild = Number(readFileSync(pidFile, "utf8").trim());
	await sleep(300);
	assert.equal(alive(grandchild), false, `the grandchild ${grandchild} is still running`);
});

test("SIGTERM runs the cleanups, stops the children and exits 143", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-signal-"));
	const marker = join(dir, "marker");
	const childPidFile = join(dir, "child.pid");
	writeFileSync(marker, "x");
	const script = join(dir, "wait.mjs");
	writeFileSync(
		script,
		`import { rmSync, writeFileSync } from "node:fs";
import { spawnChild, sleep } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
onSignalCleanup(() => rmSync(${JSON.stringify(marker)}, { force: true }));
const child = spawnChild("sleep", ["60"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
await sleep(60000);
`,
	);
	const watcher = spawn(process.execPath, [script], { stdio: "ignore" });
	await waitForFile(childPidFile);
	const childPid = Number(readFileSync(childPidFile, "utf8"));
	watcher.kill("SIGTERM");
	const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
	assert.equal(code, 143, "SIGTERM exits with 143");
	assert.equal(existsSync(marker), false, "the cleanup ran");
	await sleep(300);
	assert.equal(alive(childPid), false, `the child ${childPid} is still running`);
});

test("a SIGTERM during wv preview removes preview.html and the cache folder, and stops the render's group", { timeout: 40000 }, async () => {
	const home = mkdtempSync(join(tmpdir(), "wv-prev-home-"));
	const base = mkdtempSync(join(tmpdir(), "wv-prev-cache-"));
	const project = mkdtempSync(join(tmpdir(), "wv-prev-proj-"));
	mkdirSync(join(project, "assets"), { recursive: true });
	writeFileSync(join(project, "assets", "gsap.min.js"), "// gsap");
	const plan = buildPlan(
		{
			version: 1, fps: 60, viewport: { width: 1280, height: 720, scale: 2 }, frames: 300,
			cursor: [{ f: 0, x: 900, y: 600 }],
			events: [{ id: "e1", kind: "goto", name: "open", startFrame: 0, endFrame: 20, settleFrame: 30, target: null, caret: null, changed: null, fontPx: null }],
			cues: [],
		},
		{ shots: [{ events: ["e1"], caption: "Open" }] },
	);
	writeFileSync(join(project, "plan.json"), JSON.stringify(plan));
	const shellPid = join(project, "render.pid");
	const sleepPid = join(project, "sleep.pid");
	// A stand-in for HyperFrames: it records its own pid and its child's, then runs a minute.
	const bin = join(home, "pi-walkthrough-video", "node_modules", ".bin", "hyperframes");
	mkdirSync(dirname(bin), { recursive: true });
	writeFileSync(bin, `#!/bin/sh\necho $$ > ${shellPid}\nsleep 60 &\necho $! > ${sleepPid}\nwait\n`);
	chmodSync(bin, 0o755);
	const watcher = spawn(process.execPath, [WV, "preview", project], {
		env: { ...process.env, XDG_CACHE_HOME: home, HYPERFRAMES_EXTRACT_CACHE_DIR: base },
		stdio: "ignore",
	});
	await waitForFile(sleepPid);
	const preview = join(project, "preview.html");
	assert.equal(existsSync(preview), true, "the preview composition is on disk during the render");
	assert.equal(readdirSync(base).length, 1, "the render's own cache folder is there");
	watcher.kill("SIGTERM");
	const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
	assert.equal(code, 143);
	assert.equal(existsSync(preview), false, "preview.html is removed, so the next hyperframes check sees one composition");
	assert.deepEqual(readdirSync(base), [], "the killed render's cache folder is gone");
	const render = Number(readFileSync(shellPid, "utf8"));
	const child = Number(readFileSync(sleepPid, "utf8"));
	await sleep(400);
	assert.equal(alive(render), false, "the render's shell is gone");
	assert.equal(alive(child), false, "the render's child is gone");
});

test("a parent killed by a group SIGKILL leaves no child alive", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-group-"));
	const tree = join(dir, "tree.sh");
	writeFileSync(tree, `#!/bin/sh\necho $$ > ${join(dir, "shell.pid")}\nsleep 60 &\necho $! > ${join(dir, "sleep.pid")}\nwait\n`);
	chmodSync(tree, 0o755);
	const parent = join(dir, "parent.mjs");
	// The stand-in for wv: it starts a tree and waits, as a render does.
	writeFileSync(parent, `import { runStreaming } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};\nawait runStreaming(${JSON.stringify(tree)}, []);\n`);
	const holder = spawn(process.execPath, [parent], { detached: true, stdio: "ignore" });
	await waitForFile(join(dir, "sleep.pid"));
	const shellPid = Number(readFileSync(join(dir, "shell.pid"), "utf8"));
	const sleepPid = Number(readFileSync(join(dir, "sleep.pid"), "utf8"));
	try {
		// What the Pi bash tool does to stop a command: one SIGKILL to the process group.
		process.kill(-holder.pid, "SIGKILL");
		await new Promise((resolve) => holder.on("exit", resolve));
		// A loaded host can take a moment to reap them: wait, do not sample once.
		const gone = async (pid) => {
			for (let i = 0; i < 100; i++) {
				if (!alive(pid)) return true;
				await sleep(50);
			}
			return false;
		};
		assert.equal(await gone(shellPid), true, `the shell ${shellPid} outlived the group kill`);
		assert.equal(await gone(sleepPid), true, `the sleep ${sleepPid} outlived the group kill`);
	} finally {
		for (const pid of [shellPid, sleepPid]) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SIGHUP runs the cleanups and stops the children, and a second signal does not cut them short", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-hup-"));
	const marker = join(dir, "marker");
	const childPidFile = join(dir, "child.pid");
	const seenFile = join(dir, "seen");
	writeFileSync(marker, "x");
	const script = join(dir, "wait.mjs");
	writeFileSync(
		script,
		`import { rmSync, writeFileSync } from "node:fs";
import { spawnChild, sleep } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
const child = spawnChild("sleep", ["60"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
onSignalCleanup(async () => {
	await sleep(600);
	rmSync(${JSON.stringify(marker)}, { force: true });
	writeFileSync(${JSON.stringify(seenFile)}, "done");
});
await sleep(60000);
`,
	);
	const watcher = spawn(process.execPath, [script], { stdio: "ignore" });
	await waitForFile(childPidFile);
	const childPid = Number(readFileSync(childPidFile, "utf8"));
	watcher.kill("SIGHUP");
	await sleep(150);
	watcher.kill("SIGHUP");
	const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
	assert.equal(code, 129, "SIGHUP exits with 129, as a shell reports it");
	assert.equal(existsSync(seenFile), true, "the cleanup ran to its end, also after the second signal");
	assert.equal(existsSync(marker), false, "the cleanup removed the file");
	await sleep(300);
	assert.equal(alive(childPid), false, `the child ${childPid} is still running`);
});

test("the signal path stops the children before it runs the cleanups", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-order-"));
	const childPidFile = join(dir, "child.pid");
	const orderFile = join(dir, "order");
	const script = join(dir, "wait.mjs");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
import { spawnChild, sleep } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
const child = spawnChild("sleep", ["60"], { stdio: "ignore" });
const pid = child.pid;
writeFileSync(${JSON.stringify(childPidFile)}, String(pid));
onSignalCleanup(() => {
	let alive = false;
	try { process.kill(pid, 0); alive = true; } catch {}
	writeFileSync(${JSON.stringify(orderFile)}, alive ? "child-still-running" : "child-already-stopped");
});
await sleep(60000);
`,
	);
	const watcher = spawn(process.execPath, [script], { stdio: "ignore" });
	await waitForFile(childPidFile);
	watcher.kill("SIGTERM");
	await new Promise((resolve) => watcher.on("exit", resolve));
	assert.equal(readFileSync(orderFile, "utf8"), "child-already-stopped", "the render cannot write into its cache folder after the cleanup removed it");
});

test("a grandchild that ignores SIGTERM is stopped before the cleanup, with ignored pipes and with inherited pipes", { timeout: 40000 }, async () => {
	for (const mode of ["ignore", "inherit"]) {
		const dir = mkdtempSync(join(tmpdir(), `wv-stubborn-${mode}-`));
		const pidFile = join(dir, "grandchild.pid");
		const orderFile = join(dir, "order");
		const tree = join(dir, "tree.sh");
		writeFileSync(tree, `#!/bin/sh\nsh -c 'trap "" TERM; sleep 60' &\necho $! > ${pidFile}\nwait\n`);
		chmodSync(tree, 0o755);
		const script = join(dir, "wait.mjs");
		writeFileSync(
			script,
			`import { readFileSync, writeFileSync } from "node:fs";
import { spawnChild, sleep } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
const child = spawnChild(${JSON.stringify(tree)}, [], { stdio: ${JSON.stringify(mode === "ignore" ? "ignore" : "inherit")} });
for (let i = 0; i < 100; i++) { try { readFileSync(${JSON.stringify(pidFile)}); break; } catch { await sleep(20); } }
onSignalCleanup(() => {
	const grandchild = Number(readFileSync(${JSON.stringify(pidFile)}, "utf8"));
	let alive = false;
	try { process.kill(grandchild, 0); alive = true; } catch {}
	writeFileSync(${JSON.stringify(orderFile)}, alive ? "grandchild-still-running" : "grandchild-already-stopped");
});
await sleep(60000);
`,
		);
		const watcher = spawn(process.execPath, [script], { stdio: "ignore" });
		try {
			await waitForFile(pidFile);
			await sleep(200);
			watcher.kill("SIGTERM");
			const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
			assert.equal(code, 143, `${mode}: SIGTERM exits with 143`);
			assert.equal(readFileSync(orderFile, "utf8"), "grandchild-already-stopped", `${mode}: the cleanup ran after the grandchild died`);
		} finally {
			try {
				process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
			} catch {
				// Already gone.
			}
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("a cleanup that never settles cannot hold the exit past the deadline", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-deadline-"));
	const script = join(dir, "wait.mjs");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
import { sleep } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
onSignalCleanup(() => { writeFileSync(${JSON.stringify(join(dir, "cleanup-started"))}, "ran"); return new Promise(() => {}); }, "a cleanup that never settles");
process.stdout.write("ready");
await sleep(60000);
`,
	);
	const watcher = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
	let stderr = "";
	let ready = false;
	watcher.stdout.on("data", (chunk) => {
		if (String(chunk).includes("ready")) ready = true;
	});
	watcher.stderr.on("data", (chunk) => (stderr += chunk));
	await waitFor(() => ready, 10000, "the worker registered its handlers");
	const started = Date.now();
	watcher.kill("SIGTERM");
	// The second signal goes out while the cleanup runs, not after a fixed delay.
	await waitFor(() => existsSync(join(dir, "cleanup-started")), 10000, "the cleanup started");
	watcher.kill("SIGINT");
	const code = await exited;
	const elapsed = Date.now() - started;
	try {
		assert.equal(code, 143, `the first signal sets the exit code, the second does not change it: ${stderr}`);
		assert.ok(elapsed < 20000, `the process exited ${elapsed} ms after SIGTERM`);
		assert.match(stderr, /shutdown deadline/, "the deadline message says what happened");
		assert.match(stderr, /a cleanup that never settles/, "the deadline message names the pending cleanup");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cleanup that throws is reported and the next cleanup still runs", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-cleanup-"));
	const second = join(dir, "second");
	const script = join(dir, "wait.mjs");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
import { sleep } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
onSignalCleanup(() => { throw new Error("the cache folder could not be removed"); }, "the cache folder");
onSignalCleanup(() => writeFileSync(${JSON.stringify(second)}, "ran"), "the second cleanup");
process.stdout.write("ready");
await sleep(60000);
`,
	);
	const watcher = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
	let stderr = "";
	let ready = false;
	watcher.stdout.on("data", (chunk) => {
		if (String(chunk).includes("ready")) ready = true;
	});
	watcher.stderr.on("data", (chunk) => (stderr += chunk));
	await waitFor(() => ready, 10000, "the worker registered its cleanups");
	watcher.kill("SIGTERM");
	const code = await exited;
	try {
		assert.equal(code, 143);
		assert.equal(existsSync(second), true, "the cleanup after the failing one ran");
		assert.match(stderr, /the cache folder failed: the cache folder could not be removed/, "the failure is reported with its cleanup name");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the shutdown reports a tree that was cut and the pids that survived", async () => {
	const { shutdownNotes } = await import("../skills/walkthrough-video/scripts/lib/signals.mjs");
	assert.deepEqual(shutdownNotes({ survivors: [], truncated: false }), []);
	assert.deepEqual(shutdownNotes({ survivors: [{ pid: 42 }], truncated: false }), ["still running after SIGKILL: 42"]);
	assert.deepEqual(shutdownNotes({ survivors: [{ pid: 7 }, { pid: 8 }], truncated: true }), [
		"the process tree was cut at the cap: some descendants may still run",
		"still running after SIGKILL: 7, 8",
	]);
	// An unreadable process table is reported as unknown, so a cleanup cannot hide a live render.
	assert.deepEqual(shutdownNotes({ unresolved: [{ pid: 9 }], lastSignal: "SIGKILL" }), ["state unknown after SIGKILL: 9 (they may still run)"]);
});

test("an error that the stop causes keeps the signal's exit code and runs every cleanup", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-late-error-"));
	const ready = join(dir, "ready");
	const done = join(dir, "cleanup-done");
	const worker = join(dir, "worker.mjs");
	writeFileSync(
		worker,
		`import { writeFileSync } from "node:fs";
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
onSignalCleanup(async () => {
	await new Promise((resolve) => setTimeout(resolve, 300));
	writeFileSync(${JSON.stringify(done)}, "ok");
}, "slow cleanup");
// What a killed render does to its caller: the failed run rejects while the shutdown still works.
process.on("SIGTERM", () => setTimeout(() => Promise.reject(new Error("the render failed")), 20));
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
	);
	const watcher = spawn(process.execPath, [worker], { stdio: "ignore" });
	try {
		await waitForFile(ready);
		watcher.kill("SIGTERM");
		const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
		assert.equal(code, 143, "the late error does not replace the signal's exit code");
		assert.equal(existsSync(done), true, "the cleanup ran to its end");
	} finally {
		watcher.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a signal during wv measure stops its ffmpeg child", { timeout: 40000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-measure-sig-"));
	const pidFile = join(dir, "ffmpeg.pid");
	const fake = join(dir, "ffmpeg");
	// A file that is not a video: ffmpeg starts, then the signal arrives while it runs.
	writeFileSync(join(dir, "film.mp4"), "not a video");
	writeFileSync(fake, `#!/bin/sh\necho $$ > ${pidFile}\ntrap "" TERM\nwhile true; do sleep 0.2; done\n`);
	chmodSync(fake, 0o755);
	const worker = join(dir, "worker.mjs");
	writeFileSync(
		worker,
		`import { detectCuts } from ${JSON.stringify(join(SKILL, "film/measure.mjs"))};
import { installSignalHandlers } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
// Never returns: the fake ffmpeg ignores SIGTERM, so only the shutdown can end it.
await detectCuts(${JSON.stringify(join(dir, "film.mp4"))}, 60);
`,
	);
	const watcher = spawn(process.execPath, [worker], { env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` }, stdio: "ignore" });
	try {
		await waitForFile(pidFile);
		const child = Number(readFileSync(pidFile, "utf8").trim());
		const started = Date.now();
		watcher.kill("SIGTERM");
		const code = await new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
		const elapsed = Date.now() - started;
		assert.equal(code, 143, "the worker exits with the signal code");
		assert.ok(elapsed < 10000, `the worker exited within the shutdown deadline (${elapsed} ms)`);
		await sleep(300);
		assert.equal(alive(child), false, `the measure ffmpeg child ${child} is still running`);
	} finally {
		watcher.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a child refused after the stop begins is a named error", () => {
	const code = `import { refuseNewChildren, spawnChild } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
refuseNewChildren();
try {
	spawnChild(${JSON.stringify(process.execPath)}, ["-e", "setTimeout(() => {}, 60000)"]);
} catch (error) {
	console.log(error.name + "|" + error.message);
}`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30000 });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^StoppingError\|wv is stopping/m);
});

test("SIGTERM during a two-job loop starts no second child", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-loop-stop-"));
	const log = join(dir, "jobs.txt");
	const worker = join(dir, "worker.mjs");
	writeFileSync(
		worker,
		`import { appendFileSync } from "node:fs";
import { run } from ${JSON.stringify(join(SKILL, "lib/proc.mjs"))};
import { installSignalHandlers } from ${JSON.stringify(join(SKILL, "lib/signals.mjs"))};
installSignalHandlers();
process.stdout.write("ready");
const child = 'require("node:fs").appendFileSync(process.env.WV_LOG, process.env.WV_JOB + "\\\\n"); setTimeout(() => {}, 60000)';
for (const job of ["one", "two"]) {
	await run(process.execPath, ["-e", child], { timeoutMs: 60000, env: { ...process.env, WV_LOG: ${JSON.stringify(log)}, WV_JOB: job } });
}
`,
	);
	const watcher = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
	let stderr = "";
	let ready = false;
	watcher.stdout.on("data", (chunk) => {
		if (String(chunk).includes("ready")) ready = true;
	});
	watcher.stderr.on("data", (chunk) => (stderr += chunk));
	try {
		await waitFor(() => ready, 10000, "the worker registered its handlers");
		await waitForFile(log);
		watcher.kill("SIGTERM");
		const code = await exited;
		assert.equal(code, 143, stderr);
		await sleep(300);
		assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["one"], "the second job never started");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SIGTERM during the music smoke render starts no second render", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-smoke-stop-"));
	const log = join(dir, "renders.txt");
	try {
		const kit = join(dir, "music-kit");
		const sfz = join(kit, "samples", "vcsl");
		mkdirSync(sfz, { recursive: true });
		for (const file of ["kit.sfz", "marimba.sfz", "glock.sfz"]) writeFileSync(join(sfz, file), "<control>\n");
		mkdirSync(join(kit, "samples", "salamander"), { recursive: true });
		writeFileSync(join(kit, "samples", "salamander", "Salamander Grand Piano V3.sfz"), "<control>\n");
		mkdirSync(join(kit, "bin"), { recursive: true });
		const fake = join(kit, "bin", "sfizz_render");
		writeFileSync(fake, `#!/bin/sh\necho run >> ${JSON.stringify(log)}\nsleep 60\n`);
		chmodSync(fake, 0o755);

		const worker = join(dir, "worker.mjs");
		writeFileSync(
			worker,
			`import { smokeKit } from ${JSON.stringify(join(SKILL, "lib", "music-kit.mjs"))};
import { installSignalHandlers } from ${JSON.stringify(join(SKILL, "lib", "signals.mjs"))};
installSignalHandlers();
process.stdout.write("ready");
await smokeKit(${JSON.stringify(kit)}).catch(() => {});
`,
		);
		const watcher = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
		const exited = new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
		let stderr = "";
		let ready = false;
		watcher.stdout.on("data", (chunk) => {
			if (String(chunk).includes("ready")) ready = true;
		});
		watcher.stderr.on("data", (chunk) => (stderr += chunk));
		await waitFor(() => ready, 10000, "the worker registered its handlers");
		await waitForFile(log);
		watcher.kill("SIGTERM");
		const code = await exited;
		assert.equal(code, 143, stderr);
		await sleep(300);
		assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "the smoke loop stopped at the first cancelled render");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SIGTERM during a music kit install removes its staging folder and its lock", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-install-stop-"));
	try {
		const kit = join(dir, "music-kit");
		const worker = join(dir, "worker.mjs");
		writeFileSync(
			worker,
			`import { installMusicKit } from ${JSON.stringify(join(SKILL, "lib", "music-kit.mjs"))};
import { sleep } from ${JSON.stringify(join(SKILL, "lib", "proc.mjs"))};
import { installSignalHandlers } from ${JSON.stringify(join(SKILL, "lib", "signals.mjs"))};
installSignalHandlers();
const deps = {
	tools: async () => ({ ok: true, items: [], generator: null }),
	freeBytes: () => 8 * 1024 ** 3,
	python: async () => "/py",
	fetch: async (source) => ({ head: source.commit, submodules: [] }),
	build: async () => { process.stdout.write("building\\n"); await sleep(60000); },
	generate: async () => {},
	trim: async () => {},
	smoke: async () => [],
};
await installMusicKit({ kit: ${JSON.stringify(kit)}, log: () => {}, deps }).catch((error) => process.stdout.write("failed " + error.message + "\\n"));
`,
		);
		const watcher = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
		const exited = new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
		let stderr = "";
		let building = false;
		watcher.stdout.on("data", (chunk) => {
			if (String(chunk).includes("building")) building = true;
		});
		watcher.stderr.on("data", (chunk) => (stderr += chunk));
		await waitFor(() => building, 10000, "the install reached its build step");
		const staging = readdirSync(dir).filter((name) => name.startsWith(".music-kit.staging-"));
		assert.equal(staging.length, 1, `the install has one staging folder: ${staging.join(", ")}`);
		assert.equal(existsSync(`${kit}.lock`), true, "the install holds its lock");
		watcher.kill("SIGTERM");
		const code = await exited;
		assert.equal(code, 143, stderr);
		await sleep(300);
		assert.equal(existsSync(`${kit}.lock`), false, "the stop released the lock");
		assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".music-kit.staging-")), [], "the stop removed this run's staging folder");
		assert.equal(existsSync(kit), false, "a stopped install leaves no kit");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two real installs that start together give one builder and one refusal", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-lock-race-"));
	try {
		const kit = join(dir, "music-kit");
		const worker = join(dir, "worker.mjs");
		writeFileSync(
			worker,
			`import { installMusicKit } from ${JSON.stringify(join(SKILL, "lib", "music-kit.mjs"))};
import { sleep } from ${JSON.stringify(join(SKILL, "lib", "proc.mjs"))};
import { installSignalHandlers } from ${JSON.stringify(join(SKILL, "lib", "signals.mjs"))};
installSignalHandlers();
const deps = {
	tools: async () => ({ ok: true, items: [], generator: null }),
	freeBytes: () => 8 * 1024 ** 3,
	python: async () => "/py",
	fetch: async (source) => ({ head: source.commit, submodules: [] }),
	build: async () => { process.stdout.write("building\\n"); await sleep(60000); },
	generate: async () => {},
	trim: async () => {},
	smoke: async () => [],
};
try {
	await installMusicKit({ kit: ${JSON.stringify(kit)}, log: () => {}, deps });
} catch (error) {
	process.stdout.write("refused: " + error.message + "\\n");
}
`,
		);
		const start = () => {
			const watcher = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
			const out = { text: "", watcher, exited: new Promise((resolve) => watcher.on("exit", (code) => resolve(code))) };
			watcher.stdout.on("data", (chunk) => (out.text += chunk));
			watcher.stderr.on("data", (chunk) => (out.text += chunk));
			return out;
		};
		const [one, two] = [start(), start()];
		await waitFor(() => (one.text.includes("building") || two.text.includes("building")) && /refused:/.test(one.text + two.text), 20000, "one builder and one refusal");
		const builders = [one, two].filter((out) => out.text.includes("building"));
		const refused = [one, two].filter((out) => out.text.includes("refused: another wv setup --music is installing the kit"));
		assert.equal(builders.length, 1, one.text + two.text);
		assert.equal(refused.length, 1, one.text + two.text);
		builders[0].watcher.kill("SIGTERM");
		assert.equal(await builders[0].exited, 143);
		assert.equal(await refused[0].exited, 0);
		assert.equal(existsSync(`${kit}.lock`), false, "the stopped install released the lock");
		assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".music-kit.staging-")), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stop keeps the staging folder and the lock until the grandchild is gone", { timeout: 40000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-install-tree-"));
	try {
		const kit = join(dir, "music-kit");
		const samples = join(dir, "samples.txt");
		const grandchild = join(dir, "grandchild.mjs");
		writeFileSync(
			grandchild,
			`import { appendFileSync, existsSync } from "node:fs";
process.on("SIGTERM", () => {});
const sample = () => appendFileSync(process.env.SAMPLES, (existsSync(process.env.STAGING) ? 1 : 0) + " " + (existsSync(process.env.LOCK) ? 1 : 0) + "\\n");
sample();
setInterval(sample, 50);
setTimeout(() => process.exit(0), 60000);
`,
		);
		const child = join(dir, "child.mjs");
		writeFileSync(
			child,
			`import { spawn } from "node:child_process";
spawn(process.execPath, [process.env.GRANDCHILD], { stdio: "ignore" }).unref();
setTimeout(() => {}, 60000);
`,
		);
		const worker = join(dir, "worker.mjs");
		writeFileSync(
			worker,
			`import { readdirSync } from "node:fs";
import { installMusicKit } from ${JSON.stringify(join(SKILL, "lib", "music-kit.mjs"))};
import { run } from ${JSON.stringify(join(SKILL, "lib", "proc.mjs"))};
import { installSignalHandlers } from ${JSON.stringify(join(SKILL, "lib", "signals.mjs"))};
installSignalHandlers();
const deps = {
	tools: async () => ({ ok: true, items: [], generator: null }),
	freeBytes: () => 8 * 1024 ** 3,
	python: async () => "/py",
	fetch: async (source) => ({ head: source.commit, submodules: [] }),
	build: async () => {
		const staging = readdirSync(${JSON.stringify(dir)}).find((name) => name.startsWith(".music-kit.staging-music-kit-"));
		process.stdout.write("building\\n");
		await run(process.execPath, [${JSON.stringify(child)}], { timeoutMs: 120000, env: { ...process.env, STAGING: ${JSON.stringify(dir)} + "/" + staging, LOCK: ${JSON.stringify(kit)} + ".lock", SAMPLES: ${JSON.stringify(samples)}, GRANDCHILD: ${JSON.stringify(grandchild)} } });
	},
	generate: async () => {},
	trim: async () => {},
	smoke: async () => [],
};
try {
	await installMusicKit({ kit: ${JSON.stringify(kit)}, log: () => {}, deps });
} catch (error) {
	process.stdout.write("stopped: " + error.name + "\\n");
}
`,
		);
		const watcher = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
		const exited = new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
		let stderr = "";
		let building = false;
		watcher.stdout.on("data", (chunk) => {
			if (String(chunk).includes("building")) building = true;
		});
		watcher.stderr.on("data", (chunk) => (stderr += chunk));
		await waitFor(() => building, 10000, "the install reached its build step");
		await waitFor(() => existsSync(samples) && readFileSync(samples, "utf8").trim().length > 0, 10000, "the grandchild sampled once");
		watcher.kill("SIGTERM");
		const code = await exited;
		assert.equal(code, 143, stderr);
		const lines = readFileSync(samples, "utf8").trim().split("\n");
		assert.ok(lines.length >= 2, `the grandchild sampled during the stop (${lines.length} lines)`);
		assert.equal(lines[lines.length - 1], "1 1", `the last sample, while the grandchild ran, has the staging folder and the lock (${lines.slice(-3).join(" | ")})`);
		assert.equal(existsSync(`${kit}.lock`), false, "the stop released the lock");
		assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".music-kit.staging-")), [], "the stop removed the staging folder");
		assert.equal(existsSync(kit), false, "a stopped install publishes nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stop that arrives while the venv is made leaves no staging folder and no lock", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-install-python-"));
	try {
		const kit = join(dir, "music-kit");
		const marker = join(dir, "waiting");
		const worker = join(dir, "worker.mjs");
		writeFileSync(
			worker,
			`import { writeFileSync } from "node:fs";
import { installMusicKit } from ${JSON.stringify(join(SKILL, "lib", "music-kit.mjs"))};
import { installSignalHandlers, onSignalCleanup } from ${JSON.stringify(join(SKILL, "lib", "signals.mjs"))};
installSignalHandlers();
const deps = {
	tools: async () => ({ ok: true, items: [], generator: null }),
	freeBytes: () => 8 * 1024 ** 3,
	python: () => new Promise((resolve) => {
		// A timer keeps the worker alive, as a real venv probe would.
		const timer = setInterval(() => {}, 1000);
		// Registered after the install's cleanup, so it resolves only when that cleanup has run.
		onSignalCleanup(() => { clearInterval(timer); resolve("/py"); }, "the held python");
		writeFileSync(${JSON.stringify(marker)}, "waiting");
	}),
	fetch: async (source) => ({ head: source.commit, submodules: [] }),
	build: async () => {},
	generate: async () => {},
	trim: async () => {},
	smoke: async () => [],
};
await installMusicKit({ kit: ${JSON.stringify(kit)}, log: () => {}, deps }).catch((error) => process.stdout.write("stopped: " + error.name + "\\n"));
`,
		);
		const watcher = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
		const exited = new Promise((resolve) => watcher.on("exit", (value) => resolve(value)));
		let stderr = "";
		watcher.stderr.on("data", (chunk) => (stderr += chunk));
		await waitFor(() => existsSync(marker), 10000, "the install reached the venv step");
		watcher.kill("SIGTERM");
		const code = await exited;
		assert.equal(code, 143, stderr);
		await sleep(300);
		assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".music-kit.staging-")), [], "no staging folder stays");
		assert.equal(existsSync(`${kit}.lock`), false, "no lock stays");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
