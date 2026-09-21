import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../lib/status-plus-transcript.ts";

const T = 1_750_000_000_000;
const iso = (n: number) => new Date(n).toISOString();
const run = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";
function reply(id: string, provider = "anthropic", start = T, tools = 1) {
	return { type: "message", id, timestamp: iso(start + 1000), message: {
		role: "assistant", provider, model: "model", timestamp: start,
		content: Array.from({ length: tools }, (_, i) => ({ type: "toolCall", id: `${id}-${i}`, name: "read" })),
		usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: { total: 0.5 } },
	} };
}
const prompt = (id: string, timestamp = T) => ({ type: "message", id, timestamp: iso(timestamp), message: { role: "user", timestamp, content: id } });
const result = (details: unknown, toolName = "subagent", toolCallId = "call") => ({ type: "message", timestamp: iso(T), message: { role: "toolResult", toolName, toolCallId, details } });
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "status-plus-children-"));
	const parent = join(dir, "parent.jsonl");
	const artifacts = join(dir, "subagent-artifacts");
	mkdirSync(artifacts);
	const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
	const session = (rid: string, entries: unknown[], index = 0) => {
		const path = join(dir, "parent", rid, `run-${index}`, "session.jsonl");
		mkdirSync(join(dir, "parent", rid, `run-${index}`), { recursive: true });
		writeFileSync(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
		return path;
	};
	const meta = (rid: string, value: unknown, index = 0) => { const path = join(artifacts, `${rid}_worker_${index}_meta.json`); json(path, value); return path; };
	const stats = (branch: any[]) => collect({ getBranch: () => branch, getSessionDir: () => dir, getSessionFile: () => parent, costOf: m => m.usage.cost.total });
	return { dir, parent, artifacts, session, meta, json, stats };
}

test("combined parent and parallel children sum request spans, leaving parent cache state alone", () => {
	const f = fixture();
	f.session(run, [prompt("child"), reply("child-a", "openai", T + 2000, 2)]);
	f.session(other, [prompt("child2"), reply("child-b", "openai", T + 2000, 3)]);
	const stats = f.stats([prompt("parent"), reply("parent-a"), result({ workflowChildren: { children: [{ runId: run }, { runId: other }] } })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [3, 3, 6]);
	assert.deepEqual(stats.tokens, { input: 30, output: 6, cacheRead: 90, cacheWrite: 12 });
	assert.deepEqual(stats.providers.get("openai"), { cost: 1, airtimeMs: 2000, inputTokens: 88, outputTokens: 4 });
	assert.equal(stats.lastApiEndMs, T + 1000);
	assert.equal(stats.cacheHitPct, 30 / 44 * 100);
});

test("inline, status, notification and metadata refer to one child, not four", () => {
	const f = fixture();
	const sessionFile = f.session(run, [prompt("child"), reply("a")]);
	const metadataPath = f.meta(run, { model: "anthropic/model", usage: { turns: 1, input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: .5 }, toolCount: 1, sessionFile });
	const child = { index: 0, agent: "worker", sessionFile, artifactPaths: { metadataPath }, usage: { turns: 1, cost: .5 } };
	const stats = f.stats([result({ runId: run, results: [child] }), result({ runId: run, results: [child] }, "subagent_status"), { type: "custom_message", timestamp: iso(T), customType: "subagent-notify", content: `run ${run} finished` }]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.equal(stats.providers.get("anthropic")?.cost, .5);
});

test("metadata-only fallback includes available totals, never wall time or invented prompts", () => {
	const f = fixture();
	f.meta(run, { model: "openai/model", usage: { turns: 9, input: 12, output: 3, cacheRead: 4, cacheWrite: 5, cost: 2 }, toolCount: 7, durationMs: 999999 });
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [0, 9, 7]);
	assert.deepEqual(stats.tokens, { input: 12, output: 3, cacheRead: 4, cacheWrite: 5 });
	// A single-model summary attributes its token totals to that provider, like its cost.
	assert.deepEqual(stats.providers.get("openai"), { cost: 2, airtimeMs: 0, inputTokens: 21, outputTokens: 3 });
});

test("missing and partial metadata and growing sessions are retried", () => {
	const f = fixture();
	const branch = [result({ runId: run })];
	assert.equal(f.stats(branch).turns, 0);
	const file = f.meta(run, {});
	writeFileSync(file, '{"usage":');
	assert.equal(f.stats(branch).turns, 0);
	f.meta(run, { model: "anthropic/model", usage: { turns: 1, cost: .5 } });
	assert.equal(f.stats(branch).turns, 1);
	const path = f.session(run, [prompt("child"), reply("a")]);
	assert.equal(f.stats(branch).prompts, 1);
	appendFileSync(path, JSON.stringify(reply("b", "anthropic", T + 2000)) + "\n");
	assert.equal(f.stats(branch).turns, 2);
});

test("fork history, resumed sessions and nested cycles count each request once", () => {
	const f = fixture();
	const inherited = [prompt("parent"), reply("parent-a")];
	const nested = result({ runId: other });
	const child = [...inherited, prompt("child", T + 2000), reply("child-a", "openai", T + 2000), nested];
	f.session(run, child);
	f.session(run, [...child, reply("resume", "openai", T + 3000)], 1);
	f.session(other, [...child, prompt("nested", T + 4000), reply("nested-a", "openai", T + 4000), result({ runId: run })]);
	const stats = f.stats([...inherited, result({ workflowChildren: { children: [{ runId: run }, { runId: other }] } })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [3, 4, 4]);
	assert.equal(stats.providers.get("openai")?.cost, 1.5);
});

test("legacy results without index count messages and dedup tool result replay", () => {
	const f = fixture();
	const details = { results: [{ agent: "worker", step: 1, model: "anthropic/model", messages: [prompt("p").message, reply("a").message], usage: { turns: 1, cost: .5 } }] };
	const stats = f.stats([result(details), result(details)]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.deepEqual(stats.providers.get("anthropic"), { cost: .5, airtimeMs: 0, inputTokens: 44, outputTokens: 2 });
});

test("artifact initial_prompt is not an extra prompt; tool events do not duplicate assistant tools", () => {
	const f = fixture();
	const transcriptPath = join(f.artifacts, `${run}_worker_0_transcript.jsonl`);
	const a = reply("a");
	writeFileSync(transcriptPath, [
		{ recordType: "message", sourceEventType: "initial_prompt", message: { role: "user", content: "p" }, timestamp: iso(T) },
		{ recordType: "message", sourceEventType: "message_end", message: prompt("p").message, timestamp: iso(T) },
		{ recordType: "message", sourceEventType: "message_end", message: a.message, timestamp: a.timestamp },
		{ recordType: "tool_start", toolName: "read", toolCallId: "a-0" },
	].map(e => JSON.stringify(e)).join("\n"));
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.deepEqual(stats.providers.get("anthropic"), { cost: .5, airtimeMs: 1000, inputTokens: 44, outputTokens: 2 });
});

test("workflow JSON notifications discover structured runIds, not arbitrary output UUIDs", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/model", usage: { cost: 1, turns: 1 } });
	f.meta(other, { model: "anthropic/model", usage: { cost: 50, turns: 50 } });
	const stats = f.stats([{ type: "custom_message", timestamp: iso(T), customType: "subagent-notify", content: `Background task completed: **workflow**\nWorkflow completed with 1 child run(s). Return: ${JSON.stringify({ implementation: [{ runId: run, agent: "worker", output: `Unrelated ${other}` }] })}` }]);
	assert.equal(stats.turns, 1);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
	assert.equal(f.stats([prompt(other)]).turns, 0);
});

test("model-attempt fallback splits provider costs without adding attempts twice", () => {
	const f = fixture();
	f.meta(run, { model: "openai/model", usage: { cost: 3, turns: 5 }, modelAttempts: [
		{ model: "anthropic/model", usage: { cost: 1, turns: 2 } },
		{ model: "openai/model", usage: { cost: 2, turns: 3 } },
	] });
	const stats = f.stats([result({ runId: run })]);
	assert.equal(stats.turns, 5);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
	assert.equal(stats.providers.get("openai")?.cost, 2);
});

test("same run parallel indices retain every child's metadata", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 2 }, toolCount: 3 });
	f.meta(run, { model: "openai/m", usage: { cost: 2, turns: 4 }, toolCount: 5 }, 1);
	const stats = f.stats([result({ runId: run, results: [{ index: 0, agent: "worker", model: "anthropic/m", usage: { cost: 1 } }] })]);
	assert.deepEqual([stats.turns, stats.toolCalls], [6, 8]);
	assert.equal(stats.providers.get("openai")?.cost, 2);
});

test("resumed run aliases sharing a native file do not add their summaries again", () => {
	const f = fixture();
	const sessionFile = f.session(run, [prompt("p"), reply("a")]);
	const details = (runId: string) => ({ runId, results: [{ agent: "worker", index: 0, sessionFile, model: "anthropic/m", usage: { cost: .5, turns: 1 } }] });
	const stats = f.stats([result(details(run)), result(details(other), "subagent_wait", "wait")]);
	assert.deepEqual([stats.turns, stats.prompts, stats.toolCalls], [1, 1, 1]);
	assert.equal(stats.providers.get("anthropic")?.cost, .5);
});

test("linked async workflow inventory updates while the parent branch stays unchanged", () => {
	const f = fixture();
	const asyncDir = join(f.dir, "async-workflow");
	mkdirSync(asyncDir);
	const branch = [result({ runId: other, asyncDir, mode: "workflow", results: [] })];
	f.json(join(asyncDir, "status.json"), { workflowChildren: { children: [] } });
	assert.equal(f.stats(branch).turns, 0);
	f.session(run, [prompt("p"), reply("a")]);
	f.json(join(asyncDir, "status.json"), { workflowChildren: { children: [{ runId: run, agent: "worker" }] } });
	assert.equal(f.stats(branch).turns, 1);
	assert.equal(f.stats([]).turns, 0); // undo/switch must not retain cached totals
});

test("workflow return values can use arbitrary keys but not prose run references", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 1 } });
	f.meta(other, { model: "anthropic/m", usage: { cost: 99, turns: 99 } });
	const content = `Workflow completed. Return: ${JSON.stringify({ customLane: [{ runId: run, agent: "worker", output: `run ${other} finished` }] })}`;
	const stats = f.stats([{ type: "custom_message", customType: "subagent-notify", timestamp: iso(T), content }]);
	assert.equal(stats.turns, 1);
});

test("artifact supplements a partial native session without duplicating its messages", () => {
	const f = fixture();
	const a = reply("a");
	const b = reply("b", "openai", T + 2000);
	f.session(run, [prompt("p"), a]);
	const path = join(f.artifacts, `${run}_worker_0_transcript.jsonl`);
	writeFileSync(path, [prompt("p"), a, b].map(e => JSON.stringify({ recordType: "message", sourceEventType: "message_end", timestamp: e.timestamp, message: e.message })).join("\n"));
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 2, 2]);
	assert.equal(stats.providers.get("openai")?.airtimeMs, 1000);
});

test("child billing markers stay attributable and do not reset the parent's cache", () => {
	const f = fixture();
	f.session(run, [reply("a", "opencode-go", T + 2000), { type: "custom", customType: "status-plus-billing-source", timestamp: iso(T + 2000), data: { provider: "opencode", messageTimestampMs: T + 2000 } }, { type: "compaction", timestamp: iso(T + 4000) }]);
	const stats = f.stats([reply("parent"), result({ runId: run })]);
	assert.equal(stats.providers.get("opencode")?.cost, .5);
	assert.equal(stats.lastContextResetMs, undefined);
	assert.equal(stats.lastApiEndMs, T + 1000);
});

test("fork header excludes inherited history even when it is not on the current parent branch", () => {
	const f = fixture();
	f.session(run, [{ type: "session", id: "child", timestamp: iso(T + 2000), parentSession: f.parent }, prompt("old-parent"), reply("old-parent"), result({ runId: other }), prompt("child", T + 3000), reply("new", "openai", T + 3000)]);
	f.meta(other, { model: "anthropic/m", usage: { cost: 99, turns: 99 } });
	const stats = f.stats([result({ runId: run })]);
	assert.deepEqual([stats.prompts, stats.turns, stats.toolCalls], [1, 1, 1]);
	assert.equal(stats.providers.has("anthropic"), false);
});

test("missing earlier attempt is attributed to its provider, not the last model", () => {
	const f = fixture();
	f.session(run, [reply("final", "openai")]);
	f.meta(run, { model: "openai/m", usage: { cost: 1.5, turns: 2 }, modelAttempts: [
		{ model: "anthropic/m", usage: { cost: 1, turns: 1 } },
		{ model: "openai/m", usage: { cost: .5, turns: 1 } },
	] });
	const stats = f.stats([result({ runId: run })]);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
	assert.equal(stats.providers.get("openai")?.cost, .5);
});

test("current notification correlation lines discover children without harvesting output UUIDs", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 1 } });
	f.meta(other, { model: "anthropic/m", usage: { cost: 99, turns: 99 } });
	const stats = f.stats([{ type: "custom_message", customType: "subagent-notify", timestamp: iso(T), content: `Background task completed: **workflow**\n\nOutput references ${other}\n\nChild runs: custom=${run} (completed)` }]);
	assert.equal(stats.turns, 1);
});

test("nested legacy child messages are discovered without double counting tool-result usage", () => {
	const f = fixture();
	const nestedDetails = { runId: other, results: [{ agent: "worker", index: 0, model: "openai/m", usage: { cost: 2, turns: 2 } }] };
	const child = { agent: "worker", messages: [prompt("p").message, reply("a").message, { ...result(nestedDetails).message, usage: { cost: { total: 2 }, input: 500 } }], usage: { cost: .5, turns: 1 }, model: "anthropic/m" };
	const stats = f.stats([result({ results: [child] })]);
	assert.equal(stats.turns, 3);
	assert.equal(stats.providers.get("openai")?.cost, 2);
	assert.equal(stats.tokens.input, 10);
});

test("workflowKey results alias later child inventory rather than charging the workflow twice", () => {
	const f = fixture();
	f.meta(run, { model: "anthropic/m", usage: { cost: 1, turns: 2 }, toolCount: 3 });
	const stats = f.stats([
		result({ runId: other, results: [{ workflowKey: "lane", agent: "worker", index: 0, model: "anthropic/m", usage: { cost: 1, turns: 2 } }] }),
		result({ workflowChildren: { workflowRunId: other, children: [{ childId: "lane", runId: run, agent: "worker" }] } }, "subagent_status", "status"),
	]);
	assert.equal(stats.turns, 2);
	assert.equal(stats.toolCalls, 3);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
});

test("an incomplete assistant record cannot break the footer", () => {
	const f = fixture();
	f.session(run, [prompt("p"), { type: "message", timestamp: iso(T + 1000), message: { role: "assistant", timestamp: T, provider: "anthropic", model: "m" } }]);
	const stats = f.stats([result({ runId: run })]);
	assert.equal(stats.turns, 1);
	assert.equal(stats.providers.get("anthropic")?.cost, 0);
});

test("native user prompt suppresses an artifact-only initial_prompt marker", () => {
	const f = fixture();
	f.session(run, [prompt("p"), reply("a")]);
	const transcriptPath = join(f.artifacts, `${run}_worker_0_transcript.jsonl`);
	writeFileSync(transcriptPath, JSON.stringify({ recordType: "message", sourceEventType: "initial_prompt", timestamp: iso(T), message: { role: "user", content: "p" } }) + "\n");
	assert.equal(f.stats([result({ runId: run })]).prompts, 1);
});

test("detached inline snapshots cannot hide refreshed final metadata", () => {
	const f = fixture();
	const metadataPath = f.meta(run, { model: "anthropic/m", usage: { turns: 1, input: 10, cost: .5 }, toolCount: 1 });
	const branch = [result({ runId: run, results: [{ index: 0, agent: "worker", model: "anthropic/m", usage: { turns: 1, input: 10, cost: .5 }, artifactPaths: { metadataPath } }] })];
	assert.equal(f.stats(branch).turns, 1);
	f.meta(run, { model: "anthropic/m", usage: { turns: 9, input: 90, cost: 4.5 }, toolCount: 9 });
	const stats = f.stats(branch);
	assert.deepEqual([stats.turns, stats.toolCalls, stats.tokens.input], [9, 9, 90]);
	assert.equal(stats.providers.get("anthropic")?.cost, 4.5);
});

test("run aliases sharing only a metadata file count its usage once", () => {
	const f = fixture();
	const metadataPath = f.meta(run, { model: "anthropic/m", usage: { turns: 2, input: 20, cost: 1 }, toolCount: 3 });
	const child = { index: 0, agent: "worker", model: "anthropic/m", usage: { turns: 2, input: 20, cost: 1 }, toolCount: 3, artifactPaths: { metadataPath } };
	const stats = f.stats([result({ runId: run, results: [child] }), result({ runId: other, results: [child] }, "subagent_status", "status")]);
	assert.deepEqual([stats.turns, stats.toolCalls, stats.tokens.input], [2, 3, 20]);
	assert.equal(stats.providers.get("anthropic")?.cost, 1);
});

test("independent parallel prompts with identical text and timestamps are still distinct", () => {
	const f = fixture();
	const p = prompt("same-task");
	f.session(run, [{ ...p, id: "first-prompt" }, reply("a")]);
	f.session(other, [{ ...p, id: "second-prompt" }, reply("b")]);
	assert.equal(f.stats([result({ workflowChildren: { children: [{ runId: run }, { runId: other }] } })]).prompts, 2);
});
