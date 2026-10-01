import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { rgbColor } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import tabStatus from "../extensions/tab-status.ts";
import { terminalSupport } from "../lib/tab-status/core.ts";
import { BACKGROUND_EVENT } from "../lib/tab-status/events.ts";

function harness(t: TestContext, overrides: Record<string, unknown> = {}, manager = { getSessionId: () => "parent", getBranch: () => [] as any[] }, reuseTimers = false) {
	if (!reuseTimers) t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const writes: string[] = [], notices: string[] = [];
	let widgets = 0, native = false, failWrite = false;
	const pi = { events: new EventEmitter(), getSettings: () => ({ terminal: { showTerminalProgress: native } }), on: (name: string, fn: any) => handlers.set(name, fn) };
	const theme = { colors: { accent: rgbColor(1, 2, 3), warning: rgbColor(4, 5, 6), dim: rgbColor(7, 8, 9), error: rgbColor(255, 0, 0) } };
	const ctx = { hasUI: true, mode: "tui", cwd: "/tmp", isIdle: () => true, sessionManager: manager, ui: { theme, notify: (s: string) => notices.push(s), setWidget(_id: string, factory: any) { if (factory) { widgets++; factory({ terminal: { write(bytes: string) { if (failWrite) throw new Error("write failed"); writes.push(bytes); } } }); } } } };
	tabStatus(pi as never, { env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.0" }, isTTY: () => true, settings: {}, ...overrides });
	const fire = async (name: string, event: any = {}) => { await handlers.get(name)?.(event, ctx); };
	t.after(async () => { failWrite = false; await fire("session_shutdown", { reason: "quit" }); });
	return { pi, ctx, writes, notices, fire, widgets: () => widgets, native: (n: boolean) => { native = n; }, failWrite: () => { failWrite = true; } };
}

test("H1 live effective settings control progress without constructing a SettingsManager", async (t) => {
	t.mock.method(SettingsManager, "create", () => { throw new Error("settings I/O forbidden"); });
	const f = harness(t); await f.fire("session_start");
	await f.fire("agent_start"); assert.match(f.writes.at(-1)!, /9;4;3/);
	f.native(true); const start = f.writes.length;
	t.mock.timers.tick(1000);
	assert.ok(f.writes.slice(start).every((w) => !w.includes("9;4;")));
	f.native(false); t.mock.timers.tick(1000);
	assert.match(f.writes.at(-1)!, /9;4;3/);
});

test("H2/M3 minimum versions, unknown versions, features and inherited terminal identity", () => {
	const none = { sessionStatus: false, progress: false };
	for (const env of [
		{ TERM_PROGRAM: "iTerm.app" }, { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.5" },
		{ TERM_PROGRAM: "iTerm.app", TERM_FEATURES: "Ab;P" },
		{ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.5", TERM_FEATURES: "P" },
		{ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.1.3", TERM_FEATURES: "P" },
		{ TERM_PROGRAM: "tmux", LC_TERMINAL: "vscode", LC_TERMINAL_VERSION: "1.100.0", WT_SESSION: "id" },
		{ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20240203-110809-5046fc22" },
		{ TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.1.3" }, { WT_SESSION: "id" },
		{ WT_SESSION: "id", TERM_PROGRAM_VERSION: "1.5.9" },
		{ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.100.0", LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7.0", TERM_FEATURES: "P" },
	]) assert.deepEqual(terminalSupport(env), none);
	assert.deepEqual(terminalSupport({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.6" }), { sessionStatus: false, progress: true });
	assert.equal(terminalSupport({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.6", TERM_FEATURES: "T3CwLrMB" }).progress, false);
	assert.equal(terminalSupport({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.7", TERM_FEATURES: "T3CwLrMBP" }).progress, true);
	assert.deepEqual(terminalSupport({ TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4", LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7.0" }), { sessionStatus: true, progress: true });
	assert.equal(terminalSupport({ TERM_PROGRAM: "iTerm.app", TERM_FEATURES: "T3LrNoP" }).progress, true);
	assert.equal(terminalSupport({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.0", TERM_FEATURES: "T3No" }).progress, false);
	for (const TERM_FEATURES of ["Pfake", "fakeP", "1P"]) assert.equal(terminalSupport({ TERM_PROGRAM: "iTerm.app", TERM_FEATURES }).progress, false);
});

for (const marker of [{ GHOSTTY_RESOURCES_DIR: "/synthetic/ghostty" }, { WT_SESSION: "synthetic" }]) {
	test(`multiplexer versions cannot establish terminal progress support ${JSON.stringify(marker)}`, async (t) => {
		for (const TERM_PROGRAM of ["tmux", "screen"]) assert.deepEqual(terminalSupport({ TERM_PROGRAM, TERM_PROGRAM_VERSION: "3.4", ...marker }), { sessionStatus: false, progress: false });
		const env = { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.4", ...marker };
		const auto = harness(t, { env }); await auto.fire("session_start"); await auto.fire("agent_start");
		assert.deepEqual(auto.writes, []);
		const forced = harness(t, { env, settings: { progress: true } }, undefined, true);
		await forced.fire("session_start"); await forced.fire("agent_start");
		assert.match(forced.writes.at(-1)!, /9;4;3/);
	});
}

test("H2 forced settings override unknown versions", async (t) => {
	const f = harness(t, { env: { LC_TERMINAL: "iTerm2" }, settings: { sessionStatus: true, progress: true } });
	await f.fire("session_start"); await f.fire("agent_start");
	assert.match(f.writes.at(-1)!, /21337/); assert.match(f.writes.at(-1)!, /9;4;3/);
});

test("H2 WezTerm paused maps to indeterminate", async (t) => {
	const wez = harness(t, { env: { TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20250209-182623-44866cc1" } });
	await wez.fire("session_start"); await wez.fire("agent_start"); await wez.fire("ui_prompt_start", { title: "Allow?" });
	assert.match(wez.writes.at(-1)!, /9;4;3/); assert.ok(wez.writes.every((w) => !w.includes("9;4;4")));
});

test("M1 tab observer is first in the package so Cache Compaction cannot block its start signal", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.pi.extensions[0], "extensions/tab-status.ts");
});

test("M2 tmux resends status while busy and sends final idle twice", async (t) => {
	const f = harness(t, { env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.0", TMUX: "fixture" } });
	await f.fire("session_start"); await f.fire("agent_start");
	const first = f.writes.length; t.mock.timers.tick(1000);
	assert.ok(f.writes.slice(first).some((w) => w.includes("status=working")));
	await f.fire("agent_settled"); t.mock.timers.tick(1500);
	assert.equal(f.writes.filter((w) => w.includes("status=idle")).length, 1);
	t.mock.timers.tick(1000);
	assert.equal(f.writes.filter((w) => w.includes("status=idle")).length, 2);
});

test("M4 default detail is private and never reads history; reply text is opt-in", async (t) => {
	const f = harness(t);
	f.ctx.sessionManager.getBranch = () => { throw new Error("history must not be read"); };
	await f.fire("session_start"); t.mock.timers.tick(1500);
	assert.match(f.writes.at(-1)!, /detail=Done/);
	await f.fire("agent_start"); await f.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Private reply" }], stopReason: "stop" } });
	await f.fire("agent_settled"); t.mock.timers.tick(1500);
	assert.ok(f.writes.every((w) => !w.includes("Private reply")));
});

test("M5 failed manual compactions settle idle, automatic compaction failures stay red", async (t) => {
	const f = harness(t); await f.fire("session_start");
	await f.fire("session_before_compact");
	await f.fire("session_compact_failed", { reason: "manual", errorMessage: "Nothing to compact", aborted: false });
	t.mock.timers.tick(1500); assert.match(f.writes.at(-1)!, /status=idle/);
	assert.ok(f.writes.every((w) => !w.includes("Error:")));
	await f.fire("session_before_compact");
	await f.fire("session_compact_failed", { reason: "threshold", errorMessage: "Failure", aborted: false });
	assert.match(f.writes.at(-1)!, /status=waiting/);
});

test("L1 before_agent_start alone does not leave a session working", async (t) => {
	const f = harness(t); await f.fire("session_start"); t.mock.timers.tick(1500);
	await f.fire("before_agent_start");
	assert.ok(f.writes.every((w) => !w.includes("status=working")));
});

test("L2 write failures disable updates politely without throwing", async (t) => {
	const f = harness(t); await f.fire("session_start"); f.failWrite();
	await assert.doesNotReject(f.fire("agent_start"));
	assert.equal(f.notices.length, 1);
});

test("write failure still disables updates when warning delivery also throws", async (t) => {
	const f = harness(t); await f.fire("session_start"); f.failWrite();
	t.mock.method(f.ctx.ui, "notify", () => { throw new Error("UI was disposed"); });
	const errors = t.mock.method(console, "error", () => {});
	await assert.doesNotReject(f.fire("agent_start"));
	const before = f.writes.length; t.mock.timers.tick(2000);
	await f.fire("agent_start"); assert.equal(f.writes.length, before);
	assert.equal(errors.mock.callCount(), 0);
});

test("L3 child/print contexts never even touch the terminal widget", async (t) => {
	const f = harness(t); f.ctx.hasUI = false; f.ctx.mode = "print";
	await f.fire("session_start"); await f.fire("agent_start"); t.mock.timers.tick(2000);
	assert.equal(f.widgets(), 0); assert.deepEqual(f.writes, []);
});

test("reload clears previously forced features when auto now rejects their version", async (t) => {
	const settings: Record<string, unknown> = { sessionStatus: true, progress: true };
	const f = harness(t, { env: { LC_TERMINAL: "iTerm2" }, settings });
	await f.fire("session_start"); await f.fire("agent_start");
	settings.sessionStatus = "auto"; settings.progress = "auto";
	const before = f.writes.length;
	await f.fire("session_shutdown", { reason: "reload" });
	assert.equal(f.writes.length, before);
	await f.fire("session_start", { reason: "reload" });
	assert.match(f.writes.at(-1)!, /status=;indicator=;status-color=;detail=/);
	assert.match(f.writes.at(-1)!, /9;4;0/);
});

test("reload handoff clears owned outputs once when the successor disables Tab Status", async (t) => {
	const old = harness(t); await old.fire("session_start"); await old.fire("agent_start");
	const before = old.writes.length; await old.fire("session_shutdown", { reason: "reload" });
	assert.equal(old.writes.length, before);
	const next = harness(t, { settings: { enabled: false } }, old.ctx.sessionManager, true);
	await next.fire("session_start", { reason: "reload" });
	assert.equal(next.writes.length, 1);
	assert.match(next.writes[0], /status=;indicator=;status-color=;detail=/);
	assert.match(next.writes[0], /9;4;0/);
	await next.fire("session_start", { reason: "reload" }); assert.equal(next.writes.length, 1);
});

test("a handoff never clears progress that only native Pi turned on", async (t) => {
	const old = harness(t); old.native(true); await old.fire("session_start"); await old.fire("agent_start");
	await old.fire("session_shutdown", { reason: "reload" });
	const next = harness(t, { settings: { enabled: false } }, old.ctx.sessionManager, true);
	await next.fire("session_start", { reason: "reload" });
	assert.equal(next.writes.length, 1); assert.ok(next.writes.every((w) => !w.includes("9;4;")));
});

test("handoff cleanup respects native Pi's current progress ownership", async (t) => {
	const old = harness(t); await old.fire("session_start"); await old.fire("agent_start");
	await old.fire("session_shutdown", { reason: "reload" });
	const next = harness(t, { settings: { enabled: false } }, old.ctx.sessionManager, true); next.native(true);
	await next.fire("session_start", { reason: "reload" });
	assert.equal(next.writes.length, 1); assert.ok(next.writes.every((w) => !w.includes("9;4;")));
});

test("native takeover does not create an empty ownership handoff on unsupported startup", async (t) => {
	const old = harness(t, { env: { TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" } });
	await old.fire("session_start"); await old.fire("agent_start"); old.native(true);
	await old.fire("session_shutdown", { reason: "reload" });
	const next = harness(t, { env: {} }, old.ctx.sessionManager, true);
	await next.fire("session_start"); assert.deepEqual(next.writes, []); assert.equal(next.widgets(), 0);
});

test("handoff cannot cross separate managers even when their session IDs match", async (t) => {
	const old = harness(t); await old.fire("session_start"); await old.fire("agent_start");
	await old.fire("session_shutdown", { reason: "reload" });
	const other = harness(t, { settings: { enabled: false } }, { getSessionId: () => "parent", getBranch: () => [] }, true);
	await other.fire("session_start"); assert.deepEqual(other.writes, []); assert.equal(other.widgets(), 0);
	const next = harness(t, { settings: { enabled: false } }, old.ctx.sessionManager, true);
	await next.fire("session_start"); assert.equal(next.writes.length, 1);
});

test("handoff cannot cross sessions on a reused manager", async (t) => {
	let id = "one"; const manager = { getSessionId: () => id, getBranch: () => [] };
	const old = harness(t, {}, manager); await old.fire("session_start"); await old.fire("agent_start");
	await old.fire("session_shutdown", { reason: "reload" }); id = "two";
	const next = harness(t, { settings: { enabled: false } }, manager, true);
	await next.fire("session_start"); assert.deepEqual(next.writes, []); assert.equal(next.widgets(), 0);
	id = "one"; await next.fire("session_start"); assert.deepEqual(next.writes, []);
});

test("handoff does not survive a quit", async (t) => {
	const old = harness(t); await old.fire("session_start"); await old.fire("agent_start");
	await old.fire("session_shutdown", { reason: "reload" }); await old.fire("session_shutdown", { reason: "quit" });
	const next = harness(t, { settings: { enabled: false } }, old.ctx.sessionManager, true);
	await next.fire("session_start"); assert.deepEqual(next.writes, []); assert.equal(next.widgets(), 0);
});

test("a noninteractive successor drops its inherited handoff on quit without terminal access", async (t) => {
	const old = harness(t); await old.fire("session_start"); await old.fire("agent_start");
	await old.fire("session_shutdown", { reason: "reload" });
	const headless = harness(t, {}, old.ctx.sessionManager, true); headless.ctx.mode = "print";
	await headless.fire("session_start"); await headless.fire("session_shutdown", { reason: "quit" });
	assert.deepEqual(headless.writes, []); assert.equal(headless.widgets(), 0);
	const next = harness(t, { settings: { enabled: false } }, old.ctx.sessionManager, true);
	await next.fire("session_start"); assert.deepEqual(next.writes, []); assert.equal(next.widgets(), 0);
});

test("L4 reload background snapshots cannot emit an idle flicker", async (t) => {
	const f = harness(t); await f.fire("session_start");
	f.pi.events.emit(BACKGROUND_EVENT, { sessionId: "parent", source: "shell-jobs", count: 1 });
	const first = f.writes.length;
	f.pi.events.emit(BACKGROUND_EVENT, { sessionId: "parent", source: "shell-jobs", count: 0 });
	t.mock.timers.tick(1000);
	f.pi.events.emit(BACKGROUND_EVENT, { sessionId: "parent", source: "shell-jobs", count: 1 });
	t.mock.timers.tick(1500);
	assert.ok(f.writes.slice(first).every((w) => !w.includes("status=idle")));
	await f.fire("session_shutdown", { reason: "reload" });
	assert.ok(f.writes.slice(first).every((w) => !w.includes("status=;")));
});
