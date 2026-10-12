import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceReading, type WindowReading } from "../lib/usage-dollars/resets.ts";

const T = Date.UTC(2026, 9, 12, 2, 0);
const MIN = 60_000;
const RESET = Date.UTC(2026, 9, 15, 8, 0);

/** Feed readings in order, as the collector does across calls. */
function run(...readings: Array<[pct: number, atMs: number, resetMs?: number]>): WindowReading | undefined {
	let record: WindowReading | undefined;
	for (const [pct, atMs, resetMs = RESET] of readings) record = advanceReading(record, { pct, atMs, resetMs });
	return record;
}

test("a drop of 10 points with the same reset is a granted reset that starts at the first low reading", () => {
	const record = run([97, T], [0, T + 22 * MIN]);
	assert.deepEqual(record?.grant, { startMs: T + 22 * MIN, resetMs: RESET, beforePct: 97, confirmed: false });
	// Usage that climbs again from near zero confirms it, and later readings keep it.
	const later = run([97, T], [0, T + 22 * MIN], [1, T + 30 * MIN], [80, T + 2 * 86_400_000]);
	assert.deepEqual(later?.grant, { startMs: T + 22 * MIN, resetMs: RESET, beforePct: 97, confirmed: true });
	assert.equal(later?.pct, 80);
});

test("a small dip is not a granted reset", () => {
	assert.equal(run([40, T], [31, T + MIN])?.grant, undefined);
});

test("a new reset time is the next cycle, not a granted reset", () => {
	const record = run([73, T], [0, T + 5 * MIN, RESET + 7 * 86_400_000]);
	assert.equal(record?.grant, undefined);
});

test("a reset time that moves by less than the tolerance is the same cycle", () => {
	const record = run([60, T], [2, T + MIN, RESET + 30_000]);
	assert.equal(record?.grant?.startMs, T + MIN);
});

test("a reading after its window ended does not make a granted reset", () => {
	// The earlier reading's window had already ended when the low reading came.
	assert.equal(run([60, RESET - MIN], [0, RESET + MIN])?.grant, undefined);
});

test("one stale low reading is dropped when the next reading recovers", () => {
	const record = run([60, T], [40, T + MIN], [62, T + 2 * MIN]);
	assert.equal(record?.grant, undefined);
	assert.equal(record?.pct, 62);
});

test("an older reading than the last one changes nothing", () => {
	const before = run([60, T]);
	assert.deepEqual(advanceReading(before, { pct: 10, atMs: T - MIN, resetMs: RESET }), before);
	assert.deepEqual(advanceReading(before, { pct: 10, atMs: T, resetMs: RESET }), before);
});

test("a later granted reset in the same cycle replaces the earlier one, and the next cycle clears it", () => {
	const twice = run([50, T], [0, T + MIN], [5, T + 2 * MIN], [45, T + 3 * 3_600_000], [1, T + 4 * 3_600_000]);
	assert.equal(twice?.grant?.startMs, T + 4 * 3_600_000);
	const next = advanceReading(twice, { pct: 0, atMs: RESET + MIN, resetMs: RESET + 7 * 86_400_000 });
	assert.equal(next.grant, undefined);
});
