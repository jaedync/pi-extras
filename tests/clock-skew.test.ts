import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextPollMs, readShared, writeShared } from "../lib/limit-share.ts";
import { createLimitStore } from "../lib/limit-store.ts";
import { advanceReading, mergeReadings } from "../lib/usage-dollars/resets.ts";

const NOW = Date.now();
const DAY = 86_400_000;
const MIN = 60_000;

test("a shared poll stamped more than 5 minutes ahead is clock skew and is ignored", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "clock-skew-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeShared(dir, "anthropic", { atMs: NOW + DAY, entries: [], triedAtMs: NOW + DAY, failures: 0 });
	assert.equal(readShared(dir, "anthropic", NOW), undefined);
	assert.ok(nextPollMs(0, readShared(dir, "anthropic", NOW), MIN) <= NOW + MIN);
	// A few minutes ahead is normal drift between processes, and a Retry-After is meant to be ahead.
	writeShared(dir, "anthropic", { atMs: NOW + 4 * MIN, entries: [], triedAtMs: NOW + 4 * MIN, failures: 1, retryAtMs: NOW + 50 * MIN });
	assert.equal(readShared(dir, "anthropic", NOW)?.retryAtMs, NOW + 50 * MIN);
	writeShared(dir, "anthropic", { triedAtMs: NOW, failures: 1, retryAtMs: NOW + DAY });
	assert.equal(readShared(dir, "anthropic", NOW), undefined);
});

test("a stored snapshot from a clock that ran ahead does not block newer ones", () => {
	const store = createLimitStore();
	store.set("anthropic", { entries: [{ label: "5h", usedPct: 1 }], atMs: Date.now() + DAY, source: "poll" });
	store.set("anthropic", { entries: [{ label: "5h", usedPct: 2 }], atMs: Date.now(), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].usedPct, 2);
	// Within the drift allowance, the newer snapshot still wins as before.
	store.set("anthropic", { entries: [{ label: "5h", usedPct: 3 }], atMs: Date.now() + 4 * MIN, source: "poll" });
	store.set("anthropic", { entries: [{ label: "5h", usedPct: 4 }], atMs: Date.now(), source: "poll" });
	assert.equal(store.get("anthropic")?.entries[0].usedPct, 3);
});

test("a window reading from a clock that ran ahead does not freeze reset detection", () => {
	const prev = advanceReading(undefined, { pct: 40, resetMs: NOW + 3 * 3_600_000, atMs: NOW + DAY });
	const cur = advanceReading(prev, { pct: 2, resetMs: NOW + 3 * 3_600_000, atMs: NOW });
	assert.notStrictEqual(cur, prev);
	assert.equal(cur.atMs, NOW);
	const merged = mergeReadings({ k: prev }, { k: cur }, ["k"]);
	assert.equal(merged.k.atMs, NOW);
});
