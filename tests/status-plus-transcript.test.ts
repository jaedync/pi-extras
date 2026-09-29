import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAIN_ENTRY } from "../lib/chain/run.ts";
import { BILLING_SOURCE_ENTRY, collect } from "../lib/status-plus-transcript.ts";

const T0 = 1_750_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function assistant(startMs: number, endMs: number, provider: string, cost: number, toolCalls = 0, tokens: Record<string, number> = {}) {
	return {
		type: "message", timestamp: iso(endMs),
		message: {
			role: "assistant", provider, model: "m", timestamp: startMs,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, ...tokens, cost: { total: cost } },
			content: Array.from({ length: toolCalls }, () => ({ type: "toolCall" })),
		},
	};
}

test("collect counts prompts, tools, turns, airtime, and per-provider spend from the branch", () => {
	const branch = [
		{ type: "message", timestamp: iso(T0), message: { role: "user", content: "hi" } },
		assistant(T0 + 1000, T0 + 4000, "anthropic", 0.5, 2),
		{ type: "message", timestamp: iso(T0 + 4100), message: { role: "toolResult", toolName: "bash" } },
		assistant(T0 + 5000, T0 + 6000, "anthropic", 0.25, 0, { input: 40, output: 7, cacheRead: 100, cacheWrite: 20 }),
		{ type: "compaction", timestamp: iso(T0 + 7000) },
		{ type: "message", timestamp: iso(T0 + 8000), message: { role: "user", content: "again" } },
		assistant(T0 + 9000, T0 + 9500, "openai-codex", 0, 1),
	];
	const stats = collect({ getBranch: () => branch, getSessionDir: () => "/nowhere", costOf: (m) => m.usage.cost.total || 0.1 });
	assert.equal(stats.prompts, 2);
	assert.equal(stats.toolCalls, 3);
	assert.equal(stats.turns, 3);
	assert.equal(stats.lastApiEndMs, T0 + 9500);
	assert.equal(stats.lastContextResetMs, T0 + 7000);
	// A provider's input is everything sent to it: fresh input plus cache writes and reads.
	assert.deepEqual(stats.providers.get("anthropic"), { cost: 0.75, airtimeMs: 4000, inputTokens: 161, outputTokens: 8 });
	assert.deepEqual(stats.providers.get("openai-codex"), { cost: 0.1, airtimeMs: 500, inputTokens: 1, outputTokens: 1 });
	assert.deepEqual(stats.tokens, { input: 42, output: 9, cacheRead: 100, cacheWrite: 20 });
	assert.equal(stats.cacheHitPct, 0);
});

test("collect reads the steps each chained command ran from Tool Display's saved chains", () => {
	const step = { at: 1, ms: 5 };
	const branch = [
		assistant(T0, T0 + 1000, "anthropic", 0, 2),
		// A leading cd is a location, not a step.
		{ type: "custom", timestamp: iso(T0 + 2000), customType: CHAIN_ENTRY, data: { v: 1, toolCallId: "call-1", cd: true, steps: [step, step, step] } },
		// The third step never ran.
		{ type: "custom", timestamp: iso(T0 + 2000), customType: CHAIN_ENTRY, data: { v: 1, toolCallId: "call-2", steps: [step, step, {}] } },
		{ type: "custom", timestamp: iso(T0 + 2000), customType: CHAIN_ENTRY, data: { v: 2, toolCallId: "call-3", steps: [] } },
	];
	const stats = collect({ getBranch: () => branch, getSessionDir: () => "/nowhere", costOf: () => 0 });
	assert.equal(stats.toolCalls, 2);
	assert.deepEqual([...stats.chains], [["call-1", 2], ["call-2", 2]]);
});

test("a Zen billing marker moves a Go message's cost to the Zen category", () => {
	const branch = [
		{ type: "custom", customType: BILLING_SOURCE_ENTRY, timestamp: iso(T0), data: { provider: "opencode", messageTimestampMs: T0 + 1000 } },
		assistant(T0 + 1000, T0 + 2000, "opencode-go", 0.3),
		assistant(T0 + 3000, T0 + 4000, "opencode-go", 0.2),
	];
	const stats = collect({ getBranch: () => branch, getSessionDir: () => "/nowhere", costOf: (m) => m.usage.cost.total });
	assert.equal(stats.providers.get("opencode")?.cost, 0.3);
	assert.equal(stats.providers.get("opencode-go")?.cost, 0.2);
});

test("subagent spend folds in inline results and durable meta files, deduped by run id", () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "status-plus-session-"));
	const artifacts = join(sessionDir, "subagent-artifacts");
	mkdirSync(artifacts);
	const runA = "11111111-1111-1111-1111-111111111111";
	const runB = "22222222-2222-2222-2222-222222222222";
	writeFileSync(join(artifacts, `${runA}_worker_0_meta.json`), JSON.stringify({ model: "anthropic/claude", usage: { cost: 9 } }));
	writeFileSync(join(artifacts, `${runB}_worker_0_meta.json`), JSON.stringify({ model: "openai-codex/gpt", usage: { cost: 2 } }));
	const branch = [
		{ type: "message", timestamp: iso(T0), message: { role: "toolResult", toolName: "subagent", details: {
			results: [{ index: 0, agent: "worker", model: "anthropic/claude", usage: { cost: 1.5 },
				artifactPaths: { metadataPath: join(artifacts, `${runA}_worker_0_meta.json`) } }],
		} } },
		{ type: "custom_message", customType: "subagent-notify", timestamp: iso(T0 + 1), content: `run ${runB} finished` },
	];
	const stats = collect({ getBranch: () => branch, getSessionDir: () => sessionDir, costOf: () => 0 });
	// runA counted once (inline 1.5, its meta file is the same run); runB from disk.
	assert.equal(stats.providers.get("anthropic")?.cost, 1.5);
	assert.equal(stats.providers.get("openai-codex")?.cost, 2);
});

test("summaries and cache refreshes are charged to the model that ran them, without counting as turns", () => {
	const usage = (cost: number, tokens: Record<string, number> = {}) => ({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, ...tokens, cost: { total: cost } });
	const branch = [
		{ type: "model_change", timestamp: iso(T0), provider: "anthropic", modelId: "m" },
		assistant(T0 + 1000, T0 + 2000, "anthropic", 0.5),
		{ type: "model_change", timestamp: iso(T0 + 3000), provider: "openai-codex", modelId: "gpt" },
		// Pi summarizes with the session's current model and records no provider on these entries.
		{ type: "compaction", timestamp: iso(T0 + 4000), usage: usage(2) },
		{ type: "branch_summary", timestamp: iso(T0 + 5000), usage: usage(0) },
		{ type: "usage", kind: "cache_warm", provider: "anthropic", model: "m", timestamp: iso(T0 + 6000), usage: usage(0.25, { input: 1, output: 1, cacheRead: 900 }) },
	];
	const priced: string[] = [];
	const stats = collect({ getBranch: () => branch, getSessionDir: () => "/nowhere", costOf: (m) => {
		priced.push(`${m.provider}/${m.model}`);
		return m.usage.cost.total || 0.125;
	} });
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [0, 1, 0]);
	// A summary persisted without a price is estimated like any other zero-cost call.
	assert.ok(priced.includes("openai-codex/gpt"));
	assert.deepEqual(stats.providers.get("openai-codex"), { cost: 2.125, airtimeMs: 0, inputTokens: 200, outputTokens: 40 });
	assert.deepEqual(stats.providers.get("anthropic"), { cost: 0.75, airtimeMs: 1000, inputTokens: 902, outputTokens: 2 });
	assert.deepEqual(stats.tokens, { input: 202, output: 42, cacheRead: 900, cacheWrite: 0 });
	// Only replies say how warm the prompt cache was; a refresh does say when it was last kept warm.
	assert.equal(stats.cacheHitPct, 0);
	assert.equal(stats.lastContextResetMs, T0 + 5000);
	assert.equal(stats.lastApiEndMs, T0 + 6000);
});

test("replies that never ran leave tool counts, cache hit rate and cache warmth alone", () => {
	const ended = (start: number, end: number, stopReason: string, tools: number, tokens: Record<string, number>) => {
		const entry = assistant(start, end, "anthropic", 0, tools, tokens);
		return { ...entry, message: { ...entry.message, stopReason } };
	};
	const branch = [
		assistant(T0, T0 + 1000, "anthropic", 0.5, 1, { input: 10, cacheRead: 90 }),
		// Tools in an aborted or failed reply never run; a request refused before any prompt was read never touched the cache.
		ended(T0 + 2000, T0 + 3000, "aborted", 2, { input: 0, output: 0 }),
		ended(T0 + 4000, T0 + 5000, "error", 1, { input: 0, output: 0 }),
	];
	const source = (entries: unknown[]) => ({ getBranch: () => entries as any, getSessionDir: () => "/nowhere", costOf: () => 0 });
	let stats = collect(source(branch));
	assert.deepEqual([stats.turns, stats.toolCalls], [3, 1]);
	assert.equal(stats.cacheHitPct, 90);
	assert.equal(stats.lastApiEndMs, T0 + 5000);
	assert.equal(stats.lastCacheMs, T0 + 1000);
	// A stream that failed after the prompt was read did refresh the cache.
	stats = collect(source([...branch, ended(T0 + 6000, T0 + 7000, "error", 1, { input: 5, cacheRead: 95 })]));
	assert.deepEqual([stats.toolCalls, stats.cacheHitPct, stats.lastCacheMs], [1, 95, T0 + 7000]);
});

test("the newest cache write says whether the cache lives five minutes or an hour", () => {
	const source = (entries: unknown[]) => ({ getBranch: () => entries as any, getSessionDir: () => "/nowhere", costOf: () => 0 });
	const hour = assistant(T0, T0 + 1000, "anthropic", 0, 0, { cacheWrite: 500, cacheWrite1h: 500 });
	const readOnly = assistant(T0 + 2000, T0 + 3000, "anthropic", 0, 0, { cacheRead: 500 });
	const short = assistant(T0 + 4000, T0 + 5000, "anthropic", 0, 0, { cacheWrite: 50, cacheWrite1h: 0 });
	assert.equal(collect(source([readOnly])).cacheLongRetention, undefined);
	assert.equal(collect(source([hour, readOnly])).cacheLongRetention, true);
	assert.equal(collect(source([hour, readOnly, short])).cacheLongRetention, false);
});

test("cache lifetime evidence belongs to the provider that wrote it", () => {
	const source = (entries: unknown[]) => ({ getBranch: () => entries as any, getSessionDir: () => "/nowhere", costOf: () => 0 });
	const hour = assistant(T0, T0 + 1000, "anthropic", 0, 0, { cacheWrite: 500, cacheWrite1h: 500 });
	// OpenAI-style APIs report writes without the one-hour split: no evidence either way.
	const codexWrite = assistant(T0 + 2000, T0 + 3000, "openai-codex", 0, 0, { cacheWrite: 50 });
	const codexRead = assistant(T0 + 4000, T0 + 5000, "openai-codex", 0, 0, { cacheRead: 500 });
	assert.equal(collect(source([hour, codexRead])).cacheLongRetention, undefined);
	assert.equal(collect(source([hour, codexWrite])).cacheLongRetention, undefined);
	assert.equal(collect(source([codexWrite])).cacheLongRetention, undefined);
});
