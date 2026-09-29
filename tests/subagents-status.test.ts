/** Status Plus counts a subagent's usage through the session file its spawn result names. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../lib/status-plus-transcript.ts";

const T = 1_750_000_000_000;
const iso = (n: number) => new Date(n).toISOString();
const reply = (id: string, start: number) => ({ type: "message", id, timestamp: iso(start + 1000), message: {
	role: "assistant", provider: "openai-codex", model: "gpt-6-luna", timestamp: start, content: [{ type: "text", text: id }],
	usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: { total: 0.25 } },
} });
const prompt = (id: string) => ({ type: "message", id, timestamp: iso(T), message: { role: "user", timestamp: T, content: id } });

test("a spawned child's usage counts from its session file, once, as it grows", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-status-"));
	const child = join(dir, "subagents", "2026_count-files_ab12cd34.jsonl");
	mkdirSync(join(dir, "subagents"), { recursive: true });
	writeFileSync(child, [prompt("task"), reply("c1", T + 2000)].map((e) => JSON.stringify(e)).join("\n") + "\n");
	const spawnResult = { type: "message", timestamp: iso(T), message: { role: "toolResult", toolName: "subagent", toolCallId: "call-1",
		details: { name: "count-files", model: "openai-codex/gpt-6-luna", sessionFile: child } } };
	const report = { type: "custom_message", customType: "subagent-report", timestamp: iso(T + 5000), content: "report",
		details: { id: "sa-1", kind: "report", reports: [{ name: "count-files", sessionFile: child }] } };
	const stats = (branch: unknown[]) => collect({ getBranch: () => branch as never, getSessionDir: () => dir, getSessionFile: () => join(dir, "parent.jsonl"), costOf: (m: any) => m.usage.cost.total });
	const parent = [prompt("parent"), reply("p1", T)];
	assert.equal(stats(parent).turns, 1);
	assert.equal(stats([...parent, spawnResult]).turns, 2);
	appendFileSync(child, JSON.stringify(reply("c2", T + 4000)) + "\n");
	const both = stats([...parent, spawnResult, report]);
	assert.equal(both.turns, 3);
	// Parent reply plus two child replies at $0.25 each.
	assert.equal(both.providers.get("openai-codex")?.cost, 0.75);
});
