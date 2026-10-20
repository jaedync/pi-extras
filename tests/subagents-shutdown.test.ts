import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { appendInterruptedRuns, loggedRunKeys, statsByModel } from "../lib/subagents/runlog.ts";
import { installSignalRecorder } from "../lib/subagents/signals.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const interrupted: AgentRecord = { name: "helper", parent: "main", depth: 1, model: "faux/cheap", task: "Check files",
	readOnly: false, fork: false, blocking: false, state: "interrupted", createdAt: 1, activity: "write notes.txt", runs: 1,
	toolCalls: 0, usage: NO_USAGE, sessionFile: "/sessions/helper.jsonl" };

test("restoration logs hard-kill interruptions once per parent, child session and run", () => {
	const dir = mkdtempSync(join(tmpdir(), "interrupted-log-"));
	try {
		const file = join(dir, "runs.jsonl");
		appendInterruptedRuns(file, [interrupted], "parent-1", 10);
		appendInterruptedRuns(file, [interrupted], "parent-1", 20);
		assert.equal(loggedRunKeys(file).size, 1);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).state, "interrupted");
		appendInterruptedRuns(file, [{ ...interrupted, runs: 2 }], "parent-1", 30);
		assert.equal(loggedRunKeys(file).size, 2);
		assert.equal(statsByModel(readFileSync(file, "utf8").trim().split("\n"))[0]?.interrupted, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a real SIGHUP records before the host's default termination", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "child-signal-"));
	const file = join(dir, "signal.txt");
	const module = new URL("../lib/subagents/signals.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { writeFileSync } from "node:fs";
		import { installSignalRecorder } from ${JSON.stringify(module)};
		installSignalRecorder((signal) => writeFileSync(${JSON.stringify(file)}, signal));
		console.log("ready"); setInterval(() => {}, 1000);
	`], { env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	try {
		await once(child.stdout!, "data");
		const exited = once(child, "exit");
		child.kill("SIGHUP");
		const [code, signal] = await exited;
		assert.equal(code, null);
		assert.equal(signal, "SIGHUP");
		assert.equal(readFileSync(file, "utf8"), "SIGHUP");
	} finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("a signal that ends a suspended Pi drops its SIGCONT listener, so the TUI does not restart in the background", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "child-sigcont-"));
	const file = join(dir, "events.txt");
	const module = new URL("../lib/subagents/signals.ts", import.meta.url).href;
	// As Pi after Ctrl-Z: a SIGCONT listener restarts the TUI, which sets raw mode, and the terminal stops a background
	// process for that (SIGTTOU). Its SIGTERM shutdown needs more than one tick before it lets the lease go.
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { appendFileSync } from "node:fs";
		import { installSignalRecorder } from ${JSON.stringify(module)};
		const log = (event) => appendFileSync(${JSON.stringify(file)}, event + "\\n");
		process.once("SIGCONT", () => log("tui restarted"));
		process.prependListener("SIGTERM", () => setTimeout(() => { log("lease released"); process.exit(0); }, 1000));
		installSignalRecorder((signal) => log(signal));
		console.log("ready"); setInterval(() => {}, 1000);
	`], { env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	try {
		await once(child.stdout!, "data");
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		// Sent together, the two can be handled in either order: Node may take each on its own thread. The test sends
		// SIGCONT once SIGTERM is handled, which is the case the recorder controls.
		for (let waited = 0; !(existsSync(file) && readFileSync(file, "utf8").includes("SIGTERM")); waited += 10) {
			assert.ok(waited < 10_000, "the child never handled SIGTERM");
			await sleep(10);
		}
		child.kill("SIGCONT");
		assert.deepEqual(await exited, [0, null]);
		assert.deepEqual(readFileSync(file, "utf8").trim().split("\n"), ["SIGTERM", "lease released"]);
	} finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("a SIGTERM just after SIGCONT still keeps a suspended Pi from restarting its TUI", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "child-sigcont-first-"));
	const file = join(dir, "events.txt");
	const module = new URL("../lib/subagents/signals.ts", import.meta.url).href;
	// The takeover race: Pi handles SIGCONT first, and SIGTERM comes a moment later. The first listener, there
	// before the extension, sends that SIGTERM. Pi's Ctrl-Z listener comes after the extension, as in Pi.
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { appendFileSync } from "node:fs";
		import { installSignalRecorder } from ${JSON.stringify(module)};
		const log = (event) => appendFileSync(${JSON.stringify(file)}, event + "\\n");
		process.on("SIGCONT", () => { log("SIGCONT"); process.kill(process.pid, "SIGTERM"); });
		process.prependListener("SIGTERM", () => setTimeout(() => { log("lease released"); process.exit(0); }, 1000));
		installSignalRecorder((signal) => log(signal), { sigcontDelayMs: 200 });
		process.once("SIGCONT", () => log("tui restarted"));
		console.log("ready"); setInterval(() => {}, 1000);
	`], { env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	try {
		await once(child.stdout!, "data");
		const exited = once(child, "exit");
		child.kill("SIGCONT");
		assert.deepEqual(await exited, [0, null]);
		assert.deepEqual(readFileSync(file, "utf8").trim().split("\n"), ["SIGCONT", "SIGTERM", "lease released"]);
	} finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("fg after Ctrl-Z restarts the TUI, though the SIGCONT comes before the wrap", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "child-sigcont-fg-"));
	const file = join(dir, "events.txt");
	const module = new URL("../lib/subagents/signals.ts", import.meta.url).href;
	// As Pi's Ctrl-Z: add the listener and stop in one synchronous step, so the SIGCONT is caught before any microtask.
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { appendFileSync } from "node:fs";
		import { installSignalRecorder } from ${JSON.stringify(module)};
		const log = (event) => appendFileSync(${JSON.stringify(file)}, event + "\\n");
		installSignalRecorder((signal) => log(signal), { sigcontDelayMs: 50 });
		setInterval(() => {}, 1000);
		setTimeout(() => {
			process.once("SIGCONT", () => { log("tui restarted"); process.exit(0); });
			process.kill(process.pid, "SIGSTOP");
		}, 0);
	`], { env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	const state = () => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(child.pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
	try {
		const exited = once(child, "exit");
		for (let waited = 0; !/^T/.test(state()); waited += 20) {
			assert.ok(waited < 10_000, "the child never stopped");
			await sleep(20);
		}
		child.kill("SIGCONT");
		assert.deepEqual(await Promise.race([exited, sleep(5_000).then(() => "no restart within 5 s")]), [0, null]);
		assert.deepEqual(readFileSync(file, "utf8").trim().split("\n"), ["tui restarted"]);
	} finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("a SIGCONT alone restarts the TUI after the delay, once, and only listeners added while installed wait", async (t) => {
	if (process.platform === "win32") return;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const events: string[] = [];
	process.on("SIGCONT", () => events.push("earlier"));
	const remove = installSignalRecorder(() => undefined, { sigcontDelayMs: 100 });
	try {
		process.once("SIGCONT", () => events.push("tui restarted"));
		// The wrap happens in a microtask, before Pi can see the SIGCONT that ends its Ctrl-Z stop.
		await Promise.resolve();
		process.emit("SIGCONT");
		t.mock.timers.tick(99);
		assert.deepEqual(events, ["earlier"]);
		t.mock.timers.tick(1);
		assert.deepEqual(events, ["earlier", "tui restarted"]);
		process.emit("SIGCONT");
		t.mock.timers.tick(100);
		assert.deepEqual(events, ["earlier", "tui restarted", "earlier"]);
		remove();
		process.once("SIGCONT", () => events.push("after remove"));
		await Promise.resolve();
		process.emit("SIGCONT");
		assert.deepEqual(events.slice(3), ["earlier", "after remove"]);
	} finally { remove(); process.removeAllListeners("SIGCONT"); }
});

test("signal recording is synchronous, leaves existing host listeners alone and uninstalls cleanly", () => {
	const events: string[] = [];
	const host = () => events.push("host");
	process.on("SIGTERM", host);
	const before = process.listenerCount("SIGTERM");
	const remove = installSignalRecorder((signal) => events.push(signal));
	try {
		process.emit("SIGTERM");
		assert.deepEqual(events, ["SIGTERM", "host"]);
		assert.equal(process.listenerCount("SIGTERM"), before + 1);
	} finally { remove(); process.off("SIGTERM", host); }
	assert.equal(process.listeners("SIGTERM").includes(host), false);
});
