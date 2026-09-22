import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimitStore, sharedLimitStore } from "../lib/limit-store.ts";

test("the shared store is one instance per process", () => {
	assert.equal(sharedLimitStore(), sharedLimitStore());
	const key = Symbol.for("pi-extras.limit-store");
	assert.equal((globalThis as unknown as Record<symbol, unknown>)[key], sharedLimitStore());
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
