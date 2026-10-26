/**
 * Adoption in one session: the pure decision (adopt.ts) and the controller
 * (session.ts) with a fake host, a temp store and a temp agent dir.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { LOCK_STALE_MS } from "../lib/auto-update/cycle.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decide, idleFor, selectorOpen, MAX_ATTEMPTS, QUIET_MS, USER_BASH_MAX_MS, userBashRunning, type AdoptInput, type IdleSignals } from "../lib/auto-update/adopt.ts";
import { writeConfig } from "../lib/auto-update/config.ts";
import { storePaths, type StorePaths } from "../lib/auto-update/paths.ts";
import { APPLY_COMMAND, UPDATE_ENTRY, UpdateSession, type SessionHost, type UpdateEntryData } from "../lib/auto-update/session.ts";
import { loadedEntries } from "../lib/auto-update/own-set.ts";
import { emptyState, readState, writeState, type UpdateSet, type UpdateState } from "../lib/auto-update/state.ts";
import { collectGarbage } from "../lib/auto-update/gc.ts";
import { readLiveLeases } from "../lib/auto-update/leases.ts";
import { flipPiCurrent } from "../lib/auto-update/switch.ts";
import { removeTree } from "./support/auto-update-fixtures.ts";

void APPLY_COMMAND;

function release(root: string, name: string, version: string) {
	const dir = join(root, "packages", `npm-${name}`, version);
	const entry = join(dir, "node_modules", name);
	return { origin: `npm:${name}`, id: version, dir, entry, label: `${name} ${version}` };
}

function set(root: string, pi: string, extras: string): UpdateSet {
	return { pi: { version: pi, dir: join(root, "pi", pi) }, packages: { "npm-pi-extras": release(root, "pi-extras", extras) } };
}

const IDLE: IdleSignals = { agentIdle: true, pendingMessages: false, compacting: false, promptOpen: false, subagentRun: false, background: false, editorEmpty: true, userBash: false, lastActivityAt: 0, now: QUIET_MS };

test("idle: every signal blocks a move; background work blocks only a restart", () => {
	assert.equal(idleFor("reload", IDLE), true);
	assert.equal(idleFor("restart", IDLE), true);
	for (const [key, value] of [["agentIdle", false], ["pendingMessages", true], ["compacting", true], ["promptOpen", true], ["subagentRun", true], ["editorEmpty", false], ["userBash", true]] as const) {
		assert.equal(idleFor("reload", { ...IDLE, [key]: value }), false, key);
		assert.equal(idleFor("restart", { ...IDLE, [key]: value }), false, key);
	}
	assert.equal(idleFor("reload", { ...IDLE, now: QUIET_MS - 1 }), false, "activity in the last 30 s");
	assert.equal(idleFor("reload", { ...IDLE, background: true }), true, "shell jobs and subagents survive a reload");
	assert.equal(idleFor("restart", { ...IDLE, background: true }), false, "a restart ends them");
});

test("decide: reload for packages, restart for Pi in the TUI under the launcher, a notice otherwise", () => {
	const root = "/store";
	const old = set(root, "1.4.0", "0.29.0");
	const own = { piVersion: "1.4.0", piDir: old.pi.dir, entries: [old.packages["npm-pi-extras"]!.entry] };
	const base: AdoptInput = { own, state: { ...emptyState(), current: old, previous: undefined }, storeRoot: root, adopt: "auto", mode: "tui", canRestart: true, ready: true, attempts: 0 };
	assert.deepEqual(decide(base), { kind: "none" });
	const extras = { ...base, state: { ...base.state, current: set(root, "1.4.0", "0.30.0"), previous: old } };
	const reload = decide(extras);
	assert.equal(reload.kind, "reload");
	assert.equal((reload as { text: string }).text, "Updating pi-extras 0.29.0 -> 0.30.0: reloading");
	assert.equal(decide({ ...extras, ready: false }).kind, "wait", "the cycle has not finished its switch");
	assert.match((decide({ ...extras, adopt: "notice" }) as { text: string }).text, /use \/reload/);
	const loop = decide({ ...extras, attempts: MAX_ATTEMPTS });
	assert.equal(loop.kind, "notice");
	assert.match((loop as { text: string }).text, /did not move to it/);
	const pi = { ...base, state: { ...base.state, current: set(root, "1.4.1", "0.29.0"), previous: old } };
	assert.equal(decide(pi).kind, "restart");
	assert.equal((decide(pi) as { text: string }).text, "Updating Pi 1.4.0 -> 1.4.1: restarting");
	assert.deepEqual(decide({ ...pi, mode: "rpc" }), { kind: "notice", text: "Pi 1.4.1 ready: restart to use it" });
	assert.deepEqual(decide({ ...pi, canRestart: false }), { kind: "notice", text: "Pi 1.4.1 ready: restart to use it" });
});

interface Harness {
	readonly paths: StorePaths;
	readonly agentDir: string;
	readonly host: SessionHost;
	readonly entries: UpdateEntryData[];
	readonly statuses: (string | undefined)[];
	readonly notices: string[];
	readonly calls: string[];
	clock: number;
	signals: Omit<IdleSignals, "now" | "lastActivityAt">;
	readonly branch: { type: string; customType?: string; data?: unknown }[];
	loaded: string[];
	readonly history: Set<string>;
}

/** A store whose state.json, pi-current and settings.json all name `current`; the session runs `own`. */
function harness(t: test.TestContext, own: (root: string) => UpdateSet, current: (root: string) => UpdateSet, options: { mode?: string; previous?: (root: string) => UpdateSet; enabled?: boolean } = {}): Harness {
	const root = mkdtempSync(join(tmpdir(), "au-session-"));
	t.after(() => removeTree(root));
	const paths = storePaths(join(root, "store"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const target = current(paths.root);
	const mine = own(paths.root);
	for (const dir of [target.pi.dir, mine.pi.dir]) mkdirSync(dir, { recursive: true });
	flipPiCurrent(paths, target.pi.dir);
	// Checked just now, so the startup timer does not spawn a cycle unless a test asks for it.
	const state: UpdateState = { ...emptyState(), current: target, previous: options.previous?.(paths.root), lastCheck: 1_000_000 };
	writeState(paths.state, state);
	writeConfig(agentDir, { enabled: options.enabled ?? true });
	// settings.json first names the session's own set; `switchSettings` moves it to the target.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: Object.values(mine.packages).map((r) => r.entry) }));
	const h: Harness = {
		paths, agentDir, entries: [], statuses: [], notices: [], calls: [], clock: 1_000_000, branch: [], loaded: [], history: new Set(),
		signals: { agentIdle: true, pendingMessages: false, compacting: false, promptOpen: false, subagentRun: false, background: false, editorEmpty: true, userBash: false },
		host: undefined as unknown as SessionHost,
	};
	(h as { host: SessionHost }).host = {
		mode: options.mode ?? "tui", paths, agentDir, piVersion: mine.pi.version, piDir: mine.pi.dir, extrasDir: "/dev/pi-extras",
		sessionFile: () => "/sessions/a.jsonl",
		loadedPaths: () => h.loaded,
		history: h.history,
		branch: () => h.branch,
		appendEntry: (data) => {
			h.entries.push(data);
			h.branch.push({ type: "custom", customType: UPDATE_ENTRY, data });
		},
		notify: (text) => h.notices.push(text),
		setStatus: (text) => h.statuses.push(text),
		signals: () => h.signals,
		dispatchApply: () => h.calls.push("dispatch"),
		spawnCycle: (force) => h.calls.push(`spawn ${force}`),
		restartToken: "tok123",
		updateNote: undefined,
		launchedByLauncher: true,
		now: () => h.clock,
		random: () => 0.5,
		setTimer: () => () => {},
	};
	return h;
}

function switchSettings(h: Harness, to: UpdateSet): void {
	writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ packages: Object.values(to.packages).map((r) => r.entry) }));
}

const actions = (h: Harness) => ({ reload: async () => void h.calls.push("reload"), shutdown: () => void h.calls.push("shutdown") });

test("a package update: waits for the switch and for quiet, then reloads, and says so once after", async (t) => {
	const old = (root: string) => set(root, "1.4.0", "0.29.0");
	const next = (root: string) => set(root, "1.4.0", "0.30.0");
	const h = harness(t, old, next, { previous: old });
	const session = new UpdateSession(h.host);
	session.start("startup");
	assert.ok(readdirSync(h.paths.leases).length === 1, "a lease is written once the store is in use");
	assert.deepEqual(h.calls, [], "settings.json does not name the new set yet: wait");
	switchSettings(h, next(h.paths.root));
	session.poll();
	assert.deepEqual(h.calls, [], "the session was active less than 30 s ago");
	h.clock += QUIET_MS;
	h.signals = { ...h.signals, editorEmpty: false };
	session.poll();
	assert.deepEqual(h.calls, [], "text in the editor");
	h.signals = { ...h.signals, editorEmpty: true };
	session.poll();
	assert.deepEqual(h.calls, ["dispatch"]);
	session.activity();
	await session.apply(actions(h));
	assert.deepEqual(h.calls, ["dispatch"], "apply checks idle again");
	h.clock += QUIET_MS;
	await session.apply(actions(h));
	assert.deepEqual(h.calls, ["dispatch", "reload"]);
	assert.deepEqual(h.entries.map((e) => [e.phase, e.text]), [["start", "Updating pi-extras 0.29.0 -> 0.30.0: reloading"]]);
	session.stop("reload");
	assert.equal(readdirSync(h.paths.leases).length, 1, "a reload keeps the lease");

	// The reloaded module: it runs the new set now, and reports it once.
	const after = new UpdateSession({ ...h.host, piDir: next(h.paths.root).pi.dir });
	after.start("reload");
	assert.deepEqual(h.entries.at(-1), { phase: "done", target: h.entries[0]!.target, text: "Updated: pi-extras 0.30.0" });
	const again = new UpdateSession(h.host);
	again.start("reload");
	assert.equal(h.entries.length, 2, "only once");
	again.stop("quit");
	assert.equal(readdirSync(h.paths.leases).length, 0, "a quit removes the lease");
});

test("a Pi update restarts through the launcher: the request file names the session", async (t) => {
	const old = (root: string) => set(root, "1.4.0", "0.29.0");
	const next = (root: string) => set(root, "1.4.1", "0.29.0");
	const h = harness(t, old, next, { previous: old });
	const session = new UpdateSession(h.host);
	session.start("resume");
	h.clock += QUIET_MS;
	h.signals = { ...h.signals, background: true };
	session.poll();
	assert.deepEqual(h.calls, [], "a running shell job or subagent blocks a restart");
	h.signals = { ...h.signals, background: false };
	session.poll();
	await session.apply(actions(h));
	assert.deepEqual(h.calls, ["dispatch", "shutdown"]);
	assert.equal(readFileSync(join(h.paths.restart, "tok123"), "utf8"), "/sessions/a.jsonl\nUpdated: Pi 1.4.1\n");
	assert.equal(h.entries[0]!.text, "Updating Pi 1.4.0 -> 1.4.1: restarting");
	assert.equal(h.entries[0]!.after, "Updated: Pi 1.4.1");
	assert.equal(new Set(JSON.parse(readFileSync(join(h.paths.leases, readdirSync(h.paths.leases)[0]!), "utf8")).releases).size, 1, "no path twice in the lease");
});

test("after a restart of a session that had no file yet, the launcher's note gives the \"Updated\" line once", (t) => {
	const old = (root: string) => set(root, "1.4.0", "0.29.0");
	const next = (root: string) => set(root, "1.4.1", "0.29.0");
	const h = harness(t, next, next, { previous: old });
	// Pi keeps a new session in memory until the first reply, so the restarted Pi has an empty branch.
	new UpdateSession({ ...h.host, updateNote: "Updated: Pi 1.4.1" }).start("startup");
	assert.deepEqual(h.entries.map((entry) => [entry.phase, entry.text]), [["done", "Updated: Pi 1.4.1"]]);
	const stale = harness(t, old, next, { previous: old });
	new UpdateSession({ ...stale.host, updateNote: "Updated: Pi 1.4.1" }).start("startup");
	assert.deepEqual(stale.entries, [], "the launcher fell back to the old Pi: no false line");
});

test("without the launcher, or in RPC mode, a Pi update shows a status line and never restarts", async (t) => {
	const old = (root: string) => set(root, "1.4.0", "0.29.0");
	const next = (root: string) => set(root, "1.4.1", "0.29.0");
	for (const host of [{ launchedByLauncher: false }, { mode: "rpc" }]) {
		const h = harness(t, old, next, { previous: old, mode: host.mode });
		const session = new UpdateSession({ ...h.host, ...host });
		h.clock += QUIET_MS;
		session.start("startup");
		await session.apply(actions(h));
		assert.deepEqual(h.calls, []);
		assert.equal(h.statuses.at(-1), "Pi 1.4.1 ready: restart to use it");
		assert.equal(existsSync(h.paths.restart), false);
	}
});

test("the loop guard: after two restarts that did not reach the target, a notice and no third try", async (t) => {
	const old = (root: string) => set(root, "1.4.0", "0.29.0");
	const next = (root: string) => set(root, "1.4.1", "0.29.0");
	const h = harness(t, old, next, { previous: old });
	for (let i = 0; i < 3; i++) {
		// Each restart brings back the old Pi (for example the launcher fell back to the Pi from before enable).
		const session = new UpdateSession(h.host);
		session.start("resume");
		h.clock += QUIET_MS;
		session.poll();
		await session.apply(actions(h));
		session.stop("quit");
	}
	assert.equal(h.calls.filter((call) => call === "shutdown").length, MAX_ATTEMPTS);
	assert.match(h.statuses.filter(Boolean).at(-1)!, /is ready, but this session did not move to it/);
	assert.ok(!h.entries.some((entry) => entry.phase === "done"), "no false \"Updated\" line");
});

test("timers start only in TUI and RPC when enabled; a cycle spawns when the last check is old and the lock is free", (t) => {
	const same = (root: string) => set(root, "1.4.0", "0.29.0");
	const print = harness(t, same, same, { mode: "print" });
	new UpdateSession(print.host).start("startup");
	assert.deepEqual(print.calls, []);
	const off = harness(t, same, same, { enabled: false });
	new UpdateSession(off.host).start("startup");
	assert.deepEqual(off.calls, []);
	const h = harness(t, same, same);
	writeState(h.paths.state, { ...JSON.parse(readFileSync(h.paths.state, "utf8")), lastCheck: undefined });
	const session = new UpdateSession(h.host);
	session.start("startup");
	assert.deepEqual(h.calls, ["spawn false"], "never checked: spawn at startup");
	writeState(h.paths.state, { ...JSON.parse(readFileSync(h.paths.state, "utf8")), lastCheck: h.clock });
	session.maybeSpawn();
	assert.deepEqual(h.calls, ["spawn false"], "checked within the interval");
	h.clock += 5 * 60_000;
	writeFileSync(h.paths.lock, `${process.pid} x`);
	session.maybeSpawn();
	assert.deepEqual(h.calls, ["spawn false"], "a live process holds the lock");
	writeFileSync(h.paths.lock, "999999999 x");
	session.maybeSpawn();
	assert.deepEqual(h.calls, ["spawn false", "spawn false"]);
	writeConfig(h.agentDir, { paused: true });
	h.clock += 5 * 60_000;
	session.maybeSpawn();
	assert.equal(h.calls.length, 2, "paused");
});

test("the status line shows what a running cycle does", (t) => {
	const same = (root: string) => set(root, "1.4.0", "0.29.0");
	const h = harness(t, same, same);
	writeState(h.paths.state, { ...JSON.parse(readFileSync(h.paths.state, "utf8")), lastCheck: h.clock, activity: { text: "installing pi-extras 0.30.0", since: h.clock, pid: 1 } });
	const session = new UpdateSession(h.host);
	session.start("startup");
	assert.equal(h.statuses.at(-1), "updating: installing pi-extras 0.30.0");
	h.clock += 20 * 60_000;
	session.poll();
	assert.equal(h.statuses.at(-1), undefined, "an old activity from a cycle that died is not shown");
});

test("a replaced launcher shows a short warning in the status line and one notice", (t) => {
	const same = (root: string) => set(root, "1.4.0", "0.29.0");
	const h = harness(t, same, same);
	writeState(h.paths.state, { ...JSON.parse(readFileSync(h.paths.state, "utf8")), launcherProblem: { at: h.clock, message: "long text" } });
	const session = new UpdateSession(h.host);
	session.start("startup");
	session.poll();
	assert.equal(h.statuses.at(-1), "auto-update: ~/.local/bin/pi was replaced; run enable again, or disable");
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0]!, /long text/);
});

test("own set: the folders Pi really loaded win over settings.json; a package that registers nothing falls back to it", () => {
	const root = "/store";
	const v1 = release(root, "pi-extras", "0.29.0");
	const v2 = release(root, "pi-extras", "0.30.0");
	const quiet = release(root, "themes-only", "1.0.0");
	const known = [v1, v2, quiet];
	// settings.json already names v2 (the cycle rewrote it after Pi loaded v1), and the theme package.
	const snapshot = [v2.entry, quiet.entry, "/elsewhere/local"];
	const loaded = [join(v1.entry, "extensions", "status.ts"), join(v1.entry, "prompts", "deeper.md"), "/usr/lib/other/tool.ts", "builtin:read"];
	assert.deepEqual(loadedEntries({ storeRoot: root, snapshot, loadedPaths: loaded, known }), [v1.entry, quiet.entry]);
	assert.deepEqual(loadedEntries({ storeRoot: root, snapshot, loadedPaths: [], known }), [v2.entry, quiet.entry], "nothing registered: the snapshot");
	// A loaded release that no set knows: its folder stands for it, so it differs from every set.
	const odd = join(root, "packages", "npm-pi-extras", "0.28.0", "node_modules", "pi-extras", "x.ts");
	assert.deepEqual(loadedEntries({ storeRoot: root, snapshot: [v2.entry], loadedPaths: [odd], known }), [join(root, "packages", "npm-pi-extras", "0.28.0")]);
});

test("settings rewritten between load and session_start: the session still sees that it runs the old set, and reloads", async (t) => {
	const old = (root: string) => set(root, "1.4.0", "0.29.0");
	const next = (root: string) => set(root, "1.4.0", "0.30.0");
	const h = harness(t, old, next, { previous: old });
	switchSettings(h, next(h.paths.root));
	h.loaded = [join(old(h.paths.root).packages["npm-pi-extras"]!.entry, "extensions", "auto-update.ts")];
	const session = new UpdateSession(h.host);
	session.start("startup");
	h.clock += QUIET_MS;
	session.poll();
	await session.apply(actions(h));
	assert.deepEqual(h.calls, ["dispatch", "reload"]);
	const lease = JSON.parse(readFileSync(join(h.paths.leases, readdirSync(h.paths.leases)[0]!), "utf8"));
	assert.ok(lease.releases.includes(old(h.paths.root).packages["npm-pi-extras"]!.entry), "the lease names what is really in use");
});

test("the lease keeps every release this process loaded: after a reload to B and a switch to C, GC keeps A", (t) => {
	const a = (root: string) => set(root, "1.4.0", "0.29.0");
	const b = (root: string) => set(root, "1.4.0", "0.30.0");
	const c = (root: string) => set(root, "1.4.0", "0.31.0");
	const h = harness(t, a, a);
	const old = Date.now() - 2 * 3_600_000;
	for (const make of [a, b, c]) {
		const release = make(h.paths.root).packages["npm-pi-extras"]!;
		mkdirSync(release.entry, { recursive: true });
		writeFileSync(join(release.dir, ".pi-extras-release.json"), JSON.stringify({ installedAt: old }));
	}
	const entry = (make: (root: string) => UpdateSet) => make(h.paths.root).packages["npm-pi-extras"]!.entry;
	h.loaded = [join(entry(a), "extensions", "x.ts")];
	const first = new UpdateSession(h.host);
	first.start("startup");
	first.stop("reload");
	// The reload loads B; old code from A (a parked runtime, a timer) still runs in this process.
	switchSettings(h, b(h.paths.root));
	h.loaded = [join(entry(b), "extensions", "x.ts")];
	const second = new UpdateSession(h.host);
	second.start("reload");
	writeState(h.paths.state, { ...emptyState(), current: c(h.paths.root), previous: b(h.paths.root) });
	const gc = () => collectGarbage({ paths: h.paths, state: readState(h.paths.state), leases: readLiveLeases(h.paths), now: Date.now(), mapped: () => new Set() });
	assert.deepEqual(gc().removed, []);
	assert.ok(existsSync(entry(a)), "A stays while this process lives");
	second.stop("quit");
	assert.equal(h.history.size, 0, "a quit clears what the process loaded");
	assert.deepEqual(gc().removed, [join(realpathSync(h.paths.root), "packages", "npm-pi-extras", "0.29.0")], "then A goes");
});

test("an old lock that names a live, unrelated pid does not stop sessions from starting cycles", (t) => {
	const same = (root: string) => set(root, "1.4.0", "0.29.0");
	const h = harness(t, same, same);
	writeState(h.paths.state, { ...JSON.parse(readFileSync(h.paths.state, "utf8")), lastCheck: undefined });
	const session = new UpdateSession(h.host);
	// pid 1 is always alive. A fresh lock with it counts as held.
	writeFileSync(h.paths.lock, "1 reused");
	session.maybeSpawn();
	assert.deepEqual(h.calls, [], "a fresh lock is held");
	// Older than the stale time of the cycle's own tryLock: a crashed cycle, and the pid was reused (for example after a reboot).
	const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
	utimesSync(h.paths.lock, old, old);
	session.maybeSpawn();
	assert.deepEqual(h.calls, ["spawn false"]);
});

test("a user ! command is busy from user_bash until its bash execution entry is in the branch, at most an hour", () => {
	const bash = (command: string, timestamp: number) => ({ type: "message", message: { role: "bashExecution", command, timestamp } });
	const starts = [{ command: "npm test", at: 1_000 }];
	assert.equal(userBashRunning(starts, [], 2_000), true, "no entry yet: it runs");
	assert.equal(userBashRunning(starts, [bash("npm test", 500)], 2_000), true, "an older run of the same command does not end this one");
	assert.equal(userBashRunning(starts, [bash("ls", 3_000)], 4_000), true, "another command's entry does not end it");
	assert.equal(userBashRunning(starts, [bash("npm test", 3_000)], 4_000), false, "its entry ends it");
	const twice = [{ command: "make", at: 1_000 }, { command: "make", at: 1_100 }];
	assert.equal(userBashRunning(twice, [bash("make", 2_000)], 3_000), true, "one entry ends one of two runs");
	assert.equal(userBashRunning(twice, [bash("make", 2_000), bash("make", 2_500)], 3_000), false);
	assert.equal(userBashRunning(starts, [], 1_000 + USER_BASH_MAX_MS), false, "past the maximum time: a lost end signal must not block updates forever");
});

test("a built-in selector or overlay counts as open: focus away from the editor, or any overlay", () => {
	const editor = { getText: () => "", render: () => [] };
	const list = { render: () => [] };
	assert.equal(selectorOpen(undefined), false, "no terminal UI (RPC): nothing to tell");
	assert.equal(selectorOpen({ hasOverlay: () => false, getFocusedComponent: () => editor }), false);
	assert.equal(selectorOpen({ hasOverlay: () => false, getFocusedComponent: () => list }), true, "/model, /settings, /resume, /tree replace the editor and take focus");
	assert.equal(selectorOpen({ hasOverlay: () => true, getFocusedComponent: () => editor }), true);
	assert.equal(selectorOpen({ hasOverlay: () => false, getFocusedComponent: () => null }), false, "no focus at all: unknown, the quiet time decides");
	assert.equal(selectorOpen({ hasOverlay: () => { throw new Error("gone"); }, getFocusedComponent: () => editor }), false, "a TUI that went away");
});
