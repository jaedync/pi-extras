import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimitStore } from "../lib/limit-store.ts";
import { parseProxyQuota } from "../lib/status-plus-logic.ts";
import { DEFAULT_GUARD_CONFIG, pendingWarnings, usageReport } from "../lib/usage-guard-core.ts";

const at = (time: string) => Date.parse(`2026-10-02T${time}Z`);
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true };
const MODEL = { provider: "anthropic", id: "claude-opus-5-5" };
function quota(utilization: number, reset = "09:10:00", status = "rejected", type = "five_hour") {
	return parseProxyQuota({ buckets: [{ type, utilization, resetsAt: at(reset), status }] });
}

test("the October 2 rollover cannot report a stale rejection or suggest another five-hour sleep", () => {
	const store = createLimitStore();
	store.set("anthropic", { entries: quota(0.99, "04:10:00"), atMs: at("03:51:45"), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].exhausted, true);
	store.set("anthropic", { entries: quota(0.03), atMs: at("04:11:43"), source: "poll" });
	const report = usageReport(store.entries(), MODEL, ON, undefined, at("04:11:43"));
	assert.equal(report.limits[0].usedPct, 3);
	assert.equal(report.limits[0].status, "ok");
	assert.equal(report.limits[0].reset?.resetsAt, "2026-10-02T09:10:00.000Z");
	assert.deepEqual(pendingWarnings(store.entries(), MODEL, ON, undefined, new Set(), at("04:11:43")), []);
	store.set("anthropic", { entries: quota(0.1), atMs: at("04:22:40"), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].exhausted, false, "repeated stale polls stay cleared");
	store.set("anthropic", { entries: quota(0.1, "09:10:00", "allowed"), atMs: at("04:23:00"), source: "poll" });
	store.set("anthropic", { entries: quota(0.1), atMs: at("04:24:00"), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].exhausted, true, "a new rejection has no newer proof");
});

test("a low rejection without newer evidence, reset drift, and near-full windows remain blocked", () => {
	const store = createLimitStore();
	store.set("anthropic", { entries: quota(0.03), atMs: at("04:11:43"), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].exhausted, true);
	store.set("anthropic", { entries: quota(0.03, "09:11:00"), atMs: at("04:12:00"), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].exhausted, true);
	const rollover = createLimitStore();
	rollover.set("anthropic", { entries: quota(0.99, "04:10:00"), atMs: at("03:51:45"), source: "poll" });
	rollover.set("anthropic", { entries: quota(0.95), atMs: at("04:11:43"), source: "poll" });
	assert.equal(rollover.get("anthropic")?.entries[0].exhausted, true);
});

test("a successful response clears a low proxy rejection, including later cached polls", () => {
	const store = createLimitStore();
	store.set("anthropic", { entries: quota(0.03), atMs: at("04:11:00"), source: "poll" });
	store.recordSuccess("anthropic", MODEL.id, at("04:11:43"));
	assert.equal(store.get("anthropic")?.entries[0].exhausted, false);
	store.set("anthropic", { entries: quota(0.1), atMs: at("04:22:40"), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].exhausted, false);
	store.set("anthropic", { entries: quota(0.98), atMs: at("05:00:00"), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].exhausted, true);
});

test("new rejection evidence respects model scope and cannot override a newer success", () => {
	const store = createLimitStore();
	store.set("anthropic", { entries: [...quota(0.03), ...quota(0.2, "09:10:00", "rejected", "seven_day_sonnet")], atMs: at("04:11:00"), source: "poll" });
	store.recordSuccess("anthropic", MODEL.id, at("04:11:43"));
	store.recordRejection("anthropic", MODEL.id, at("04:11:42"));
	assert.deepEqual(store.get("anthropic")?.entries.map((entry) => entry.exhausted), [false, true]);
	store.recordRejection("anthropic", "claude-sonnet-5", at("04:11:44"));
	assert.deepEqual(store.get("anthropic")?.entries.map((entry) => entry.exhausted), [true, true]);
});

test("success evidence respects model family, source, provider, and time", () => {
	const store = createLimitStore();
	store.set("anthropic", { entries: [...quota(0.03), ...quota(0.2, "09:10:00", "rejected", "seven_day_sonnet")], atMs: at("04:11:00"), source: "poll" });
	store.recordSuccess("anthropic", MODEL.id, at("04:10:59"));
	assert.ok(store.get("anthropic")?.entries.every((entry) => entry.exhausted));
	store.recordSuccess("openai-codex", "gpt-5", at("04:11:43"));
	assert.ok(store.get("anthropic")?.entries.every((entry) => entry.exhausted));
	store.recordSuccess("anthropic", MODEL.id, at("04:11:43"));
	assert.deepEqual(store.get("anthropic")?.entries.map((entry) => entry.exhausted), [false, true]);
	store.set("opencode-go", { entries: [{ label: "5h", usedPct: 3, exhausted: true }], atMs: at("04:11:00"), source: "poll" });
	store.recordSuccess("opencode-go", "model", at("04:11:43"));
	assert.equal(store.get("opencode-go")?.entries[0].exhausted, true, "Go may accept requests against paid balance");
});
