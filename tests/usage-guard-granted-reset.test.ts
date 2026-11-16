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

interface Sent { content: string; details?: { reason?: string; threshold?: number; key?: string } }

export interface Harness {
	clock: { now: number };
	store: LimitStore;
	sent: Sent[];
	entries: Array<{ type: string; customType: string; data: unknown }>;
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
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
		sendMessage: (message: Sent) => sent.push({ content: message.content, details: message.details }),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerTool: () => undefined,
		registerCommand: () => undefined,
	};
	usageGuard(pi as never, { store, configFile, now: () => clock.now, pollBudgetMs: 50 });
	const ctx = { model: MODEL, isIdle: () => false, sessionManager: { getEntries: () => entries }, ui: { notify: () => undefined } };
	const on = (name: string) => handlers.get(name)!;
	return {
		clock, store, sent, entries, ctx, on,
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

test("a fresh block still warns, and a quota rejection is fresh evidence for an old reading", async () => {
	const fresh = harness();
	await fresh.on("session_start")({}, fresh.ctx);
	fresh.clock.now = GRANT + 100_000;
	reading(fresh.store, 100, true, fresh.clock.now - 5_000);
	assert.equal((await fresh.request())[0]?.details?.reason, "exhausted");
	await endTurn(fresh, "error");
	assert.equal(fresh.sent.length, 1);

	const rejected = harness();
	await rejected.on("session_start")({}, rejected.ctx);
	reading(rejected.store, 100, true, GRANT - 90_000);
	rejected.clock.now = GRANT + 100_000;
	assert.deepEqual(await rejected.request(), []);
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
	assert.equal((await h.request())[0]?.details?.reason, "exhausted");
	await endTurn(h);
	h.clock.now += 10_000;
	reading(h.store, 3, true, h.clock.now);
	assert.deepEqual(await h.request(), []);
	await endTurn(h, "error");
	assert.deepEqual(await h.request(), [], "one wrap-up per cycle");
	await endTurn(h, "error");
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
	// A newer rejection is evidence again.
	h.clock.now += 10_000;
	await rejectTurn(h);
	assert.equal((h.sent as Sent[]).at(-1)?.details?.reason, "exhausted");
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
	for (const withTurnEnd of [true, false]) {
		const h = harness();
		await h.on("session_start")({}, h.ctx);
		reading(h.store, 100, true, GRANT - 180_000);
		h.clock.now = GRANT;
		assert.deepEqual(await h.request(), [], "old evidence waits for the request");
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
 * Random orders of polls (some served from a proxy cache with an old sample),
 * granted resets, prompts, turn ends, successes, quota rejections and clock
 * steps. Usage only falls at a grant. Checks, for every order:
 * - a block notice enters a request only on evidence at most FRESH_MS old and newer than the last success;
 * - a shown notice matches the newest reading at the moment it is shown;
 * - after a grant, a reading at the top band, or a fresh block, warns again.
 */
test("property: over random event orders, warnings follow the newest evidence and re-arm after each grant", async () => {
	for (let seed = 1; seed <= 300; seed++) {
		const rand = random(seed);
		const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
		let truth = { pct: 0, rejected: false };
		let lastSample = GRANT;
		let cached = { pct: 0, rejected: false, sampledMs: GRANT };
		let lastRejectAt = -Infinity;
		let lastSuccessAt = -Infinity;
		// The percent of the shown wrap-up: the guard re-arms when it sees a reading 50 points lower.
		let wrapUpShown: number | undefined;
		let wrapUpQueued = false;
		const seeDrop = () => {
			const pct = h.store.get("anthropic")?.entries[0]?.usedPct;
			if (wrapUpShown !== undefined && pct !== undefined && pct <= wrapUpShown - 50) wrapUpShown = undefined;
		};
		// Odd seeds have a poller that a stale final warning can force; even seeds have none.
		const h = harness(seed % 2 ? { refresher: (store, now) => { cached = { ...truth, sampledMs: now }; lastSample = now; reading(store, truth.pct, truth.rejected, now); } } : {});
		h.clock.now = GRANT;
		await h.on("session_start")({}, h.ctx);
		reading(h.store, 0, false, GRANT);
		const trace: string[] = [];
		const where = () => `seed ${seed}: ${trace.join(", ")}`;
		for (let step = 0; step < 40; step++) {
			const event = pick(["poll", "poll", "cached", "grant", "request", "request", "turn", "success", "reject", "tick"] as const);
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
			} else if (event === "grant") {
				truth = { pct: 0, rejected: false };
			} else if (event === "request") {
				seeDrop();
				const notices = await h.request();
				seeDrop();
				const entry = h.store.get("anthropic")?.entries[0];
				const evidence = Math.max(lastSample, lastRejectAt);
				for (const notice of notices) {
					const details = notice.details as { final?: boolean; reason?: string; threshold?: number };
					if (details.reason === "exhausted") assert.ok(h.clock.now - evidence <= FRESH_MS && evidence >= lastSuccessAt, `block notice on old or disproved evidence: ${where()}`);
					if (details.final) wrapUpQueued = true;
				}
				// A success after the evidence disproves a block.
				const fresh = h.clock.now - evidence <= FRESH_MS && evidence >= lastSuccessAt;
				// A block is due only on fresh evidence; a top band on any reading.
				const due = entry !== undefined && !entry.approximate && (entry.exhausted === true ? fresh : (entry.usedPct ?? 0) >= 95);
				if (due && wrapUpShown === undefined && !wrapUpQueued) {
					assert.ok(notices.some((notice) => (notice.details as { final?: boolean }).final), `a due wrap-up did not fire: ${where()}`);
				}
			} else if (event === "turn" || event === "success" || event === "reject") {
				const before = h.sent.length;
				const stopReason = event === "reject" ? "error" : "toolUse";
				if (event === "reject") lastRejectAt = h.clock.now;
				else lastSuccessAt = h.clock.now;
				await h.on("message_end")({ message: { role: "assistant", provider: "anthropic", model: MODEL.id, stopReason, ...(event === "reject" ? { errorMessage: RATE_LIMIT } : {}) } }, h.ctx);
				await h.on("turn_end")({ toolResults: [] }, h.ctx);
				const entry = h.store.get("anthropic")?.entries[0];
				for (const shown of h.sent.slice(before)) {
					const details = shown.details as { final?: boolean; reason?: string; threshold?: number };
					if (details.reason === "exhausted") assert.equal(entry?.exhausted, true, `a block shown on an open window: ${where()}`);
					else assert.ok((entry?.usedPct ?? 0) >= (details.threshold ?? 0), `a band shown below its threshold: ${where()}`);
					if (details.final) wrapUpShown = (shown.details as { pct?: number }).pct ?? 100;
				}
				wrapUpQueued = false;
				seeDrop();
			} else {
				h.clock.now += pick([5_000, 30_000, 90_000, 300_000]);
			}
		}
	}
});
