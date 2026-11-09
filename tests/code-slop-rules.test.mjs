import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCounts, countFindings, nextBaseline, worstFiles } from "../skills/code-slop-rules/scripts/lib/counts.mjs";

const finding = (ruleId, file) => ({ ruleId, file });

test("countFindings: counts each rule and file, and lists rules with no sites at zero", () => {
	const counts = countFindings([finding("a", "x.ts"), finding("a", "x.ts"), finding("a", "y.ts"), finding("b", "y.ts")], ["a", "b", "c"]);
	assert.deepEqual(counts, {
		a: { count: 3, files: { "x.ts": 2, "y.ts": 1 } },
		b: { count: 1, files: { "y.ts": 1 } },
		c: { count: 0, files: {} },
	});
});

test("countFindings: sorts rules and files so the baseline file diffs cleanly", () => {
	const counts = countFindings([finding("b", "z.ts"), finding("b", "a.ts"), finding("a", "m.ts")], ["b", "a"]);
	assert.deepEqual(Object.keys(counts), ["a", "b"]);
	assert.deepEqual(Object.keys(counts.b.files), ["a.ts", "z.ts"]);
});

test("countFindings: a finding of a rule that the config does not list is still counted", () => {
	assert.equal(countFindings([finding("x", "a.ts")], []).x.count, 1);
});

test("compareCounts: a rule above its baseline fails and names the files that rose", () => {
	const baseline = { a: { count: 2, files: { "x.ts": 2 } } };
	const current = { a: { count: 3, files: { "x.ts": 1, "y.ts": 2 } } };
	const result = compareCounts(baseline, current);
	assert.equal(result.ok, false);
	assert.deepEqual(result.rose, [{ rule: "a", before: 2, now: 3, files: [{ file: "y.ts", before: 0, now: 2 }] }]);
});

test("compareCounts: equal or lower counts pass, and lower counts are listed to lock in", () => {
	const baseline = { a: { count: 2, files: { "x.ts": 2 } }, b: { count: 1, files: { "y.ts": 1 } } };
	const current = { a: { count: 1, files: { "x.ts": 1 } }, b: { count: 1, files: { "y.ts": 1 } } };
	const result = compareCounts(baseline, current);
	assert.equal(result.ok, true);
	assert.deepEqual(result.fell, [{ rule: "a", before: 2, now: 1 }]);
	assert.deepEqual(result.rose, []);
});

test("compareCounts: a rule with no baseline fails, so a new rule cannot start without a recorded count", () => {
	const result = compareCounts({}, { a: { count: 0, files: {} } });
	assert.equal(result.ok, false);
	assert.deepEqual(result.unrecorded, ["a"]);
});

test("compareCounts: a baseline rule that the config no longer has is stale, not a failure", () => {
	const result = compareCounts({ gone: { count: 4, files: {} } }, {});
	assert.equal(result.ok, true);
	assert.deepEqual(result.stale, ["gone"]);
});

test("nextBaseline: lowers counts and records new rules", () => {
	const baseline = { a: { count: 2, files: { "x.ts": 2 } } };
	const current = { a: { count: 1, files: { "x.ts": 1 } }, b: { count: 5, files: { "y.ts": 5 } } };
	assert.deepEqual(nextBaseline(baseline, current, { allowIncrease: false }), { ok: true, baseline: current, refused: [] });
});

test("nextBaseline: refuses a higher count unless the increase is allowed", () => {
	const baseline = { a: { count: 1, files: { "x.ts": 1 } } };
	const current = { a: { count: 2, files: { "x.ts": 2 } } };
	assert.deepEqual(nextBaseline(baseline, current, { allowIncrease: false }), { ok: false, baseline, refused: ["a"] });
	assert.deepEqual(nextBaseline(baseline, current, { allowIncrease: true }), { ok: true, baseline: current, refused: [] });
});

test("nextBaseline: drops stale rules", () => {
	assert.deepEqual(nextBaseline({ gone: { count: 1, files: {} } }, {}, { allowIncrease: false }).baseline, {});
});

test("worstFiles: sums every rule per file and keeps the largest first", () => {
	const counts = { a: { count: 3, files: { "x.ts": 1, "y.ts": 2 } }, b: { count: 2, files: { "x.ts": 2 } } };
	assert.deepEqual(worstFiles(counts, 2), [{ file: "x.ts", count: 3, rules: { a: 1, b: 2 } }, { file: "y.ts", count: 2, rules: { a: 2 } }]);
});

// Ratchet state over a series of edits: no order of adds, fixes and updates may let the total pass above the
// lowest count that an update recorded.
test("property: after any series of edits and updates, a passing check never exceeds the last recorded count", () => {
	let seed = 7;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
	for (let run = 0; run < 200; run++) {
		let sites = Math.floor(random() * 5);
		let baseline = { a: { count: sites, files: { "f.ts": sites } } };
		for (let step = 0; step < 30; step++) {
			const action = random();
			if (action < 0.4) sites += 1;
			else if (action < 0.8) sites = Math.max(0, sites - 1);
			const current = { a: { count: sites, files: sites ? { "f.ts": sites } : {} } };
			if (action >= 0.8) {
				const next = nextBaseline(baseline, current, { allowIncrease: false });
				assert.equal(next.ok, sites <= baseline.a.count);
				baseline = next.baseline;
			}
			const result = compareCounts(baseline, current);
			assert.equal(result.ok, sites <= baseline.a.count, `run ${run} step ${step}`);
		}
	}
});
