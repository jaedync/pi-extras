import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpendLedger } from "../lib/usage-dollars/ledger.ts";

const NOW = Date.UTC(2026, 9, 10, 17);
const HOUR = 3_600_000;

interface Turn { provider?: string; model?: string; cost?: number; ts?: number; responseId?: string; costShape?: "number" }

function line(turn: Turn): string {
	const ts = turn.ts ?? NOW - HOUR;
	const cost = turn.costShape === "number" ? turn.cost ?? 0 : { total: turn.cost ?? 0 };
	return JSON.stringify({
		type: "message", id: "e1", parentId: null, timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant", content: [{ type: "text", text: "hi" }],
			provider: turn.provider ?? "anthropic", model: turn.model ?? "claude-opus-5-5",
			...(turn.responseId ? { responseId: turn.responseId } : {}),
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost }, timestamp: ts,
		},
	}) + "\n";
}

const user = JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "x", timestamp: NOW } }) + "\n";

function root(): string {
	return mkdtempSync(join(tmpdir(), "spend-ledger-"));
}

const ledgerAt = (dir: string) => createSpendLedger({ root: dir, maxAgeMs: 8 * 24 * HOUR, minRefreshMs: 0 });
const all = { sinceMs: 0, untilMs: NOW };

test("sums assistant spend by provider, including nested subagent sessions", async () => {
	const dir = root();
	mkdirSync(join(dir, "subagents", "parent"), { recursive: true });
	writeFileSync(join(dir, "a.jsonl"), user + line({ cost: 1.5, responseId: "msg_1" }) + line({ provider: "opencode-go", model: "glm-5.3", cost: 0.25 }));
	writeFileSync(join(dir, "subagents", "parent", "child.jsonl"), line({ cost: 2, responseId: "msg_2" }) + "not json\n");
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 3.5);
	assert.deepEqual(ledger.byProvider(0, NOW), { anthropic: 3.5, "opencode-go": 0.25 });
	assert.deepEqual(ledger.models("opencode-go", 0), ["glm-5.3"]);
});

test("a message copied into a fork counts once", async () => {
	const dir = root();
	const turn = line({ cost: 4, responseId: "msg_same" });
	writeFileSync(join(dir, "main.jsonl"), turn);
	writeFileSync(join(dir, "fork.jsonl"), turn + line({ cost: 1, responseId: "msg_new" }));
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 5);
});

test("time bounds, model families and a numeric cost field", async () => {
	const dir = root();
	writeFileSync(join(dir, "a.jsonl"),
		line({ cost: 1, ts: NOW - 10 * HOUR }) +
		line({ cost: 2, ts: NOW - HOUR, model: "claude-fable-5-1" }) +
		line({ cost: 3, ts: NOW - HOUR, costShape: "number" }));
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", sinceMs: NOW - 5 * HOUR, untilMs: NOW }), 5);
	assert.equal(ledger.sum({ provider: "anthropic", sinceMs: 0, untilMs: NOW, family: "fable" }), 2);
});

test("appended lines are read on the next refresh; a partial line waits for its newline", async () => {
	const dir = root();
	const file = join(dir, "a.jsonl");
	writeFileSync(file, line({ cost: 1 }));
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	const next = line({ cost: 2, responseId: "msg_next" });
	appendFileSync(file, next.slice(0, 40));
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 1);
	appendFileSync(file, next.slice(40));
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 3);
});

test("a file that shrank is read again from the start", async () => {
	const dir = root();
	const file = join(dir, "a.jsonl");
	writeFileSync(file, line({ cost: 1, responseId: "msg_a" }) + line({ cost: 2, responseId: "msg_b" }));
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	writeFileSync(file, line({ cost: 7 }));
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 7);
});

test("files untouched for longer than the window are skipped", async () => {
	const dir = root();
	const old = join(dir, "old.jsonl");
	writeFileSync(old, line({ cost: 9 }));
	const longAgo = (NOW - 30 * 24 * HOUR) / 1000;
	utimesSync(old, longAgo, longAgo);
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 0);
});

test("a missing root reads as no spend", async () => {
	const ledger = ledgerAt(join(root(), "absent"));
	await ledger.refresh(NOW);
	assert.deepEqual(ledger.byProvider(0, NOW), {});
});

test("refreshes closer together than the minimum reuse the last read", async () => {
	const dir = root();
	const file = join(dir, "a.jsonl");
	writeFileSync(file, line({ cost: 1 }));
	const ledger = createSpendLedger({ root: dir, maxAgeMs: 8 * 24 * HOUR, minRefreshMs: 60_000 });
	await ledger.refresh(NOW);
	appendFileSync(file, line({ cost: 2, responseId: "msg_later" }));
	await ledger.refresh(NOW + 1000);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 1);
	await ledger.refresh(NOW + 61_000);
	assert.equal(ledger.sum({ provider: "anthropic", sinceMs: 0, untilMs: NOW + 61_000 }), 3);
});

test("a file replaced by a larger one is read again from the start", async () => {
	const dir = root();
	const file = join(dir, "a.jsonl");
	writeFileSync(file, line({ cost: 1, responseId: "msg_old" }));
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	const next = join(dir, "next.tmp");
	writeFileSync(next, line({ cost: 5, responseId: "msg_n1" }) + line({ cost: 6, responseId: "msg_n2" }));
	renameSync(next, file);
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 11);
});

test("a chunk of many short lines is read without a stack overflow", async () => {
	const dir = root();
	writeFileSync(join(dir, "a.jsonl"), "{}\n".repeat(300_000) + line({ cost: 2, responseId: "msg_end" }));
	const ledger = ledgerAt(dir);
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", ...all }), 2);
});
