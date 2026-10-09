import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextPollMs, readShared, writeShared, type SharedPoll } from "../lib/limit-share.ts";

const dir = () => join(mkdtempSync(join(tmpdir(), "limit-share-")), "status-plus-limits");
const budget = { label: "", kind: "budget" as const, remainingText: "$1106.83/$2000.00", resetMs: 1_790_000_000_000, resetApprox: true };

test("a poll one Pi process saved is what the next one reads, and only its user can read it", () => {
	const at = dir();
	const poll: SharedPoll = { atMs: 1000, entries: [{ label: "5h", usedPct: 12 }, budget], triedAtMs: 1000, failures: 0 };
	writeShared(at, "anthropic", poll);
	assert.deepEqual(readShared(at, "anthropic"), poll);
	assert.equal(statSync(join(at, "anthropic.json")).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(at), ["anthropic.json"]);
});

test("a missing, broken or wrongly shaped file reads as no shared poll", () => {
	const at = dir();
	assert.equal(readShared(at, "anthropic"), undefined);
	writeShared(at, "anthropic", { triedAtMs: 1, failures: 0 });
	const file = join(at, "anthropic.json");
	for (const text of ["{not json", JSON.stringify({ triedAtMs: "soon", failures: 0 }), JSON.stringify({ triedAtMs: 1, failures: 0, entries: [{ usedPct: 3 }] })]) {
		writeFileSync(file, text);
		assert.equal(readShared(at, "anthropic"), undefined);
	}
});

test("a provider id cannot name a file outside the directory", () => {
	const at = dir();
	writeShared(at, "../escape/x", { triedAtMs: 1, failures: 0 });
	assert.deepEqual(readdirSync(at), [".._escape_x.json"]);
});

test("the next poll waits one gap after any process tried, and for a wait the provider asked for", () => {
	assert.equal(nextPollMs(0, undefined, 300_000), 300_000);
	assert.equal(nextPollMs(1_000, { triedAtMs: 5_000, failures: 1 }, 300_000), 305_000);
	assert.equal(nextPollMs(9_000, { triedAtMs: 5_000, failures: 1 }, 300_000), 309_000);
	assert.equal(nextPollMs(0, { triedAtMs: 5_000, failures: 1, retryAtMs: 900_000 }, 300_000), 900_000);
});
