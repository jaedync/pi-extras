import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, parseConfig, readConfig, writeConfig } from "../lib/auto-update/config.ts";
import { agentDirFrom, isInside, storePaths, storeRootFrom } from "../lib/auto-update/paths.ts";
import { firstLine, runCommand, sanitize } from "../lib/auto-update/run.ts";
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
