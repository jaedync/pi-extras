import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimitStore, sharedLimitStore } from "../lib/limit-store.ts";
import { openaiLogin } from "./support/plan-login.ts";

test("the shared store is one instance per process", () => {
	assert.equal(sharedLimitStore(), sharedLimitStore());
	const key = Symbol.for("pi-extras.limit-store");
	assert.equal((globalThis as unknown as Record<symbol, unknown>)[key], sharedLimitStore());
});

test("reload upgrades an older shared store and keeps snapshots and hot flags", () => {
	const key = Symbol.for("pi-extras.limit-store");
	const host = globalThis as unknown as Record<symbol, unknown>;
	const saved = host[key];
	const old = createLimitStore();
	old.set("anthropic", { entries: [{ label: "5h", usedPct: 3 }], atMs: 1, source: "poll" });
	old.setHot("anthropic", true);
	const { recordSuccess, recordRejection, ...legacy } = old;
	host[key] = legacy;
	try {
		const upgraded = sharedLimitStore();
		assert.notEqual(upgraded, legacy);
		assert.equal(typeof upgraded.recordSuccess, "function");
		assert.equal(typeof upgraded.recordRejection, "function");
		assert.deepEqual(upgraded.get("anthropic"), old.get("anthropic"));
		assert.equal(upgraded.isHot("anthropic"), true);
		assert.equal(sharedLimitStore(), upgraded);
	} finally { host[key] = saved; }
});

test("set notifies subscribers and survives a throwing listener", () => {
	const store = createLimitStore();
	const seen: string[] = [];
	store.subscribe(() => { throw new Error("boom"); });
	const off = store.subscribe((provider) => seen.push(provider));
	store.set("anthropic", { entries: [{ label: "5h", usedPct: 1 }], atMs: 1, source: "poll" });
	assert.deepEqual(seen, ["anthropic"]);
	assert.deepEqual(store.entries().map(([provider]) => provider), ["anthropic"]);
	off();
	store.set("anthropic", { entries: [], atMs: 2, source: "headers" });
	assert.deepEqual(seen, ["anthropic"]);
	assert.equal(store.get("anthropic")?.atMs, 2);
});

test("refresh delegates to the installed refresher and reports its absence", async () => {
	const store = createLimitStore();
	assert.equal(await store.refresh("anthropic"), false);
	const calls: Array<[string, boolean]> = [];
	store.setRefresher(async (provider, force) => { calls.push([provider, force]); });
	assert.equal(await store.refresh("anthropic"), true);
	assert.equal(await store.refresh("openai-codex", false), true);
	assert.deepEqual(calls, [["anthropic", true], ["openai-codex", false]]);
	store.setRefresher(undefined);
	assert.equal(await store.refresh("anthropic"), false);
});

test("hot flags are per provider", () => {
	const store = createLimitStore();
	store.setHot("anthropic", true);
	assert.equal(store.isHot("anthropic"), true);
	assert.equal(store.isHot("openai-codex"), false);
	store.setHot("anthropic", false);
	assert.equal(store.isHot("anthropic"), false);
});

test("the store keys every reading by provider family", async (t) => {
	openaiLogin(t);
	const store = createLimitStore();
	const heard: string[] = [];
	store.subscribe((provider) => heard.push(provider));
	store.set("claude-code", { entries: [{ label: "", kind: "budget", remainingText: "$369/$3000" }], atMs: 1, source: "poll" });
	assert.equal(store.get("anthropic")?.atMs, 1);
	assert.equal(store.get("claude-code"), store.get("anthropic"));
	assert.deepEqual(store.entries().map(([provider]) => provider), ["anthropic"]);
	assert.deepEqual(heard, ["anthropic"]);
	store.setHot("openai", true);
	assert.equal(store.isHot("openai-codex"), true);
	const calls: string[] = [];
	store.setRefresher(async (provider) => { calls.push(provider); });
	// The poller owner decides which ids may start their family's poll (lib/status-plus-limits.ts limitFamily).
	await store.refresh("claude-code");
	assert.deepEqual(calls, ["claude-code"]);
});

test("reload moves an older store's per-id readings to their family, the newest first", (t) => {
	openaiLogin(t);
	const key = Symbol.for("pi-extras.limit-store");
	const host = globalThis as unknown as Record<symbol, unknown>;
	const saved = host[key];
	// 0.34.7 kept one snapshot per literal provider id.
	const rows = new Map([
		["openai", { entries: [{ label: "5h", usedPct: 10 }], atMs: 5, source: "poll" as const }],
		["openai-codex", { entries: [{ label: "5h", usedPct: 7 }], atMs: 3, source: "poll" as const }],
		["claude-code", { entries: [{ label: "7d", usedPct: 2 }], atMs: 4, source: "poll" as const }],
	]);
	const legacy = {
		get: (provider: string) => rows.get(provider),
		entries: () => [...rows.entries()],
		set() {}, recordSuccess() {}, recordRejection() {}, subscribe: () => () => {}, setRefresher() {},
		refresh: async () => false, setHot() {}, isHot: (provider: string) => provider === "claude-code",
	};
	host[key] = legacy;
	try {
		const upgraded = sharedLimitStore();
		assert.notEqual(upgraded, legacy as unknown);
		assert.deepEqual(upgraded.entries().map(([provider]) => provider).sort(), ["anthropic", "openai-codex"]);
		assert.equal(upgraded.get("openai")?.atMs, 5);
		assert.equal(upgraded.get("anthropic")?.entries[0]?.usedPct, 2);
		assert.equal(upgraded.isHot("anthropic"), true);
		assert.equal(sharedLimitStore(), upgraded);
	} finally { host[key] = saved; }
});
