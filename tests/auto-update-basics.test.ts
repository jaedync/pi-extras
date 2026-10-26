import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeEntry } from "../lib/auto-update/enable.ts";
import { DEFAULT_CONFIG, parseConfig, readConfig, writeConfig } from "../lib/auto-update/config.ts";
import { agentDirFrom, isInside, storePaths, storeRootFrom } from "../lib/auto-update/paths.ts";
import { firstLine, inFolder, killRunning, runCommand, sanitize, type Runner } from "../lib/auto-update/run.ts";
import { updateCommand } from "../lib/auto-update/slash.ts";
import { spawnCycle } from "../lib/auto-update/spawn.ts";
import { armHardLimit } from "../lib/auto-update/cycle.ts";
import { emptyState, readState, writeState, type UpdateState } from "../lib/auto-update/state.ts";

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "au-basics-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("the store and the agent dir follow the environment, ~ included", () => {
	assert.equal(storeRootFrom({ PI_EXTRAS_UPDATE_STORE: "/x/store" }, "/home/u"), "/x/store");
	assert.equal(storeRootFrom({ XDG_DATA_HOME: "/d" }, "/home/u"), "/d/pi-extras/updates");
	assert.equal(storeRootFrom({}, "/home/u"), "/home/u/.local/share/pi-extras/updates");
	assert.equal(agentDirFrom({ PI_CODING_AGENT_DIR: "~/agent-x" }, "/home/u"), "/home/u/agent-x");
	assert.equal(agentDirFrom({}, "/home/u"), "/home/u/.pi/agent");
	const paths = storePaths("/s");
	assert.equal(paths.piCurrent, "/s/pi-current");
	assert.equal(paths.state, "/s/state.json");
	assert.equal(paths.releaseDir("npm-x", "1.0.0"), "/s/packages/npm-x/1.0.0");
	assert.equal(paths.piDir("1.4.0"), "/s/pi/1.4.0");
	assert.throws(() => paths.releaseDir("../x", "1"), /unsafe/);
	assert.throws(() => paths.piDir("1/../../x"), /unsafe/);
});

test("isInside never matches a sibling with the same prefix", () => {
	assert.equal(isInside("/s/packages/a", "/s/packages"), true);
	assert.equal(isInside("/s/packages", "/s/packages"), false);
	assert.equal(isInside("/s/packagesX/a", "/s/packages"), false);
	assert.equal(isInside("/s/packages/../x", "/s/packages"), false);
});

test("the config is off by default and clamps bad values", () => {
	assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
	assert.equal(DEFAULT_CONFIG.enabled, false);
	assert.equal(DEFAULT_CONFIG.intervalMinutes, 5);
	assert.equal(DEFAULT_CONFIG.minReleaseAgeHours, 0);
	const parsed = parseConfig({ enabled: true, intervalMinutes: 0.2, minReleaseAgeHours: -3, adopt: "notice", paused: true, sources: { "git:a/b": "head", bad: "nope" }, pi: "skip" });
	assert.equal(parsed.enabled, true);
	assert.equal(parsed.intervalMinutes, 1);
	assert.equal(parsed.minReleaseAgeHours, 0);
	assert.equal(parsed.adopt, "notice");
	assert.equal(parsed.paused, true);
	assert.deepEqual(parsed.sources, { "git:a/b": "head" });
	assert.equal(parsed.pi, "skip");
	assert.equal(parseConfig({ adopt: "x", pi: 3 }).adopt, "auto");
});

test("the config section is written beside other sections, and a broken file is not replaced", (t) => {
	const agent = scratch(t);
	const file = join(agent, "pi-extras.json");
	writeFileSync(file, JSON.stringify({ toolDisplay: { motion: "reduced" } }));
	writeConfig(agent, { enabled: true });
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(saved.toolDisplay, { motion: "reduced" });
	assert.equal(saved.autoUpdate.enabled, true);
	assert.equal(readConfig(agent).enabled, true);
	writeFileSync(file, "{ broken");
	assert.equal(readConfig(agent).enabled, false, "an unreadable file reads as defaults");
	assert.throws(() => writeConfig(agent, { paused: true }), /could not be read/);
	assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("sanitize strips credentials from URLs and things that look like tokens", () => {
	assert.equal(sanitize("fatal: https://user:hunter2@github.com/a/b.git"), "fatal: https://***@github.com/a/b.git");
	assert.equal(sanitize("clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x"), "clone https://***@github.com/x");
	assert.equal(sanitize("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here"), "token *** here");
	assert.equal(sanitize("//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123"), "//registry.npmjs.org/:_authToken=***");
	assert.equal(sanitize("Authorization: Bearer abc.def-ghi"), "Authorization: Bearer ***");
	assert.equal(sanitize("plain error 404"), "plain error 404");
	assert.equal(sanitize("sha 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b ok"), "sha 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b ok", "a commit is not a secret");
});

test("firstLine picks the error line, sanitized and short", () => {
	assert.equal(firstLine("\nnpm notice x\nnpm error code E404\nmore"), "npm error code E404");
	assert.equal(firstLine("one\ntwo\n"), "two");
	assert.equal(firstLine(""), "");
	assert.equal(firstLine(`error ${"x".repeat(400)}`).length, 200);
});

test("runCommand passes arguments without a shell, closes stdin and stops at the time limit", async () => {
	const ok = await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1] + ':' + process.env.GIT_TERMINAL_PROMPT)", "a b; echo no"], { timeoutMs: 10_000 });
	assert.equal(ok.code, 0);
	assert.equal(ok.stdout, "a b; echo no:0");
	const stdin = await runCommand(process.execPath, ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.stdout.write('eof'))"], { timeoutMs: 10_000 });
	assert.equal(stdin.stdout, "eof");
	const slow = await runCommand(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 200 });
	assert.equal(slow.timedOut, true);
	assert.notEqual(slow.code, 0);
	const missing = await runCommand("/nonexistent/cmd", [], { timeoutMs: 1000 });
	assert.equal(missing.code, null);
	assert.match(missing.error ?? "", /ENOENT/);
});

test("the cycle's commands run in the store root unless a step names its own folder, so a project's .npmrc has no effect", async () => {
	const seen: (string | undefined)[] = [];
	const inner: Runner = async (_command, _args, options) => {
		seen.push(options.cwd);
		return { code: 0, stdout: "", stderr: "", timedOut: false };
	};
	const runner = inFolder(inner, "/store");
	await runner("npm", ["view", "x"], { timeoutMs: 1 });
	await runner("npm", ["install"], { timeoutMs: 1, cwd: "/store/packages/k/staging" });
	assert.deepEqual(seen, ["/store", "/store/packages/k/staging"]);
	const real = await inFolder(runCommand, tmpdir())("pwd", [], { timeoutMs: 5_000 });
	assert.equal(real.stdout.trim(), realpathSync(tmpdir()));
});

test("spawnCycle starts the cycle in the store root, not in the session's project folder", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "au-spawn-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const extras = join(root, "extras");
	mkdirSync(join(extras, "lib", "auto-update"), { recursive: true });
	const out = join(root, "cwd.txt");
	writeFileSync(join(extras, "lib", "auto-update", "cli.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, process.cwd());\n`);
	const store = join(root, "store");
	mkdirSync(store);
	spawnCycle(extras, store, false, (error) => assert.fail(error));
	const deadline = Date.now() + 10_000;
	while (!existsSync(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(readFileSync(out, "utf8"), realpathSync(store));
});

test("state reads empty when missing, round-trips, and rejects a malformed set", (t) => {
	const dir = scratch(t);
	const file = join(dir, "state.json");
	assert.deepEqual(readState(file), emptyState());
	const state: UpdateState = {
		...emptyState(),
		current: { pi: { version: "1.4.0", dir: "/s/pi/1.4.0" }, packages: { "npm-x": { origin: "npm:x", id: "1.0.0", dir: "/s/packages/npm-x/1.0.0", entry: "/s/packages/npm-x/1.0.0/node_modules/x" } } },
		lastCheck: 5,
		bad: { "npm-x": { "2.0.0": { reason: "smoke failed", at: 7 } } },
	};
	writeState(file, state);
	assert.deepEqual(readState(file), state);
	writeFileSync(file, JSON.stringify({ version: 1, current: { pi: { version: 3 } } }));
	assert.throws(() => readState(file), /state\.json/);
});

test("a settings entry is shown by its source, without credentials", () => {
	assert.equal(describeEntry({ source: "https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b", extensions: ["x"] }), "https://***@github.com/a/b");
	assert.equal(describeEntry("npm:x"), "npm:x");
	assert.equal(describeEntry(42), "(an entry without a source)");
});

test("killRunning stops every command that runCommand started", { skip: process.platform === "win32" }, async () => {
	const started = Date.now();
	const running = runCommand("sleep", ["30"], { timeoutMs: 60_000 });
	await new Promise((resolve) => setTimeout(resolve, 100));
	killRunning();
	const result = await running;
	assert.ok(Date.now() - started < 5_000, "it did not run to its end");
	assert.notEqual(result.code, 0);
});

test("the hard cycle limit records the reason, stops running commands and ends the process", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "au-hard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const paths = storePaths(dir);
	writeState(paths.state, { ...emptyState(), activity: { text: "installing x", since: 1, pid: 1 } });
	const calls: string[] = [];
	const lines: string[] = [];
	const exited = new Promise<number>((resolve) => {
		armHardLimit({ ms: 20, paths, now: () => 5, log: (line) => lines.push(line), kill: () => calls.push("kill"), exit: resolve });
	});
	assert.equal(await exited, 1);
	assert.deepEqual(calls, ["kill"]);
	assert.match(lines.join("\n"), /hard limit/);
	const state = readState(paths.state);
	assert.match(state.lastError?.message ?? "", /passed its limit of 0 minutes/);
	assert.equal(state.activity, undefined);
	const disarmed: string[] = [];
	const stop = armHardLimit({ ms: 20, paths, now: () => 5, log: () => {}, kill: () => disarmed.push("kill"), exit: () => disarmed.push("exit") });
	stop();
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual(disarmed, [], "a finished cycle disarms the limit");
});

test("/pi-extras update lists each bad version with its date; retry clears all marks, logs it and starts a forced check", (t) => {
	const root = scratch(t);
	const paths = storePaths(join(root, "store"));
	const agentDir = join(root, "agent");
	mkdirSync(paths.root, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeConfig(agentDir, { enabled: true });
	const at = Date.UTC(2026, 9, 20, 12);
	const current = { pi: { version: "1.4.0", dir: join(paths.root, "pi", "1.4.0") }, packages: { "npm-x-0a1b2c3d": { origin: "npm:x", id: "1.0.0", dir: "/x", entry: "/x", label: "x 1.0.0" } } };
	writeState(paths.state, { ...emptyState(), current, lastCheck: at, bad: { "npm-x-0a1b2c3d": { "2.0.0": { reason: "it broke", at } }, pi: { "1.5.0": { reason: "rolled back by the user", at } } }, suspect: { pi: { "1.6.0": { at, tries: 2 } } } });
	const logged: string[] = [];
	const spawned: string[] = [];
	const deps = { paths, agentDir, extrasDir: "/extras", now: () => at + 60_000, log: (line: string) => logged.push(line), pending: () => undefined, spawnCycle: () => spawned.push("check") };
	const status = updateCommand("", deps).lines.join("\n");
	assert.match(status, /\nBad: x 2\.0\.0 \(2026-10-20\): it broke\nBad: Pi 1\.5\.0 \(2026-10-20\): rolled back by the user\nUse \/pi-extras update retry to test them again\./);
	const result = updateCommand("retry", deps);
	assert.deepEqual(result.lines, ["Cleared 2 bad marks and 1 suspect mark.", "Started an update check. Use /pi-extras update to see its progress."]);
	assert.deepEqual(spawned, ["check"]);
	assert.deepEqual(logged, ["retry: cleared the bad marks of x 2.0.0, Pi 1.5.0 and 1 suspect mark"]);
	const state = readState(paths.state);
	assert.deepEqual(state.bad, {});
	assert.equal(state.suspect, undefined);
	assert.doesNotMatch(updateCommand("", deps).lines.join("\n"), /Bad:|update retry/);
	writeConfig(agentDir, { enabled: false });
	assert.match(updateCommand("retry", deps).lines[0]!, /^Auto-update is off/);
});
