import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createFakePi, shellJobs, loadFreshShellJobs, fire, cleanup, sleep } from "./support/shell-jobs-harness.mts";
import { waitUI } from "../lib/rate-limit-recovery/wait.ts";
import { BACKGROUND_EVENT, BACKGROUND_REQUEST_EVENT, RATE_WAIT_EVENT, backgroundWork, rateWait } from "../lib/tab-status/events.ts";

test("real Shell Jobs emits live counts, answers snapshot requests and clears on shutdown", async (t) => {
	t.after(cleanup);
	const app = createFakePi();
	const events = new EventEmitter();
	const snapshots: any[] = [];
	events.on(BACKGROUND_EVENT, (v) => snapshots.push(v));
	const pi = { ...app.pi, events };
	const ctx = { ...app.ctx, sessionManager: { ...app.ctx.sessionManager, getSessionId: () => "parent" } };
	shellJobs(pi as never);
	await fire(app.handlers, "session_start", ctx);
	assert.deepEqual(snapshots.at(-1), { sessionId: "parent", source: "shell-jobs", count: 0 });
	await app.tools.get("shell_job_start").execute("job", { command: "sleep 0.1; printf done" }, undefined, undefined, ctx);
	assert.equal(snapshots.at(-1).count, 1);
	events.emit(BACKGROUND_REQUEST_EVENT, { sessionId: "parent" });
	assert.equal(snapshots.at(-1).count, 1);
	await sleep(500);
	assert.equal(snapshots.at(-1).count, 0);
	await fire(app.handlers, "session_shutdown", ctx, { reason: "quit" });
	assert.equal(snapshots.at(-1).count, 0);
});

test("Shell Jobs preserves a live count across reload without announcing zero", async (t) => {
	t.after(cleanup);
	const events = new EventEmitter(), snapshots: any[] = [];
	events.on(BACKGROUND_EVENT, (value) => snapshots.push(value));
	const first = createFakePi(), pi = { ...first.pi, events };
	const manager = { ...first.ctx.sessionManager, getSessionId: () => "parent" };
	const ctx = { ...first.ctx, sessionManager: manager };
	shellJobs(pi as never); await fire(first.handlers, "session_start", ctx);
	await first.tools.get("shell_job_start").execute("job", { command: "sleep 5" }, undefined, undefined, ctx);
	const start = snapshots.length;
	await fire(first.handlers, "session_shutdown", ctx, { reason: "reload" });
	const next = createFakePi(), fresh = await loadFreshShellJobs();
	fresh.default({ ...next.pi, events } as never);
	await fire(next.handlers, "session_start", { ...next.ctx, sessionManager: manager }, { reason: "reload" });
	assert.ok(snapshots.slice(start).length);
	assert.ok(snapshots.slice(start).every((s) => s.count === 1));
	await fire(next.handlers, "session_shutdown", { ...next.ctx, sessionManager: manager }, { reason: "quit" });
});

test("Rate-limit Recovery UI broadcasts wait boundaries once, including cleanup failures", () => {
	for (const fails of [false, true]) {
		const events = new EventEmitter();
		const snapshots: unknown[] = [];
		events.on(RATE_WAIT_EVENT, (v) => snapshots.push(v));
		const ctx = { sessionManager: { getSessionId: () => "parent" }, ui: { setWidget() {}, onTerminalInput: () => () => { if (fails) throw new Error("cleanup failed"); } } };
		const ui = waitUI(ctx as never, { provider: "fixture" }, { resumeAtMs: 100 }, () => 0, () => {}, undefined, { events } as never);
		assert.deepEqual(snapshots, [{ sessionId: "parent", active: true }]);
		if (fails) assert.throws(() => ui.close(), /cleanup failed/); else ui.close();
		ui.close();
		assert.deepEqual(snapshots, [{ sessionId: "parent", active: true }, { sessionId: "parent", active: false }]);
	}
});

test("event payload validation rejects untrusted counts and flags", () => {
	for (const value of [null, "x", {}, { sessionId: "x", source: "other", count: 1 }, { sessionId: "x", source: "subagents", count: Infinity }, { sessionId: "x", source: "subagents", count: 1.5 }]) assert.equal(backgroundWork(value), undefined);
	assert.deepEqual(backgroundWork({ sessionId: "x", source: "subagents", count: 0 }), { sessionId: "x", source: "subagents", count: 0 });
	for (const value of [null, "x", {}, { sessionId: "x", active: "true" }]) assert.equal(rateWait(value), undefined);
	assert.deepEqual(rateWait({ sessionId: "x", active: false }), { sessionId: "x", active: false });
});
