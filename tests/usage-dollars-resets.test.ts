import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DROPS, advanceReading, evidenceOf, mergeReadings, type WindowReading } from "../lib/usage-dollars/resets.ts";

const T = Date.UTC(2026, 9, 12, 2, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const RESET = Date.UTC(2026, 9, 15, 8, 0);

/** Feed readings in order, as the poll hook does. */
function run(...readings: Array<[pct: number, atMs: number, resetMs?: number]>): WindowReading | undefined {
	let record: WindowReading | undefined;
	for (const [pct, atMs, resetMs = RESET] of readings) record = advanceReading(record, { pct, atMs, resetMs });
	return record;
}

const grantOf = (record: WindowReading | undefined) => (record ? evidenceOf(record)?.grant : undefined);

test("a drop of 10 points with the same reset is pending until the next reading confirms it", () => {
	const pending = run([97, T], [0, T + 5 * MIN]);
	assert.equal(grantOf(pending), undefined);
	assert.equal(pending?.pending?.startMs, T + 5 * MIN);
	// Usage that climbs again from near zero confirms it, and later readings keep it.
	const later = run([97, T], [0, T + 5 * MIN], [1, T + 10 * MIN], [80, T + 48 * HOUR]);
	assert.deepEqual(grantOf(later), { startMs: T + 5 * MIN, resetMs: RESET, beforePct: 97, lastHighMs: T, approximate: false });
	assert.equal(later?.pct, 80);
});

test("a small dip is not a granted reset, but it is a drop", () => {
	const record = run([40, T], [31, T + MIN], [32, T + 2 * MIN]);
	assert.equal(grantOf(record), undefined);
	assert.deepEqual(evidenceOf(record!)?.drops, [{ fromMs: T, atMs: T + MIN }]);
});

test("a wipe to zero is a granted reset at any level", () => {
	assert.equal(grantOf(run([9, T], [0, T + MIN], [1, T + 2 * MIN]))?.startMs, T + MIN);
});

test("a new reset time is the next cycle, not a granted reset", () => {
	const record = run([73, T], [0, T + 5 * MIN, RESET + 7 * 86_400_000], [1, T + 10 * MIN, RESET + 7 * 86_400_000]);
	assert.equal(grantOf(record), undefined);
	assert.equal(record?.drops, undefined);
});

test("a reset time that moves by less than the tolerance is the same cycle", () => {
	assert.equal(grantOf(run([60, T], [2, T + MIN, RESET + 30_000], [3, T + 2 * MIN]))?.startMs, T + MIN);
});

test("a reading after its window ended does not make a granted reset", () => {
	assert.equal(run([60, RESET - MIN], [0, RESET + MIN])?.pending, undefined);
});

test("one stale low reading is dropped when the next reading recovers", () => {
	const record = run([60, T], [40, T + MIN], [62, T + 2 * MIN]);
	assert.equal(grantOf(record), undefined);
	assert.equal(record?.pending, undefined);
	assert.equal(record?.pct, 62);
});

test("a cancelled stale reading keeps the earlier confirmed grant", () => {
	const record = run([50, T], [0, T + MIN], [1, T + 2 * MIN], [60, T + 10 * HOUR], [40, T + 10 * HOUR + MIN], [62, T + 10 * HOUR + 2 * MIN]);
	assert.equal(grantOf(record)?.startMs, T + MIN);
});

test("a fall after a long gap in the readings is an approximate granted reset", () => {
	const record = run([97, T], [0, T + 8 * HOUR], [2, T + 8 * HOUR + 5 * MIN]);
	assert.deepEqual(grantOf(record), { startMs: T + 8 * HOUR, resetMs: RESET, beforePct: 97, lastHighMs: T, approximate: true });
});

test("an older reading than the last one changes nothing", () => {
	const before = run([60, T]);
	assert.equal(advanceReading(before, { pct: 10, atMs: T - MIN, resetMs: RESET }), before);
	assert.equal(advanceReading(before, { pct: 10, atMs: T, resetMs: RESET }), before);
});

test("a later confirmed reset in the same cycle replaces the earlier one, and the next cycle clears it", () => {
	const twice = run([50, T], [0, T + MIN], [5, T + 2 * MIN], [45, T + 3 * HOUR], [1, T + 4 * HOUR], [2, T + 4 * HOUR + MIN]);
	assert.equal(grantOf(twice)?.startMs, T + 4 * HOUR);
	const next = advanceReading(twice, { pct: 0, atMs: RESET + MIN, resetMs: RESET + 7 * 86_400_000 });
	assert.equal(evidenceOf(next), undefined);
});

test("merging with the stored file keeps the newer record per key", () => {
	const older = run([10, T])!;
	const newer = run([12, T + MIN])!;
	const other = run([5, T])!;
	const merged = mergeReadings({ a: newer, c: other }, { a: older, b: older }, ["a", "b"]);
	assert.deepEqual(merged, { a: newer, b: older, c: other });
	assert.deepEqual(mergeReadings({ a: older }, { a: newer }, ["a"]), { a: newer });
});

test("a later small dip does not hide the fall at a granted reset", () => {
	// A family bucket fell only 9 -> 7 at an account-wide grant, then dipped by a point later.
	const record = run([9, T], [7, T + 5 * MIN], [12, T + 3 * HOUR], [11, T + 3 * HOUR + 5 * MIN]);
	assert.deepEqual(evidenceOf(record!)?.drops, [
		{ fromMs: T, atMs: T + 5 * MIN },
		{ fromMs: T + 3 * HOUR, atMs: T + 3 * HOUR + 5 * MIN },
	]);
});

test("the drops of a cycle are bounded, and the newest are kept", () => {
	const readings: Array<[number, number]> = [];
	// Every odd reading is a one-point dip: MAX_DROPS + 3 dips in all.
	const last = 2 * MAX_DROPS + 5;
	for (let i = 0; i <= last; i++) readings.push([i % 2 === 0 ? 20 : 19, T + i * MIN]);
	const drops = evidenceOf(run(...readings)!)?.drops ?? [];
	assert.equal(drops.length, MAX_DROPS);
	assert.equal(drops.at(-1)?.atMs, T + last * MIN);
});
