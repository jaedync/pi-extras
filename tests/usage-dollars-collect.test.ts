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
