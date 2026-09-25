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
