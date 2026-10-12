import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import { createDollarsCollector } from "../lib/usage-dollars/collect.ts";

const TZ = "America/Chicago";
const NOW = Date.UTC(2026, 9, 10, 17);
const HOUR = 3_600_000;
const KEY = "read-key-for-tests-0123456789";

function agentDir(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "dollars-agent-"));
	mkdirSync(join(dir, "sessions", "--cwd--"), { recursive: true });
	writeFileSync(join(dir, "pi-extras.json"), JSON.stringify({ usageDollars: config }));
	writeFileSync(join(dir, "read-key"), `${KEY}\n`);
	const turn = (provider: string, model: string, cost: number, id: string) => JSON.stringify({
		type: "message", timestamp: new Date(NOW - HOUR).toISOString(),
		message: { role: "assistant", provider, model, responseId: id, timestamp: NOW - HOUR, usage: { totalTokens: 1, cost: { total: cost } } },
	});
	writeFileSync(join(dir, "sessions", "--cwd--", "s.jsonl"),
		[turn("anthropic", "claude-opus-5-5", 10, "a"), turn("opencode-go", "deepseek-v4.1-flash", 0.5, "b")].join("\n") + "\n");
	return dir;
}

const HA = {
	cost_today_usd: 99,
	five_hour: { pct_used: 20, spend_usd: 100, implied_limit_usd: 500, resets_at: new Date(NOW + HOUR).toISOString() },
	updated_at_epoch: NOW / 1000,
};

function context(patch: Partial<Parameters<ReturnType<typeof createDollarsCollector>["collect"]>[0]> = {}) {
	return {
		snapshots: [] as Array<[string, LimitSnapshot]>,
		model: { provider: "anthropic", id: "claude-opus-5-5" },
		scopedModels: [{ provider: "opencode-go", id: "glm-5.3" }, { provider: "anthropic", id: "claude-opus-5-5" }],
		getApiKey: async () => undefined,
		now: NOW,
		...patch,
	};
}

test("collects local spend, Tokenfold and the OpenCode Go models agents can pick", async () => {
	const dir = agentDir({ tokenfold: { url: "https://t.example", keyFile: join("~", "never-used") } });
	// The key file named in settings is used; point it at the test file.
	writeFileSync(join(dir, "pi-extras.json"), JSON.stringify({ usageDollars: { tokenfold: { url: "https://t.example", keyFile: join(dir, "read-key") } } }));
	const calls: string[] = [];
	const collector = createDollarsCollector({
		agentDir: dir, timeZone: TZ,
		fetch: async (url) => { calls.push(String(url)); return new Response(JSON.stringify(HA)); },
	});
	const { inputs, notes } = await collector.collect(context());
	assert.deepEqual(calls, ["https://t.example/api/ha"]);
	assert.equal(inputs.tokenfold?.costTodayUsd, 99);
	assert.deepEqual(inputs.today?.byProvider, { anthropic: 10, "opencode-go": 0.5 });
	assert.equal(inputs.spend?.({ provider: "anthropic", sinceMs: 0, untilMs: NOW }), 10);
	assert.deepEqual(inputs.openCodeGo, { plan: "go", caps: {}, models: ["glm-5.3", "deepseek-v4.1-flash"] });
	assert.deepEqual(notes, []);
	// A second collect within the cache time does not call Tokenfold again.
	await collector.collect(context({ now: NOW + 1000 }));
	assert.equal(calls.length, 1);
	// A forced refresh does.
	await collector.collect(context({ now: NOW + 2000, force: true }));
	assert.equal(calls.length, 2);
});

test("without Tokenfold settings the notes say the Claude figures are this machine's", async () => {
	const collector = createDollarsCollector({ agentDir: agentDir({}), timeZone: TZ, fetch: async () => { throw new Error("no network in tests"); } });
	const { inputs, notes } = await collector.collect(context());
	assert.equal(inputs.tokenfold, undefined);
	assert.ok(notes.some((note) => /Tokenfold is not set up/.test(note)));
});

test("a Tokenfold failure becomes a note, and a missing key file is named without its path", async () => {
	const dir = agentDir({ tokenfold: { url: "https://t.example", keyFile: "/nonexistent/key" } });
	const collector = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: async () => new Response("", { status: 401 }) });
	const missing = await collector.collect(context());
	assert.ok(missing.notes.some((note) => /key file/.test(note) && !note.includes("/nonexistent")));
	writeFileSync(join(dir, "pi-extras.json"), JSON.stringify({ usageDollars: { tokenfold: { url: "https://t.example", keyFile: join(dir, "read-key") } } }));
	const refused = await collector.collect(context({ force: true }));
	assert.ok(refused.notes.some((note) => /HTTP 401/.test(note)));
});

test("OpenRouter's key endpoint is read only when there is an OpenRouter key", async () => {
	const calls: string[] = [];
	const collector = createDollarsCollector({
		agentDir: agentDir({}), timeZone: TZ,
		fetch: async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ data: { usage_daily: 2 } })); },
	});
	await collector.collect(context());
	assert.equal(calls.length, 0);
	const openrouter: Array<[string, LimitSnapshot]> = [["openrouter", { atMs: NOW, source: "poll", entries: [{ label: "", kind: "credits", balanceUsd: 5 }] }]];
	const { inputs } = await collector.collect(context({ snapshots: openrouter, getApiKey: async (provider: string) => (provider === "openrouter" ? "or-key" : undefined), force: true }));
	assert.deepEqual(calls, ["https://openrouter.ai/api/v1/key"]);
	assert.equal(inputs.openRouterKey?.usageDailyUsd, 2);
});

test("meter readings anchor the day in a shared file, and later readings measure today's spend", async () => {
	const dir = agentDir({});
	const meter = (usedUsd: number): Array<[string, LimitSnapshot]> =>
		[["anthropic", { atMs: NOW, source: "poll", entries: [{ label: "", kind: "budget", usedUsd, limitUsd: 2000 }] }]];
	const first = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: async () => new Response("{}") });
	first.observe(meter(1100), NOW);
	// Another process reads the same anchor.
	const second = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: async () => new Response("{}") });
	const { inputs } = await second.collect(context({ snapshots: meter(1130), now: NOW + HOUR }));
	assert.deepEqual(inputs.meterToday, { anthropic: { spentUsd: 30, sinceMs: NOW } });
	const stored = JSON.parse(readFileSync(join(dir, "usage-dollars", "meter-day.json"), "utf8"));
	assert.deepEqual(stored.anthropic, { date: "2026-10-10", usedUsd: 1100, atMs: NOW });
});

test("a meter reading taken before local midnight does not anchor today", async () => {
	const dir = agentDir({});
	const meter = (usedUsd: number, atMs: number): Array<[string, LimitSnapshot]> =>
		[["anthropic", { atMs, source: "poll", entries: [{ label: "", kind: "budget", usedUsd, limitUsd: 2000 }] }]];
	const collector = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: async () => new Response("{}") });
	// 17:00 UTC is noon in Chicago; a snapshot from 20 hours earlier is yesterday's.
	collector.observe(meter(1000, NOW - 20 * HOUR), NOW);
	collector.observe(meter(1100, NOW - HOUR), NOW);
	const { inputs } = await collector.collect(context({ snapshots: meter(1130, NOW), now: NOW }));
	assert.deepEqual(inputs.meterToday, { anthropic: { spentUsd: 30, sinceMs: NOW - HOUR } });
});

test("OpenRouter is not asked without an OpenRouter snapshot, and Tokenfold is asked once for concurrent calls", async () => {
	const dir = agentDir({});
	writeFileSync(join(dir, "pi-extras.json"), JSON.stringify({ usageDollars: { tokenfold: { url: "https://t.example", keyFile: join(dir, "read-key") } } }));
	const calls: string[] = [];
	const collector = createDollarsCollector({
		agentDir: dir, timeZone: TZ,
		fetch: async (url) => { calls.push(String(url)); return new Response(JSON.stringify(HA)); },
	});
	const withKey = { getApiKey: async () => "or-key" };
	await Promise.all([collector.collect(context(withKey)), collector.collect(context(withKey))]);
	assert.deepEqual(calls, ["https://t.example/api/ha"]);
});

test("a window's implied size is kept for the start of the next cycle", async () => {
	const dir = agentDir({});
	const window = (usedPct: number, resetMs: number): Array<[string, LimitSnapshot]> =>
		[["anthropic", { atMs: NOW, source: "poll", entries: [{ label: "5h", key: "five_hour", usedPct, windowSeconds: 18000, resetMs }] }]];
	const collector = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: async () => new Response("{}") });
	// $10 of local spend at 20% gives a $50 window.
	await collector.collect(context({ snapshots: window(20, NOW + HOUR) }));
	const later = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: async () => new Response("{}") });
	const { inputs } = await later.collect(context({ snapshots: window(1, NOW + 6 * HOUR), now: NOW + 2 * HOUR }));
	assert.deepEqual(inputs.lastSizes?.["anthropic|five_hour"], { limitUsd: 50, atMs: NOW, source: "local" });
});

/** Anthropic turns at the given times, with their list-price cost. */
function agentDirWithTurns(turns: Array<[atMs: number, cost: number]>): string {
	const dir = agentDir({});
	const lines = turns.map(([atMs, cost], index) => JSON.stringify({
		type: "message", timestamp: new Date(atMs).toISOString(),
		message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", responseId: `t${index}`, timestamp: atMs, usage: { totalTokens: 1, cost: { total: cost } } },
	}));
	writeFileSync(join(dir, "sessions", "--cwd--", "s.jsonl"), lines.join("\n") + "\n");
	return dir;
}

const weekly = (usedPct: number, atMs: number, resetMs = NOW + 3 * 24 * HOUR): Array<[string, LimitSnapshot]> =>
	[["anthropic", { atMs, source: "poll", entries: [{ label: "7d", key: "seven_day", usedPct, windowSeconds: 7 * 86400, resetMs }] }]];
const MIN = 60_000;
const noFetch = async () => new Response("{}");

test("polls record window readings, so a granted reset starts at the poll that saw it", async () => {
	// $10 before the grant, $4 after it.
	const dir = agentDirWithTurns([[NOW - 3 * HOUR, 10], [NOW - 30 * MIN, 4]]);
	const poller = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: noFetch });
	// The poll hook only observes; no usage call happens until later.
	poller.observe(weekly(97, NOW - HOUR - 5 * MIN), NOW - HOUR - 5 * MIN);
	poller.observe(weekly(0, NOW - HOUR), NOW - HOUR);
	poller.observe(weekly(1, NOW - 55 * MIN), NOW - 55 * MIN);
	// Another process shares the readings file.
	const later = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: noFetch });
	const { inputs, notes } = await later.collect(context({ snapshots: weekly(8, NOW), now: NOW }));
	assert.equal(inputs.resetEvidence?.["anthropic|seven_day"]?.grant?.startMs, NOW - HOUR);
	// $4 at 8% is a $50 window; from the cycle start it would read $175.
	assert.deepEqual(inputs.lastSizes?.["anthropic|seven_day"], { limitUsd: 50, atMs: NOW, source: "local" });
	assert.deepEqual(notes, ["Tokenfold is not set up (usageDollars.tokenfold in pi-extras.json), so Claude window dollars count this machine's spend only."]);
});

test("a granted reset found after a long gap in the readings keeps no size", async () => {
	const dir = agentDirWithTurns([[NOW - 3 * HOUR, 10], [NOW - 30 * MIN, 4]]);
	const collector = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: noFetch });
	collector.observe(weekly(97, NOW - 5 * HOUR), NOW - 5 * HOUR);
	collector.observe(weekly(0, NOW - HOUR), NOW - HOUR);
	const { inputs } = await collector.collect(context({ snapshots: weekly(8, NOW), now: NOW }));
	assert.equal(inputs.resetEvidence?.["anthropic|seven_day"]?.grant?.approximate, true);
	assert.equal(inputs.lastSizes?.["anthropic|seven_day"], undefined);
});

test("sizes kept before granted resets were handled are not used", async () => {
	const dir = agentDirWithTurns([[NOW - HOUR, 1]]);
	mkdirSync(join(dir, "usage-dollars"), { recursive: true });
	writeFileSync(join(dir, "usage-dollars", "window-sizes.json"),
		JSON.stringify({ "anthropic|seven_day": { limitUsd: 52051, atMs: NOW - HOUR, source: "tokenfold" } }));
	const collector = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: noFetch });
	const { inputs } = await collector.collect(context({ snapshots: weekly(1, NOW), now: NOW }));
	assert.equal(inputs.lastSizes?.["anthropic|seven_day"], undefined);
});

test("a state file that cannot be saved becomes a note", async () => {
	const dir = agentDirWithTurns([[NOW - HOUR, 1]]);
	// A directory in the file's place makes the rename fail.
	mkdirSync(join(dir, "usage-dollars", "window-readings.json", "blocker"), { recursive: true });
	const collector = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: noFetch });
	const { notes } = await collector.collect(context({ snapshots: weekly(10, NOW), now: NOW }));
	assert.ok(notes.some((note) => /window-readings\.json/.test(note) && /granted resets/.test(note)), notes.join(" | "));
});

test("a failing meter observer does not stop the window readings, and the report says so", async () => {
	const dir = agentDirWithTurns([[NOW - 30 * MIN, 4]]);
	const collector = createDollarsCollector({ agentDir: dir, timeZone: TZ, fetch: noFetch });
	collector.observe(weekly(97, NOW - 10 * MIN), NOW - 10 * MIN);
	collector.observe(weekly(0, NOW - 5 * MIN), NOW - 5 * MIN);
	// The first read of the entries (the meter observer's) throws; later reads work.
	const [[provider, snapshot]] = weekly(1, NOW);
	let reads = 0;
	const flaky = { atMs: snapshot.atMs, source: snapshot.source, get entries() {
		reads += 1;
		if (reads === 1) throw new Error("synthetic meter failure");
		return snapshot.entries;
	} } as LimitSnapshot;
	const { inputs, notes } = await collector.collect(context({ snapshots: [[provider, flaky]], now: NOW }));
	assert.equal(inputs.resetEvidence?.["anthropic|seven_day"]?.grant?.startMs, NOW - 5 * MIN);
	assert.ok(notes.some((note) => /meter readings/.test(note)), notes.join(" | "));
	// The next good observation clears the note.
	const again = await collector.collect(context({ snapshots: weekly(2, NOW + MIN), now: NOW + MIN, force: true }));
	assert.ok(!again.notes.some((note) => /meter readings/.test(note)), again.notes.join(" | "));
});
