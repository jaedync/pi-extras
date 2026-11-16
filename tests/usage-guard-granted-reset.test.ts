/**
 * A granted ("banked") reset empties a window but keeps its reset time. Readings
 * from before it must not warn after it, and the window's warnings must arm again
 * for the rest of the cycle. Bug: 2026-11-16, a Mac session told the agent to stop
 * 100 s after the owner applied the weekly reset, from a reading taken before it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLimitStore, type LimitStore } from "../lib/limit-store.ts";
import { parseProxyQuota } from "../lib/status-plus-logic.ts";
import usageGuard, { saveGuardConfig } from "../extensions/usage-guard.ts";

const GRANT = Date.UTC(2026, 10, 16, 15, 20);
const RESET = Date.UTC(2026, 10, 19, 8);
const MODEL = { provider: "anthropic", id: "claude-fable-5-2" };

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

interface Sent {
	content: string;
	details?: { reason?: string; threshold?: number; key?: string };
	/** The reading of the notice's window when it was shown. */
	seen?: { usedPct?: number; exhausted?: boolean; sampledMs?: number };
}

export interface Harness {
	clock: { now: number };
	store: LimitStore;
	sent: Sent[];
	entries: Array<{ type: string; customType: string; data: unknown }>;
	/** Shown notices and session entries in the order they happened: "sent:<key>", "fired:<key>", "rearmed:<key>". */
	log: string[];
	ctx: { model: typeof MODEL; isIdle: () => boolean; sessionManager: { getEntries: () => unknown[] }; ui: { notify: () => void } };
	on(name: string): (event: unknown, ctx: unknown) => Promise<unknown>;
	/** One model request: returns the notices projected into it. */
	request(): Promise<Sent[]>;
}

export function harness(options: { refresher?: (store: LimitStore, now: number) => void } = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "usage-guard-grant-"));
	made.push(dir);
	const configFile = join(dir, "pi-extras.json");
	saveGuardConfig({ enabled: true }, configFile);
	const clock = { now: GRANT - 3_600_000 };
	const store = createLimitStore();
	if (options.refresher) {
		const refresher = options.refresher;
		store.setRefresher(async () => { refresher(store, clock.now); });
	}
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const sent: Sent[] = [];
	const entries: Harness["entries"] = [];
	const log: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
		sendMessage: (message: Sent) => {
			const key = message.details?.key ?? "";
			log.push(`sent:${key}`);
			const window = key.split("|").slice(1, -2).join("|");
			const snapshot = store.get(key.split("|")[0]);
			const entry = snapshot?.entries.find((candidate) => (candidate.key ?? candidate.label) === window);
			const seen = entry && { usedPct: entry.usedPct, exhausted: entry.exhausted, sampledMs: entry.sampledMs ?? snapshot?.atMs };
			sent.push({ content: message.content, details: message.details, ...(seen ? { seen } : {}) });
		},
		appendEntry: (customType: string, data: unknown) => {
			const record = data as { fired?: string[]; rearmed?: string[] };
			for (const key of record.fired ?? []) log.push(`fired:${key}`);
			for (const key of record.rearmed ?? []) log.push(`rearmed:${key}`);
			entries.push({ type: "custom", customType, data });
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
	};
	usageGuard(pi as never, { store, configFile, now: () => clock.now, pollBudgetMs: 50 });
	const ctx = { model: MODEL, isIdle: () => false, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } };
	const on = (name: string) => handlers.get(name)!;
	return {
		clock, store, sent, entries, log, ctx, on,
		async request() {
			const result = await on("context")({ messages: [] }, ctx) as { messages: Array<{ content: string; details?: Sent["details"] }> };
			return result.messages.map((message) => ({ content: message.content, details: message.details }));
		},
	};
}

/** A Meridian-style proxy reading of the weekly window, sampled at `sampledMs`. */
export function reading(store: LimitStore, pct: number, rejected: boolean, sampledMs: number, atMs = sampledMs): void {
	const entries = parseProxyQuota({
		buckets: [{ type: "seven_day", status: rejected ? "rejected" : "allowed", utilization: pct / 100, resetsAt: RESET, observedAt: sampledMs }],
	}, atMs);
	store.set("anthropic", { entries, atMs, source: "poll" });
}

/** A proxy poll that serves `state`: Meridian samples a window again only when a request meets it. */
function proxy(state: { pct: number; rejected: boolean; sampledMs: number }): (store: LimitStore, now: number) => void {
	return (store, now) => reading(store, state.pct, state.rejected, state.sampledMs, now);
}

async function endTurn(h: Harness, stopReason = "toolUse"): Promise<void> {
	await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason } }, h.ctx);
	await h.on("turn_end")({ toolResults: [] }, h.ctx);
}

test("the bug: a pre-grant 100% reading does not warn 100 s after the grant, and its refresh is used", async () => {
	const h = harness({ refresher: (store, now) => reading(store, 0, false, now) });
	await h.on("session_start")({}, h.ctx);
	reading(h.store, 100, true, GRANT - 90_000);
	h.clock.now = GRANT + 100_000;
	assert.deepEqual(await h.request(), [], "no notice enters the request");
	await endTurn(h);
	assert.deepEqual(h.sent, [], "no notice is shown");
});

test("a pre-grant top-band reading gets a forced poll before its wrap-up enters a request", async () => {
	const polls: number[] = [];
	const h = harness({ refresher: (store, now) => { polls.push(now); reading(store, 0, false, now); } });
	await h.on("session_start")({}, h.ctx);
	reading(h.store, 96, false, GRANT - 90_000);
	h.clock.now = GRANT + 100_000;
	assert.deepEqual(await h.request(), []);
	assert.equal(polls.length, 1);
	// One forced poll a minute: the next request does not ask again. A proxy cache serves the old sample.
	h.clock.now += 10_000;
	reading(h.store, 96, false, GRANT - 90_000, h.clock.now);
	assert.equal((await h.request())[0]?.details?.threshold, 95, "a band from an old reading still warns");
	assert.equal(polls.length, 1);
});

test("a pre-grant block that no refresh can confirm does not warn: the request itself is the evidence", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	reading(h.store, 100, true, GRANT - 90_000);
	h.clock.now = GRANT + 100_000;
	assert.deepEqual(await h.request(), []);
	// The request goes through: the block was stale.
	await endTurn(h);
	reading(h.store, 0, false, h.clock.now);
	assert.deepEqual(await h.request(), []);
	assert.deepEqual(h.sent, []);
});

test("a fresh block still warns, and a quota rejection polls for the reading that shows the block", async () => {
	const fresh = harness();
	await fresh.on("session_start")({}, fresh.ctx);
	fresh.clock.now = GRANT + 100_000;
	reading(fresh.store, 100, true, fresh.clock.now - 5_000);
	assert.equal((await fresh.request())[0]?.details?.reason, "exhausted");
	await endTurn(fresh, "error");
	assert.equal(fresh.sent.length, 1);

	const state = { pct: 100, rejected: true, sampledMs: GRANT - 90_000 };
	const rejected = harness({ refresher: proxy(state) });
	await rejected.on("session_start")({}, rejected.ctx);
	reading(rejected.store, 100, true, state.sampledMs);
	rejected.clock.now = GRANT + 100_000;
	assert.deepEqual(await rejected.request(), [], "the forced poll serves the old sample again");
	// The request meets the block, and the proxy samples the window at the rejection.
	state.sampledMs = rejected.clock.now;
	await rejected.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: '{"error":{"type":"rate_limit_error","retry_after":7200}}' } }, rejected.ctx);
	await rejected.on("turn_end")({ toolResults: [] }, rejected.ctx);
	assert.equal(rejected.sent[0]?.details?.reason, "exhausted", "the rejection shows the block at the turn end");
});

test("a notice that a newer reading disproves before the turn ends is not shown, and can fire again later", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT - 10_000;
	reading(h.store, 96, false, h.clock.now);
	assert.equal((await h.request())[0]?.details?.threshold, 95);
	// The grant lands during the turn.
	h.clock.now = GRANT + 10_000;
	reading(h.store, 0, false, h.clock.now);
	await endTurn(h);
	assert.deepEqual(h.sent, [], "the disproved notice is dropped");
	assert.deepEqual(h.entries, [], "and its key is not recorded as fired");
	h.clock.now = GRANT + 3_600_000;
	reading(h.store, 96, false, h.clock.now);
	assert.equal((await h.request())[0]?.details?.threshold, 95);
	await endTurn(h);
	assert.equal(h.sent.length, 1);
});

test("after a granted reset the window's bands arm again in the same session and after a resume", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT - 60_000;
	reading(h.store, 96, false, h.clock.now);
	assert.equal((await h.request())[0]?.details?.threshold, 95);
	await endTurn(h);
	assert.equal(h.sent.length, 1);

	h.clock.now = GRANT + 60_000;
	reading(h.store, 0, false, h.clock.now);
	assert.deepEqual(await h.request(), []);
	await endTurn(h);

	// A new session on the same file: the re-arm was recorded.
	const resumed = harness();
	resumed.entries.push(...h.entries);
	resumed.clock.now = GRANT + 3_600_000;
	await resumed.on("session_start")({}, resumed.ctx);
	reading(resumed.store, 91, false, resumed.clock.now);
	assert.equal((await resumed.request())[0]?.details?.threshold, 90, "the 95 wrap-up no longer silences the window");

	h.clock.now = GRANT + 3_600_000;
	reading(h.store, 96, false, h.clock.now);
	assert.equal((await h.request())[0]?.details?.threshold, 95, "the 95 band fires again");
	await endTurn(h);
	assert.equal(h.sent.length, 2);
});

test("after a granted reset a provider block warns again", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT - 30_000;
	reading(h.store, 100, true, h.clock.now);
	assert.equal((await h.request())[0]?.details?.reason, "exhausted");
	await endTurn(h, "error");
	h.clock.now = GRANT + 60_000;
	reading(h.store, 0, false, h.clock.now);
	await endTurn(h);
	assert.deepEqual(await h.request(), []);
	h.clock.now = GRANT + 3_700_000;
	reading(h.store, 100, true, h.clock.now);
	assert.equal((await h.request())[0]?.details?.reason, "exhausted", "a real block fires again");
	await endTurn(h, "error");
	assert.equal(h.sent.length, 2);
});

test("a block at a low percent does not re-arm when the request succeeds and fails again", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT;
	reading(h.store, 3, true, h.clock.now);
	assert.deepEqual(await h.request(), [], "a kept status at a low percent waits for a quota rejection");
	await rejectTurn(h);
	assert.equal((h.sent as Sent[])[0]?.details?.reason, "exhausted");
	h.clock.now += 10_000;
	await endTurn(h);
	reading(h.store, 3, true, h.clock.now);
	assert.deepEqual(await h.request(), []);
	await rejectTurn(h);
	assert.deepEqual(await h.request(), [], "one wrap-up per cycle");
	await rejectTurn(h);
	assert.equal(h.sent.length, 1);
});

test("a proxy that keeps its last rejection after a granted reset does not keep the window blocked", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT - 30_000;
	reading(h.store, 100, true, h.clock.now);
	assert.equal(h.store.get("anthropic")?.entries[0].exhausted, true);
	// Fresh utilization, old status: the window is empty again.
	h.clock.now = GRANT + 60_000;
	reading(h.store, 0, true, h.clock.now);
	assert.equal(h.store.get("anthropic")?.entries[0].exhausted, false);
	assert.deepEqual(await h.request(), []);
});

/** The same reading, as a Claude Code (SDK) reading that the guard treats as approximate. */
function approximateReading(store: LimitStore, pct: number, rejected: boolean, sampledMs: number): void {
	reading(store, pct, rejected, sampledMs);
	const snapshot = store.get("anthropic")!;
	store.set("anthropic", { ...snapshot, entries: snapshot.entries.map((entry) => ({ ...entry, approximate: true })) });
}

const QUOTA_ERROR = '{"error":{"type":"rate_limit_error","retry_after":7200}}';

async function rejectTurn(h: Harness, withTurnEnd = true): Promise<void> {
	await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: QUOTA_ERROR } }, h.ctx);
	if (withTurnEnd) await h.on("turn_end")({ toolResults: [] }, h.ctx);
	await h.on("agent_end")({ messages: [] }, h.ctx);
}

test("review 1: a request that succeeds disproves a block notice from a reading sampled just before the grant", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	reading(h.store, 100, true, GRANT - 10_000);
	h.clock.now = GRANT + 30_000;
	assert.equal((await h.request())[0]?.details?.reason, "exhausted", "the reading is fresh, so the notice enters the request");
	await endTurn(h);
	assert.deepEqual(h.sent, [], "the success came after the reading: the block notice is not shown");
	h.clock.now += 10_000;
	assert.deepEqual(await h.request(), [], "nor does it enter the next request from the same reading");
	await endTurn(h);
	assert.deepEqual(h.sent, []);
	// A rejection does not name its window, so it does not bring back a block that a success disproved.
	h.clock.now += 10_000;
	await rejectTurn(h);
	assert.deepEqual(h.sent, []);
	// A newer rejected reading is evidence again.
	reading(h.store, 100, true, h.clock.now);
	assert.equal((await h.request())[0]?.details?.reason, "exhausted");
});

test("review 2.1: a transient 429 after a success does not bring back a disproved pre-grant block", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	reading(h.store, 100, true, GRANT - 90_000);
	h.clock.now = GRANT + 100_000;
	assert.deepEqual(await h.request(), []);
	await endTurn(h);
	h.clock.now += 20_000;
	assert.deepEqual(await h.request(), []);
	// A per-minute burst limit, not the weekly window.
	await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: '{"error":{"type":"rate_limit_error","retry_after":20}}' } }, h.ctx);
	await h.on("turn_end")({ toolResults: [] }, h.ctx);
	assert.deepEqual(h.sent, [], "no block is shown");
	h.clock.now += 20_000;
	assert.deepEqual(await h.request(), [], "the retry carries no block");
});

test("review 2.1: a shown block leaves later requests once a success comes after its reading", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT;
	reading(h.store, 100, true, h.clock.now - 5_000);
	await h.request();
	await rejectTurn(h);
	assert.equal(h.sent.length, 1);
	const shown = { role: "custom", customType: "usage-guard", content: h.sent[0].content, details: h.sent[0].details };
	h.clock.now += 30_000;
	await endTurn(h);
	const result = await h.on("context")({ messages: [shown] }, h.ctx) as { messages: unknown[] };
	assert.deepEqual(result.messages, [], "the success disproved the block in history");
});

test("review 2: a block that fired from an approximate reading arms again after a granted reset", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	approximateReading(h.store, 100, true, GRANT - 30_000);
	h.clock.now = GRANT - 20_000;
	assert.equal((await h.request())[0]?.details?.reason, "exhausted");
	await rejectTurn(h);
	assert.equal(h.sent.length, 1);
	h.clock.now = GRANT + 60_000;
	reading(h.store, 0, false, h.clock.now);
	await h.on("turn_end")({ toolResults: [] }, h.ctx);
	h.clock.now += 3_600_000;
	reading(h.store, 96, false, h.clock.now);
	assert.equal((await h.request())[0]?.details?.threshold, 95, "a real 95% later in the cycle warns");
});

test("review 3: a real block from an old reading is shown when the request is rejected, also with no turn end", async () => {
	// With no new reading, a rejection alone does not name a window.
	const unpolled = harness();
	await unpolled.on("session_start")({}, unpolled.ctx);
	reading(unpolled.store, 100, true, GRANT - 180_000);
	unpolled.clock.now = GRANT;
	await unpolled.request();
	await rejectTurn(unpolled);
	assert.deepEqual(unpolled.sent, []);

	for (const withTurnEnd of [true, false]) {
		const state = { pct: 100, rejected: true, sampledMs: GRANT - 180_000 };
		const h = harness({ refresher: proxy(state) });
		await h.on("session_start")({}, h.ctx);
		reading(h.store, 100, true, state.sampledMs);
		h.clock.now = GRANT;
		assert.deepEqual(await h.request(), [], "old evidence waits for the request");
		state.sampledMs = h.clock.now;
		await rejectTurn(h, withTurnEnd);
		assert.equal(h.sent.length, 1, `the rejection shows the block (turn end: ${withTurnEnd})`);
		assert.equal(h.sent[0].details?.reason, "exhausted");
		assert.ok(h.entries.some((entry) => (entry.data as { fired?: string[] }).fired?.some((key) => key.endsWith(`|x|${RESET}`))), "and records its key");
		h.clock.now += 300_000;
		assert.deepEqual(await h.request(), [], "the next request does not repeat it");
	}
});

test("review 4: a band notice is not dropped by a reading older than the one that fired it, or by an approximate one", async () => {
	for (const lower of ["older", "approximate"] as const) {
		const h = harness();
		await h.on("session_start")({}, h.ctx);
		h.clock.now = GRANT + 3_600_000;
		reading(h.store, 96, false, h.clock.now - 120_000);
		assert.equal((await h.request())[0]?.details?.threshold, 95);
		if (lower === "older") reading(h.store, 90, false, h.clock.now - 400_000, h.clock.now);
		else approximateReading(h.store, 90, false, h.clock.now);
		await endTurn(h);
		assert.equal(h.sent.length, 1, `the notice the model saw is shown (${lower} reading)`);
		assert.deepEqual(await h.request(), [], "and does not enter the next request again");
	}
});

test("review 2.3: a rejection waits for a turn end on its own family after a model switch", async () => {
	const state = { pct: 100, rejected: true, sampledMs: GRANT - 180_000 };
	const h = harness({ refresher: proxy(state) });
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT;
	reading(h.store, 100, true, state.sampledMs);
	state.sampledMs = h.clock.now;
	await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: QUOTA_ERROR } }, h.ctx);
	const other = { ...h.ctx, model: { provider: "openai-codex", id: "gpt-6-luna" } };
	await h.on("turn_end")({ toolResults: [] }, other);
	assert.deepEqual(h.sent, [], "the other family's turn end shows nothing");
	h.clock.now += 5_000;
	await h.on("agent_end")({ messages: [] }, h.ctx);
	assert.equal((h.sent as Sent[])[0]?.details?.reason, "exhausted", "the anthropic block is shown on its own family");
});

const BURST_ERROR = '{"error":{"type":"rate_limit_error","retry_after":20}}';

function history(h: Harness): unknown[] {
	return h.sent.map((sent) => ({ role: "custom", customType: "usage-guard", content: sent.content, details: sent.details }));
}

test("review 3.1: a burst 429 before any success does not make a pre-grant block fresh", async () => {
	const state = { pct: 100, rejected: true, sampledMs: GRANT - 90_000 };
	const h = harness({ refresher: proxy(state) });
	await h.on("session_start")({}, h.ctx);
	reading(h.store, 100, true, state.sampledMs);
	h.clock.now = GRANT + 100_000;
	assert.deepEqual(await h.request(), []);
	await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: BURST_ERROR } }, h.ctx);
	await h.on("turn_end")({ toolResults: [] }, h.ctx);
	await h.on("agent_end")({ messages: [] }, h.ctx);
	assert.deepEqual(h.sent, [], "no block is shown");
	h.clock.now += 20_000;
	assert.deepEqual(await h.request(), [], "the retry carries no block");
	// A quota error with no retry time polls, and the proxy's sample of the rejection shows the block.
	state.sampledMs = h.clock.now;
	await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: '{"error":{"type":"rate_limit_error"}}' } }, h.ctx);
	await h.on("agent_end")({ messages: [] }, h.ctx);
	assert.equal((h.sent as Sent[])[0]?.details?.reason, "exhausted");
});

test("review 3.2: a fired key from an older version, with no percent, arms again after a granted reset", async () => {
	const h = harness();
	h.entries.push({ type: "custom", customType: "usage-guard", data: { fired: [`anthropic|seven_day|x|${RESET}`] } });
	h.clock.now = GRANT + 3_600_000;
	await h.on("session_start")({}, h.ctx);
	reading(h.store, 0, false, h.clock.now);
	await h.request();
	await endTurn(h);
	h.clock.now += 3_600_000;
	reading(h.store, 96, false, h.clock.now);
	assert.equal((await h.request())[0]?.details?.threshold, 95);
});

test("review 3.3: a block notice in history leaves the first request after a grant while the proxy serves the old sample", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT - 30_000;
	reading(h.store, 100, true, h.clock.now - 5_000);
	await h.request();
	await rejectTurn(h);
	assert.equal(h.sent.length, 1);
	h.clock.now = GRANT + 100_000;
	reading(h.store, 100, true, GRANT - 35_000, h.clock.now);
	const result = await h.on("context")({ messages: history(h) }, h.ctx) as { messages: unknown[] };
	assert.deepEqual(result.messages, [], "old evidence does not keep the block in the request");
	// A new quota rejection and the proxy's new sample of it bring the block back into the next request.
	reading(h.store, 100, true, h.clock.now);
	await rejectTurn(h);
	const again = await h.on("context")({ messages: history(h) }, h.ctx) as { messages: unknown[] };
	assert.equal(again.messages.length, 1);
});

const RESET5 = GRANT + 2 * 3_600_000;

/** Meridian's answer with both windows: a request's rate-limit event, or the OAuth overlay, sets each bucket's sample time. */
function bothWindows(store: LimitStore, five: [number, boolean], seven: [number, boolean], sampledMs: number, atMs = sampledMs): void {
	const entries = parseProxyQuota({ buckets: [
		{ type: "five_hour", status: five[1] ? "rejected" : "allowed", utilization: five[0] / 100, resetsAt: RESET5, observedAt: sampledMs },
		{ type: "seven_day", status: seven[1] ? "rejected" : "allowed", utilization: seven[0] / 100, resetsAt: RESET, observedAt: sampledMs },
	] }, atMs);
	store.set("anthropic", { entries, atMs, source: "poll" });
}

const shownKeys = (h: Harness) => h.sent.map((sent) => sent.details?.key ?? "");

test("review 4.1: a real 5h rejection after a 7d grant does not show the pre-grant 7d block", async () => {
	// No poller: both windows keep the pre-grant sample.
	const old = harness();
	await old.on("session_start")({}, old.ctx);
	bothWindows(old.store, [100, true], [100, true], GRANT - 90_000);
	old.clock.now = GRANT + 100_000;
	assert.deepEqual(await old.request(), []);
	await old.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: '{"error":{"type":"rate_limit_error","retry_after":7000}}' } }, old.ctx);
	await old.on("turn_end")({ toolResults: [] }, old.ctx);
	await old.on("agent_end")({ messages: [] }, old.ctx);
	assert.ok(!shownKeys(old).some((key) => key.includes("|seven_day|")), `7d block shown: ${shownKeys(old)}`);

	// Meridian: the 5h rejection is a fresh sample, and the OAuth overlay keeps 7d's old "rejected" at 0%.
	const live = harness({ refresher: (store, now) => bothWindows(store, [100, true], [0, true], now) });
	await live.on("session_start")({}, live.ctx);
	bothWindows(live.store, [100, true], [100, true], GRANT - 90_000);
	live.clock.now = GRANT + 100_000;
	const carried = await live.request();
	assert.deepEqual(carried.map((notice) => notice.details?.key), [`anthropic|five_hour|x|${RESET5}`], "the request carries the true 5h block only");
	await live.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: "error", errorMessage: '{"error":{"type":"rate_limit_error","retry_after":7000}}' } }, live.ctx);
	await live.on("turn_end")({ toolResults: [] }, live.ctx);
	await live.on("agent_end")({ messages: [] }, live.ctx);
	assert.deepEqual(shownKeys(live), [`anthropic|five_hour|x|${RESET5}`]);
	live.clock.now += 30_000;
	const next = await live.on("context")({ messages: history(live) }, live.ctx) as { messages: Sent[] };
	assert.ok(!next.messages.some((message) => message.details?.key?.includes("|seven_day|")), "no 7d block in the next request");
});

test("review 4.2: a new runtime's first reading after a grant, 0% with the proxy's kept rejection, does not block", async () => {
	const h = harness();
	await h.on("session_start")({}, h.ctx);
	h.clock.now = GRANT + 120_000;
	reading(h.store, 0, true, h.clock.now - 5_000);
	assert.deepEqual((await h.request()).map((notice) => notice.details?.reason), [], "no block enters the request");
	await endTurn(h);
	assert.deepEqual(h.sent, []);
	// A real block at a low percent still shows at its quota rejection.
	h.clock.now += 10_000;
	reading(h.store, 0, true, h.clock.now);
	await rejectTurn(h);
	assert.equal((h.sent as Sent[])[0]?.details?.reason, "exhausted");
});

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const RATE_LIMIT = '{"error":{"type":"rate_limit_error","retry_after":7200}}';
const FRESH_MS = 60_000;

/**
 * Random orders of polls (some served from a proxy cache with an old sample, or
 * with the proxy's kept "rejected" status at a lower percent), granted resets,
 * requests that carry the shown notices as history, turn ends, run ends with no
 * turn end, successes, quota rejections (only while the window is blocked),
 * burst 429s, resumes and clock steps. Usage only falls at a grant. Checks, for
 * every order:
 * - truth: a block is shown or carried only while the window is blocked, or at
 *   most FRESH_MS after its grant;
 * - a block enters a request, new or from history, only on a sample at most
 *   FRESH_MS old and no older than the last success (below 95%, also a quota
 *   rejection at most FRESH_MS old);
 * - a shown notice matches its window's reading when it is shown;
 * - each shown key was recorded first, and no key is shown twice without a
 *   re-arm between;
 * - a quota rejection on an evidenced block shows a wrap-up by its run end;
 * - after a grant, a reading at the top band, or a fresh block, warns again.
 */
test("property: over random event orders, warnings follow the newest evidence and re-arm after each grant", async () => {
	for (let seed = 1; seed <= 1000; seed++) {
		const rand = random(seed);
		const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
		let truth = { pct: 0, rejected: false };
		let blockEndedAt = -Infinity;
		let lastSample = GRANT;
		let cached = { pct: 0, rejected: false, sampledMs: GRANT };
		let lastRejectAt = -Infinity;
		let lastSuccessAt = -Infinity;
		// The percent of the shown wrap-up: the guard re-arms when it sees a reading 50 points lower.
		let wrapUpShown: number | undefined;
		let wrapUpQueued = false;
		// Block keys that a request carried: the turn end may show them after their evidence aged.
		const carried = new Set<string>();
		const seeDrop = () => {
			const pct = h.store.get("anthropic")?.entries[0]?.usedPct;
			if (wrapUpShown !== undefined && pct !== undefined && pct <= wrapUpShown - 50) wrapUpShown = undefined;
		};
		// Odd seeds have a poller that a stale final warning or a rejection can force; even seeds have none.
		const start = () => harness(seed % 2 ? { refresher: (store, now) => { cached = { ...truth, sampledMs: now }; lastSample = now; reading(store, truth.pct, truth.rejected, now); } } : {});
		let h = start();
		h.clock.now = GRANT;
		await h.on("session_start")({}, h.ctx);
		reading(h.store, 0, false, GRANT);
		const trace: string[] = [];
		const where = () => `seed ${seed}: ${trace.join(", ")}`;
		let persisted = new Set<string>();
		let shownKeys = new Set<string>();
		let logged = 0;
		const checkLog = () => {
			for (const item of h.log.slice(logged)) {
				const [kind, key] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
				if (kind === "fired") persisted.add(key);
				else if (kind === "rearmed") { persisted.delete(key); shownKeys.delete(key); }
				else {
					assert.ok(persisted.has(key), `a key shown before it was recorded: ${where()}`);
					assert.ok(!shownKeys.has(key), `a key shown twice with no re-arm: ${where()}`);
					shownKeys.add(key);
				}
			}
			logged = h.log.length;
		};
		const blockEvidenced = () => {
			const pct = h.store.get("anthropic")?.entries[0]?.usedPct ?? 100;
			return h.clock.now - lastSample <= FRESH_MS && lastSample >= lastSuccessAt && (pct >= 95 || h.clock.now - lastRejectAt <= FRESH_MS);
		};
		const truthBlocked = () => truth.rejected || h.clock.now - blockEndedAt <= FRESH_MS;
		for (let step = 0; step < 40; step++) {
			let event = pick(["poll", "poll", "cached", "kept", "kept", "grant", "request", "request", "turn", "success", "reject", "burst", "agentEnd", "resume", "newProcess", "tick"] as const);
			// A quota rejection comes only from a blocked window.
			if (event === "reject" && !truth.rejected) event = "burst";
			trace.push(event);
			if (event === "poll") {
				const pct = Math.min(100, truth.pct + pick([0, 5, 20, 45]));
				truth = { pct, rejected: pct >= 100 };
				cached = { ...truth, sampledMs: h.clock.now };
				lastSample = h.clock.now;
				reading(h.store, truth.pct, truth.rejected, h.clock.now);
			} else if (event === "cached") {
				// A proxy serves its last sample again, maybe from before a grant.
				reading(h.store, cached.pct, cached.rejected, cached.sampledMs, h.clock.now);
				lastSample = cached.sampledMs;
			} else if (event === "kept") {
				// Meridian overlays a new percent and sample time but keeps the bucket's last "rejected" status.
				if (cached.rejected) {
					cached = { pct: truth.pct, rejected: true, sampledMs: h.clock.now };
					lastSample = h.clock.now;
					reading(h.store, cached.pct, true, h.clock.now);
				}
			} else if (event === "grant") {
				if (truth.rejected) blockEndedAt = h.clock.now;
				truth = { pct: 0, rejected: false };
			} else if (event === "resume") {
				// A new runtime restores fired keys from the session; it starts with no successes or rejections seen.
				await h.on("session_shutdown")({}, h.ctx);
				await h.on("session_start")({}, h.ctx);
				lastRejectAt = -Infinity;
				lastSuccessAt = -Infinity;
				wrapUpQueued = false;
				carried.clear();
			} else if (event === "newProcess") {
				// A new Pi process and session: an empty store, no fired keys; the proxy keeps its state.
				await h.on("session_shutdown")({}, h.ctx);
				const at = h.clock.now;
				h = start();
				h.clock.now = at;
				await h.on("session_start")({}, h.ctx);
				lastSample = -Infinity;
				lastRejectAt = -Infinity;
				lastSuccessAt = -Infinity;
				wrapUpShown = undefined;
				wrapUpQueued = false;
				carried.clear();
				persisted = new Set();
				shownKeys = new Set();
				logged = 0;
			} else if (event === "request") {
				seeDrop();
				const shown = h.sent.map((sent) => ({ role: "custom", customType: "usage-guard", content: sent.content, details: sent.details, fromHistory: true }));
				const result = await h.on("context")({ messages: shown }, h.ctx) as { messages: Array<Sent & { fromHistory?: boolean }> };
				seeDrop();
				const entry = h.store.get("anthropic")?.entries[0];
				const notices = result.messages.filter((message) => !message.fromHistory);
				for (const message of result.messages) {
					if (message.details?.reason !== "exhausted") continue;
					assert.ok(truthBlocked(), `a block in a request while the window is open: ${where()}`);
					assert.ok(blockEvidenced(), `a block in a request on old or disproved evidence: ${where()}`);
				}
				for (const notice of notices) {
					if ((notice.details as { final?: boolean }).final) wrapUpQueued = true;
					if (notice.details?.reason === "exhausted") carried.add(notice.details.key ?? "");
				}
				// A block is due only on fresh evidence; a top band on any reading.
				const due = entry !== undefined && !entry.approximate && (entry.exhausted === true ? blockEvidenced() : (entry.usedPct ?? 0) >= 95);
				if (due && wrapUpShown === undefined && !wrapUpQueued) {
					assert.ok(notices.some((notice) => (notice.details as { final?: boolean }).final), `a due wrap-up did not fire: ${where()}`);
				}
			} else if (event === "turn" || event === "success" || event === "reject" || event === "burst" || event === "agentEnd") {
				const before = h.sent.length;
				seeDrop();
				const capped = wrapUpShown !== undefined;
				if (event !== "agentEnd") {
					const failed = event === "reject" || event === "burst";
					if (event === "reject") lastRejectAt = h.clock.now;
					if (!failed) lastSuccessAt = h.clock.now;
					const errorMessage = event === "reject" ? RATE_LIMIT : event === "burst" ? BURST_ERROR : undefined;
					await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason: failed ? "error" : "toolUse", ...(errorMessage ? { errorMessage } : {}) } }, h.ctx);
				}
				// A failed request can end the run with no turn end.
				if (event === "turn" || event === "success" || rand() < 0.5) await h.on("turn_end")({ toolResults: [] }, h.ctx);
				await h.on("agent_end")({ messages: [] }, h.ctx);
				const entry = h.store.get("anthropic")?.entries[0];
				for (const shown of h.sent.slice(before)) {
					const details = shown.details as { final?: boolean; reason?: string; threshold?: number; key?: string };
					if (details.reason === "exhausted") {
						assert.ok(truthBlocked(), `a block shown while the window is open: ${where()}`);
						assert.equal(shown.seen?.exhausted, true, `a block shown on an open reading: ${where()}`);
						assert.ok((shown.seen?.sampledMs ?? -Infinity) >= lastSuccessAt, `a block shown from a reading that a success disproved: ${where()}`);
						if (!carried.has(details.key ?? "")) assert.ok(blockEvidenced(), `a block shown on old evidence: ${where()}`);
					}
					else assert.ok((shown.seen?.usedPct ?? 0) >= (details.threshold ?? 0), `a band shown below its threshold: ${where()}`);
					if (details.final) wrapUpShown = (shown.details as { pct?: number }).pct ?? 100;
				}
				// With a poller, the rejection's poll reads the block: the wrap-up must show.
				const evidenced = seed % 2 === 1 || (entry?.exhausted === true && !entry.approximate && blockEvidenced());
				if (event === "reject" && evidenced && !capped) {
					assert.ok(h.sent.slice(before).some((shown) => (shown.details as { final?: boolean }).final), `a quota rejection on an evidenced block showed no wrap-up: ${where()}`);
				}
				wrapUpQueued = false;
				carried.clear();
				seeDrop();
			} else {
				h.clock.now += pick([5_000, 30_000, 90_000, 300_000]);
			}
			checkLog();
		}
	}
});
