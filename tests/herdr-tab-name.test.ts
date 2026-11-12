import { test } from "node:test";
import assert from "node:assert/strict";
import herdrTabNameExtension, { herdrCli } from "../extensions/herdr-tab-name.ts";
import { fakeIntercom } from "./support/fake-intercom.ts";
import { LABEL_MAX, MAX_CHANGES, applies, decide, isCustomLabel, labelFor, locateTab, tabNameSync, type Tab } from "../lib/herdr-tab-name.ts";

const SESSION_FILE = "/home/u/.pi/agent/sessions/--repo--/2026-01-01_abc.jsonl";

function snapshotOf(tabs: readonly Record<string, unknown>[], panes: readonly Record<string, unknown>[]): unknown {
	return { id: "cli:api:snapshot", result: { type: "snapshot", snapshot: { tabs, panes } } };
}

const tab = (label: string, extra: Partial<Tab> = {}): Tab => ({ tabId: "w1:t2", label, number: 2, paneCount: 1, ...extra });

test("labelFor: one line, no control characters, at most LABEL_MAX characters", () => {
	assert.equal(labelFor("  infra   build\n"), "infra build");
	assert.equal(labelFor("a\u0000b\u001b[31mc"), "a b [31mc");
	const long = labelFor("x".repeat(200));
	assert.equal([...long].length, LABEL_MAX);
	assert.ok(long.endsWith("…"));
	// Whole code points only: a cut never leaves half of a surrogate pair.
	assert.ok(!/[\ud800-\udbff]$/.test(labelFor("😀".repeat(100)).slice(0, -1)));
	for (const name of ["infra build", "x".repeat(200), " a  b "]) assert.equal(labelFor(labelFor(name)), labelFor(name));
});

test("isCustomLabel: an empty label, the tab's number and plain digits are Herdr's defaults", () => {
	assert.equal(isCustomLabel(tab("")), false);
	assert.equal(isCustomLabel(tab("  ")), false);
	assert.equal(isCustomLabel(tab("2")), false);
	assert.equal(isCustomLabel(tab("7")), false);
	assert.equal(isCustomLabel(tab("build")), true);
	assert.equal(isCustomLabel(tab("v2")), true);
});

test("locateTab: finds the tab of the pane that reports this session's file", () => {
	const snapshot = snapshotOf(
		[{ tab_id: "w1:t1", label: "1", number: 1, pane_count: 1 }, { tab_id: "w1:t2", label: "build", number: 2, pane_count: 1 }],
		[
			{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { kind: "path", value: "/other.jsonl" } },
			{ pane_id: "w1:p9", tab_id: "w1:t2", agent_session: { kind: "path", value: SESSION_FILE } },
		],
	);
	assert.deepEqual(locateTab(snapshot, { sessionFile: SESSION_FILE, paneId: "w1:p9" }), { tabId: "w1:t2", label: "build", number: 2, paneCount: 1 });
	// The pane id from the environment is stale (the pane moved, and no pane has the old id): the session file decides.
	assert.deepEqual(locateTab(snapshot, { sessionFile: SESSION_FILE, paneId: "w0:p4" })?.tabId, "w1:t2");
	assert.deepEqual(locateTab(snapshot, { sessionId: SESSION_FILE })?.tabId, "w1:t2");
});

test("locateTab: a session open in another pane is not ours while our own pane has not reported it", () => {
	const tabs = [{ tab_id: "w1:t1", label: "alpha", number: 1, pane_count: 1 }, { tab_id: "w1:t2", label: "2", number: 2, pane_count: 1 }];
	const mine = { kind: "path", value: SESSION_FILE };
	// This process (pane p2) resumed a session that pane p1 has open. Herdr still has the old report for p2, or none.
	const old = snapshotOf(tabs, [{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: mine }, { pane_id: "w1:p2", tab_id: "w1:t2", agent_session: { kind: "path", value: "/old.jsonl" } }]);
	const none = snapshotOf(tabs, [{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: mine }, { pane_id: "w1:p2", tab_id: "w1:t2" }]);
	assert.equal(locateTab(old, { sessionFile: SESSION_FILE, paneId: "w1:p2" }), undefined);
	assert.equal(locateTab(none, { sessionFile: SESSION_FILE, paneId: "w1:p2" }), undefined);
});

test("locateTab: the pane id counts only for a pane that reports no session", () => {
	const tabs = [{ tab_id: "w1:t1", label: "one", number: 1, pane_count: 1 }];
	const silent = snapshotOf(tabs, [{ pane_id: "w1:p1", tab_id: "w1:t1" }]);
	assert.equal(locateTab(silent, { sessionFile: SESSION_FILE, paneId: "w1:p1" })?.tabId, "w1:t1");
	// Another session owns that pane (this Pi runs nested in it, or the id is stale): not ours.
	const taken = snapshotOf(tabs, [{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { kind: "path", value: "/other.jsonl" } }]);
	assert.equal(locateTab(taken, { sessionFile: SESSION_FILE, paneId: "w1:p1" }), undefined);
	assert.equal(locateTab(silent, { sessionFile: SESSION_FILE }), undefined);
});

test("locateTab: when two panes report this session, only the pane this process started in is ours", () => {
	const tabs = [{ tab_id: "w1:t1", label: "alpha", number: 1, pane_count: 1 }, { tab_id: "w1:t2", label: "2", number: 2, pane_count: 1 }];
	const mine = { kind: "path", value: SESSION_FILE };
	const twice = snapshotOf(tabs, [{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: mine }, { pane_id: "w1:p2", tab_id: "w1:t2", agent_session: mine }]);
	assert.equal(locateTab(twice, { sessionFile: SESSION_FILE, paneId: "w1:p2" })?.tabId, "w1:t2");
	assert.equal(locateTab(twice, { sessionFile: SESSION_FILE, paneId: "w1:p1" })?.tabId, "w1:t1");
	// No pane id to tell them apart, or a stale one: neither tab is touched.
	assert.equal(locateTab(twice, { sessionFile: SESSION_FILE }), undefined);
	assert.equal(locateTab(twice, { sessionFile: SESSION_FILE, paneId: "w1:p9" }), undefined);
});

test("locateTab: a snapshot of another shape gives nothing and does not throw", () => {
	for (const bad of [undefined, null, "text", 3, {}, { result: {} }, { result: { snapshot: { tabs: "x", panes: [null, 3] } } },
		snapshotOf([], [{ pane_id: "w1:p1", tab_id: "w1:t1" }]), snapshotOf([{ tab_id: "w1:t1", label: 3, pane_count: "1" }], [{ pane_id: "w1:p1", tab_id: "w1:t1" }])]) {
		assert.equal(locateTab(bad, { sessionFile: SESSION_FILE, paneId: "w1:p1" }), undefined);
	}
});

test("decide: at the first look the session name wins, and a session with no name takes a custom label", () => {
	assert.deepEqual(decide(undefined, "infra build", tab("build")), { kind: "rename-tab", tabId: "w1:t2", label: "infra build" });
	assert.deepEqual(decide(undefined, "infra build", tab("2")), { kind: "rename-tab", tabId: "w1:t2", label: "infra build" });
	assert.deepEqual(decide(undefined, "", tab("build")), { kind: "name-session", name: "build" });
	assert.deepEqual(decide(undefined, "", tab("2")), { kind: "none" });
	assert.deepEqual(decide(undefined, "build", tab("build")), { kind: "none" });
});

test("decide: later, the side that changed wins; the name wins when both changed", () => {
	const agreed = { name: "build", label: "build" };
	assert.deepEqual(decide(agreed, "deploy", tab("build")), { kind: "rename-tab", tabId: "w1:t2", label: "deploy" });
	assert.deepEqual(decide(agreed, "build", tab("ship")), { kind: "name-session", name: "ship" });
	assert.deepEqual(decide(agreed, "deploy", tab("ship")), { kind: "rename-tab", tabId: "w1:t2", label: "deploy" });
	// The label went back to a default: the name is put back on the tab.
	assert.deepEqual(decide(agreed, "build", tab("2")), { kind: "rename-tab", tabId: "w1:t2", label: "build" });
	// The name was cleared: nothing to copy, and the label is not new.
	assert.deepEqual(decide(agreed, "", tab("build")), { kind: "none" });
});

test("decide: a long name agrees with its shortened label", () => {
	const name = "n".repeat(200);
	assert.deepEqual(decide(undefined, name, tab(labelFor(name))), { kind: "none" });
});

test("decide: a tab with more than one pane is left alone", () => {
	assert.deepEqual(decide(undefined, "build", tab("x", { paneCount: 2 })), { kind: "none" });
	assert.deepEqual(decide(undefined, "", tab("x", { paneCount: 2 })), { kind: "none" });
	assert.deepEqual(decide(undefined, "build", tab("x", { paneCount: 0 })), { kind: "none" });
});

test("applies: only inside Herdr, not inside a nested multiplexer, and the switches work", () => {
	const herdr = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock" };
	assert.equal(applies(herdr, {}), true);
	assert.equal(applies({}, {}), false);
	assert.equal(applies({ HERDR_ENV: "1" }, {}), false);
	assert.equal(applies({ ...herdr, TMUX: "/tmp/tmux-1000/default,1,0" }, {}), false);
	assert.equal(applies({ ...herdr, STY: "123.pts-0" }, {}), false);
	assert.equal(applies(herdr, { enabled: false }), false);
	assert.equal(applies({ ...herdr, PI_HERDR_TAB_NAME: "off" }, {}), false);
	assert.equal(applies({ ...herdr, PI_HERDR_TAB_NAME: "0" }, {}), false);
	// `on` overrides the file and the nested-multiplexer guard, never the need for Herdr.
	assert.equal(applies({ ...herdr, TMUX: "x", PI_HERDR_TAB_NAME: "on" }, { enabled: false }), true);
	assert.equal(applies({ PI_HERDR_TAB_NAME: "on" }, {}), false);
});

/** A Herdr tab and a Pi session held in memory, with the calls counted. */
function world(initial: { name?: string; label: string; paneCount?: number }) {
	const state = { name: initial.name ?? "", label: initial.label, paneCount: initial.paneCount ?? 1, failSnapshot: false, failRename: false, failSetName: false,
		/** Runs while Herdr answers the next snapshot. */
		duringSnapshot: undefined as (() => void) | undefined };
	const calls = { snapshot: 0, rename: [] as string[], setName: [] as string[], errors: [] as string[] };
	let sync: ReturnType<typeof tabNameSync> | undefined;
	const deps = {
		self: () => ({ sessionFile: SESSION_FILE, paneId: "w1:p1" }),
		name: () => state.name || undefined,
		setName: (name: string) => {
			if (state.failSetName) throw new Error("no session to name");
			calls.setName.push(name);
			// Pi trims the name and reports the change at once.
			state.name = name.trim();
			sync?.request();
		},
		snapshot: async () => {
			calls.snapshot++;
			await Promise.resolve();
			if (state.failSnapshot) throw new Error("herdr is down");
			const taken = snapshotOf([{ tab_id: "w1:t1", label: state.label, number: 1, pane_count: state.paneCount }],
				[{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { kind: "path", value: SESSION_FILE } }]);
			const during = state.duringSnapshot;
			state.duringSnapshot = undefined;
			during?.();
			await Promise.resolve();
			return taken;
		},
		renameTab: async (tabId: string, label: string) => {
			await Promise.resolve();
			if (state.failRename) throw new Error("tab_not_found");
			assert.equal(tabId, "w1:t1");
			calls.rename.push(label);
			state.label = label;
		},
		onError: (error: unknown) => { calls.errors.push(String(error)); },
	};
	sync = tabNameSync(deps);
	return { state, calls, sync };
}

test("sync: a named session renames its tab once", async () => {
	const { state, calls, sync } = world({ name: "infra build", label: "build" });
	sync.request();
	await sync.idle();
	assert.equal(state.label, "infra build");
	assert.deepEqual(calls.rename, ["infra build"]);
	sync.request();
	await sync.idle();
	assert.deepEqual(calls.rename, ["infra build"]);
	assert.deepEqual(calls.setName, []);
});

test("sync: a session with no name takes the tab's label, then follows /name", async () => {
	const { state, calls, sync } = world({ label: "coordinator" });
	sync.request();
	await sync.idle();
	assert.equal(state.name, "coordinator");
	assert.deepEqual(calls.rename, []);
	state.name = "chief";
	sync.request();
	await sync.idle();
	assert.equal(state.label, "chief");
});

test("sync: a tab renamed in Herdr renames the session at the next look", async () => {
	const { state, calls, sync } = world({ name: "build", label: "build" });
	sync.request();
	await sync.idle();
	state.label = "ship";
	sync.request();
	await sync.idle();
	assert.equal(state.name, "ship");
	assert.deepEqual(calls.rename, []);
});

test("sync: requests during a pass run one more pass, not one each", async () => {
	const { calls, sync } = world({ name: "build", label: "build" });
	for (let i = 0; i < 10; i++) sync.request();
	await sync.idle();
	assert.equal(calls.snapshot, 2);
});

test("sync: a failed call is reported, changes nothing, and the next request tries again", async () => {
	const { state, calls, sync } = world({ name: "build", label: "old" });
	state.failRename = true;
	sync.request();
	await sync.idle();
	assert.equal(state.label, "old");
	assert.equal(calls.errors.length, 1);
	state.failRename = false;
	state.failSnapshot = true;
	sync.request();
	await sync.idle();
	assert.equal(calls.errors.length, 2);
	state.failSnapshot = false;
	sync.request();
	await sync.idle();
	assert.equal(state.label, "build");
});

test("sync: a name set while Herdr answers counts in the same look", async () => {
	const { state, calls, sync } = world({ name: "build", label: "build" });
	state.duringSnapshot = () => { state.name = "chief"; };
	sync.request();
	await sync.idle();
	assert.equal(state.label, "chief");
	assert.equal(calls.snapshot, 1);
});

test("sync: a label with spaces around it names the session once and is written back trimmed", async () => {
	const { state, calls, sync } = world({ label: "  ship " });
	sync.request();
	await sync.idle();
	for (let again = 0; again < 3; again++) {
		sync.request();
		await sync.idle();
	}
	assert.deepEqual(calls.setName, ["ship"]);
	assert.deepEqual(calls.rename, ["ship"]);
	assert.deepEqual(calls.errors, []);
	assert.deepEqual({ name: state.name, label: state.label }, { name: "ship", label: "ship" });
});

test("sync: a session rename that throws is reported and tried again at the next request", async () => {
	const { state, calls, sync } = world({ label: "coordinator" });
	state.failSetName = true;
	sync.request();
	await sync.idle();
	assert.equal(state.name, "");
	assert.equal(calls.errors.length, 1);
	state.failSetName = false;
	sync.request();
	await sync.idle();
	assert.equal(state.name, "coordinator");
});

test("sync: many requests that change nothing are not taken for a loop", async () => {
	const { state, calls, sync } = world({ name: "build", label: "build" });
	let more = 3 * MAX_CHANGES;
	const again = () => { if (more-- > 0) { state.duringSnapshot = again; sync.request(); } };
	state.duringSnapshot = again;
	sync.request();
	await sync.idle();
	assert.equal(calls.snapshot, 3 * MAX_CHANGES + 1);
	assert.deepEqual(calls.errors, []);
});

test("sync: a Pi that does not keep the name it was given cannot make the looks run without end", async () => {
	const calls = { snapshot: 0, setName: 0, errors: [] as string[] };
	let sync: ReturnType<typeof tabNameSync> | undefined;
	let label = "a";
	sync = tabNameSync({
		self: () => ({ sessionFile: SESSION_FILE }),
		name: () => undefined,
		// Each call drops the name, changes the tab and asks for the next look.
		setName: () => { calls.setName++; label += "a"; sync?.request(); },
		snapshot: async () => {
			calls.snapshot++;
			return snapshotOf([{ tab_id: "w1:t1", label, number: 1, pane_count: 1 }], [{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { value: SESSION_FILE } }]);
		},
		renameTab: async () => {},
		onError: (error) => { calls.errors.push(String(error)); },
	});
	sync.request();
	await sync.idle();
	assert.equal(calls.snapshot, MAX_CHANGES);
	assert.equal(calls.setName, MAX_CHANGES);
	assert.equal(calls.errors.length, 1);
	assert.match(calls.errors[0]!, /changes in a row/);
	// The next request starts a new count.
	sync.request();
	await sync.idle();
	assert.equal(calls.snapshot, 2 * MAX_CHANGES);
});

test("sync: after stop, nothing more is read or written", async () => {
	const { state, calls, sync } = world({ name: "build", label: "old" });
	sync.request();
	sync.stop();
	await sync.idle();
	sync.request();
	await sync.idle();
	assert.equal(state.label, "old");
	assert.deepEqual(calls.rename, []);
	assert.ok(calls.snapshot <= 1);
});

/** A small deterministic PRNG, so a failing order of events can be replayed from its seed. */
function prng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("property: in every order of renames, pane changes and failures, the two names settle and agree", async () => {
	const names = ["", "build", "deploy", "  spaced  name ", "n".repeat(80), "7"];
	const labels = ["", "1", "7", "build", "ship", "  padded  label ", "l".repeat(80)];
	for (let seed = 1; seed <= 300; seed++) {
		const random = prng(seed);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		const { state, calls, sync } = world({ name: pick(names).trim(), label: pick(labels) });
		for (let step = 0; step < 30; step++) {
			const roll = random();
			const before = { name: state.name, label: state.label, renames: calls.rename.length, sets: calls.setName.length };
			const multi = state.paneCount !== 1;
			if (roll < 0.2) state.name = pick(names).trim();
			else if (roll < 0.4) state.label = pick(labels);
			else if (roll < 0.5) state.paneCount = pick([0, 1, 1, 2]);
			else if (roll < 0.6) state.failRename = !state.failRename;
			else if (roll < 0.7) state.failSnapshot = !state.failSnapshot;
			else {
				for (let n = Math.ceil(random() * 3); n > 0; n--) sync.request();
				if (random() < 0.5) await Promise.resolve();
				await sync.idle();
				// One settled look makes at most one change on each side.
				assert.ok(calls.rename.length - before.renames <= 1, `seed ${seed} step ${step}: more than one tab rename in a look`);
				assert.ok(calls.setName.length - before.sets <= 1, `seed ${seed} step ${step}: more than one session rename in a look`);
				if (multi || state.paneCount !== 1) {
					assert.equal(state.label, before.label, `seed ${seed} step ${step}: wrote to a tab with ${state.paneCount} panes`);
					assert.equal(state.name, before.name, `seed ${seed} step ${step}: named the session from a tab with ${state.paneCount} panes`);
				}
			}
			for (const name of calls.setName) assert.ok(name.trim() !== "" && !/^\d+$/.test(name.trim()), `seed ${seed}: the session got a default label as its name: "${name}"`);
			for (const label of calls.rename) assert.ok(label !== "" && [...label].length <= LABEL_MAX, `seed ${seed}: bad tab label "${label}"`);
		}
		// The outside changes stop and Herdr works: the two settle.
		state.failRename = false;
		state.failSnapshot = false;
		state.paneCount = 1;
		sync.request();
		await sync.idle();
		assert.deepEqual(calls.errors.filter((error) => /in a row/.test(error)), [], `seed ${seed}: the loop guard stopped a run`);
		const settled = { name: state.name, label: state.label, renames: calls.rename.length, sets: calls.setName.length };
		for (let again = 0; again < 3; again++) {
			sync.request();
			await sync.idle();
		}
		assert.deepEqual({ name: state.name, label: state.label, renames: calls.rename.length, sets: calls.setName.length }, settled, `seed ${seed}: not settled after one look`);
		if (state.name) assert.equal(state.label, labelFor(state.name), `seed ${seed}: a named session and its tab disagree`);
	}
});

/** The handlers an extension registers, by event. */
function fakePi(sessionName: string | undefined) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const state = { name: sessionName, setNames: [] as string[] };
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		getSessionName: () => state.name,
		setSessionName: (name: string) => { state.name = name; state.setNames.push(name); },
	};
	const emit = (event: string, ctx: unknown = {}) => { for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx); };
	return { pi, handlers, state, emit };
}

test("herdrCli: a failed call is reported without its arguments, which hold the session name", async () => {
	const run = herdrCli({ HERDR_BIN_PATH: "/nonexistent/herdr-for-test" });
	await assert.rejects(run(["tab", "rename", "w1:t1", "secret project name"]), (error: Error) => {
		assert.match(error.message, /^herdr tab rename failed: ENOENT$/);
		assert.ok(!error.message.includes("secret"));
		return true;
	});
});

test("extension: outside Herdr it registers nothing", () => {
	const { pi, handlers } = fakePi(undefined);
	herdrTabNameExtension(pi as never, { env: {}, settings: {} });
	assert.equal(handlers.size, 0);
});

test("extension: in the TUI it syncs at session start, on a rename and after each run; in print mode it never calls Herdr", async () => {
	const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "w1:p1" };
	const tabState = { label: "coordinator" };
	const calls: string[][] = [];
	const run = async (args: readonly string[]): Promise<string> => {
		calls.push([...args]);
		if (args[0] === "api") {
			return JSON.stringify(snapshotOf([{ tab_id: "w1:t1", label: tabState.label, number: 1, pane_count: 1 }],
				[{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { kind: "path", value: SESSION_FILE } }]));
		}
		tabState.label = args[3]!;
		return JSON.stringify({ id: "cli:tab:rename", result: { type: "tab_info" } });
	};
	const ctx = (mode: string) => ({ mode, sessionManager: { getSessionFile: () => SESSION_FILE, getSessionId: () => "abc" } });

	const printed = fakePi(undefined);
	const printHandle = herdrTabNameExtension(printed.pi as never, { env, settings: {}, run, later: () => () => {}, onError: (error) => { throw error; } });
	printed.emit("session_start", ctx("print"));
	printed.emit("agent_end");
	await printHandle?.idle();
	assert.deepEqual(calls, []);

	const { pi, state, emit } = fakePi(undefined);
	const handle = herdrTabNameExtension(pi as never, { env, settings: {}, run, later: () => () => {}, onError: (error) => { throw error; } });
	emit("session_start", ctx("tui"));
	await handle?.idle();
	assert.equal(state.name, "coordinator");
	state.name = "chief";
	emit("session_info_changed");
	await handle?.idle();
	assert.equal(tabState.label, "chief");
	assert.deepEqual(calls.at(-1), ["tab", "rename", "w1:t1", "chief"]);
	tabState.label = "desk";
	emit("agent_end");
	await handle?.idle();
	assert.equal(state.name, "desk");
	const count = calls.length;
	emit("session_shutdown");
	emit("agent_end");
	await handle?.idle();
	assert.equal(calls.length, count);
});

test("extension: a refusal from Herdr is a failure: the label is not taken as written", async () => {
	const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "w1:p1" };
	const renames: string[] = [];
	const run = async (args: readonly string[]): Promise<string> => {
		if (args[0] === "api") {
			return JSON.stringify(snapshotOf([{ tab_id: "w1:t1", label: "old", number: 1, pane_count: 1 }],
				[{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { kind: "path", value: SESSION_FILE } }]));
		}
		renames.push(args[3]!);
		// Herdr prints a refusal as JSON, also when it exits with 0.
		return JSON.stringify({ id: "cli:tab:rename", error: { code: "tab_not_found", message: "tab w1:t1 not found" } });
	};
	const errors: string[] = [];
	const { pi, state, emit } = fakePi("build");
	const handle = herdrTabNameExtension(pi as never, { env, settings: {}, run, later: () => () => {}, onError: (error) => { errors.push(String(error)); } });
	emit("session_start", { mode: "tui", sessionManager: { getSessionFile: () => SESSION_FILE, getSessionId: () => "abc" } });
	await handle?.idle();
	// With the refusal taken for success, this look would see "old" as a new label and name the session from it.
	emit("agent_end");
	await handle?.idle();
	assert.deepEqual(renames, ["build", "build"]);
	assert.equal(errors.length, 2);
	assert.match(errors[0]!, /tab_not_found/);
	assert.deepEqual(state.setNames, []);
	assert.equal(state.name, "build");
});

test("extension: after /new the pane still reports the old session, and the second look finds the tab", async () => {
	const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "w1:p1" };
	const pane = { reports: "/old-session.jsonl" };
	const run = async (): Promise<string> => JSON.stringify(snapshotOf([{ tab_id: "w1:t1", label: "coordinator", number: 1, pane_count: 1 }],
		[{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { kind: "path", value: pane.reports } }]));
	const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const later = (fn: () => void, ms: number) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; };
	const { pi, state, emit } = fakePi(undefined);
	const handle = herdrTabNameExtension(pi as never, { env, settings: {}, run, later, onError: (error) => { throw error; } });
	const ctx = { mode: "tui", sessionManager: { getSessionFile: () => SESSION_FILE, getSessionId: () => "abc" } };
	emit("session_start", ctx);
	await handle?.idle();
	assert.equal(state.name, undefined, "the pane belongs to another session until Herdr hears of the new one");
	assert.equal(timers.length, 1);
	assert.ok(timers[0]!.ms >= 1000);
	pane.reports = SESSION_FILE;
	timers[0]!.fn();
	await handle?.idle();
	assert.equal(state.name, "coordinator");
	// A session that ends takes its waiting look with it.
	emit("session_start", ctx);
	emit("session_shutdown");
	assert.equal(timers[1]!.cancelled, true);
	assert.equal(timers[0]!.cancelled, true);
});

/** A tab labelled "coordinator" that holds this session, and a pi with pi-intercom on its event bus. */
function intercomSetup(sessionName: string | undefined, connected: boolean) {
	const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "w1:p1" };
	const run = async (args: readonly string[]): Promise<string> => args[0] === "api"
		? JSON.stringify(snapshotOf([{ tab_id: "w1:t1", label: "coordinator", number: 1, pane_count: 1 }],
			[{ pane_id: "w1:p1", tab_id: "w1:t1", agent_session: { kind: "path", value: SESSION_FILE } }]))
		: JSON.stringify({ id: "cli:tab:rename", result: { type: "tab_info" } });
	const intercom = fakeIntercom(connected);
	const fake = fakePi(sessionName);
	const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const later = (fn: () => void, ms: number) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; };
	const pi = { ...fake.pi, events: intercom.events };
	const handle = herdrTabNameExtension(pi as never, { env, settings: {}, run, later, onError: (error) => { throw error; } });
	const start = () => fake.emit("session_start", { mode: "tui", sessionManager: { getSessionFile: () => SESSION_FILE, getSessionId: () => "abc" } });
	return { ...fake, intercom, handle, start, timers };
}

test("extension: while pi-intercom connects, the tab's label names the session only after the registration is done", async () => {
	// pi-intercom 0.18.1 drops a presence update sent before its broker registration and keeps the name it registered.
	const { state, intercom, handle, start } = intercomSetup(undefined, false);
	start();
	await handle?.idle();
	assert.equal(state.name, undefined);
	assert.deepEqual(state.setNames, []);
	intercom.connect(true);
	assert.equal(state.name, "coordinator");
	assert.deepEqual(state.setNames, ["coordinator"]);
});

test("extension: with pi-intercom connected, the tab's label names the session at once", async () => {
	const { state, handle, start } = intercomSetup(undefined, true);
	start();
	await handle?.idle();
	assert.equal(state.name, "coordinator");
});

test("extension: a name the user gives while the tab's label waits is kept", async () => {
	const { state, intercom, handle, start } = intercomSetup(undefined, false);
	start();
	await handle?.idle();
	state.name = "mine";
	intercom.connect(true);
	assert.equal(state.name, "mine");
	assert.deepEqual(state.setNames, []);
});

test("extension: a session that ends drops its waiting name, and a new session registers no second namespace", async () => {
	const { state, intercom, handle, start, emit } = intercomSetup(undefined, false);
	start();
	await handle?.idle();
	emit("session_shutdown");
	start();
	await handle?.idle();
	assert.equal(intercom.state.registrations.length, 1);
	intercom.connect(true);
	assert.deepEqual(state.setNames, ["coordinator"], "the new session sets the name once; the old one sets nothing");
});

test("extension: a session that has a name never waits for pi-intercom", async () => {
	const { state, handle, start, timers } = intercomSetup("chief", false);
	start();
	await handle?.idle();
	assert.equal(state.name, "chief");
	assert.deepEqual(state.setNames, []);
	assert.ok(timers.every((timer) => timer.ms === 2_000), "only the second look, no name wait");
});
