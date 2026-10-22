import assert from "node:assert/strict";
import test from "node:test";
import { liveSleepProgress, loopShape, type LiveSleeps } from "../lib/sleep-progress.ts";

const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.001, `${actual} ≉ ${expected}`);

/** Sleeps seen at `starts` (ms), each `ms` long; the last one still runs when `running`. */
function seen(starts: number[], ms: number, running = true): LiveSleeps {
	const recent = starts.map((startedAt, index) => ({ index, startedAt, ms }));
	return { count: recent.length, first: recent.slice(0, 8), recent, ...(running && recent.length > 0 ? { running: recent.at(-1)! } : {}) };
}

test("a for loop's passes come from its list", () => {
	assert.deepEqual(loopShape("for i in 1 2 3; do sleep 10; done"), { kind: "for", passes: 3, before: 0, perPass: 1, passMs: 10_000 });
	assert.equal(loopShape("for i in {1..30}; do sleep 2; check && break; done")?.passes, 30);
	assert.equal(loopShape("for i in $(seq 1 30); do sleep 2; done")?.passes, 30);
	assert.equal(loopShape("for i in $(seq 5); do curl -s x; sleep 2; done")?.passes, 5);
	assert.equal(loopShape("for i in $(seq 0 5 20); do sleep 1; done")?.passes, 5);
	assert.equal(loopShape("for n in 14 15 16; do gh pr merge $n; sleep 3; done")?.passMs, undefined, "a pass that runs more than sleeps has no known length");
	assert.equal(loopShape("for f in *.txt; do sleep 1; done")?.passes, undefined, "a glob's size is unknown");
	assert.equal(loopShape("for ((i = 0; i < 5; i++)); do sleep 1; done")?.passes, undefined);
});

test("a while or until loop is a poll with no known end", () => {
	assert.deepEqual(loopShape("while kill -0 123 2>/dev/null; do sleep 30; done; echo gone"), { kind: "poll", before: 0, perPass: 1 });
	assert.deepEqual(loopShape("sleep 5; until test -e done.flag; do sleep 60; done"), { kind: "poll", before: 1, perPass: 1 });
});

test("commands it can't read as one loop give no shape", () => {
	for (const command of ["sleep 30", "npm test", "for i in 1 2; do for j in 1 2; do sleep 1; done; done", "for i in 1 2; do echo $i; done", "echo for x in a; do sleep 1; done"]) {
		assert.equal(loopShape(command), undefined, command);
	}
});

test("a lone sleep fills over its real length, even when its length is a variable", () => {
	const live = liveSleepProgress("s=$((t - now)); sleep $s; echo ready", seen([1_000], 40_000), 11_000)!;
	near(live.progress.share, 0.25);
	assert.deepEqual(live.progress.parts, ["30s left"]);
	assert.equal(live.endsAt, 41_000);
	assert.equal(liveSleepProgress("sleep $s", seen([1_000], 40_000, false), 11_000), undefined, "no sleep runs now");
});

test("a for loop of sleeps alone fills by time over all its passes, exactly", () => {
	const command = "for i in 1 2 3 4; do sleep 10; done";
	const live = liveSleepProgress(command, seen([0, 10_000], 10_000), 15_000)!;
	near(live.progress.share, 15 / 40);
	assert.deepEqual(live.progress.parts, ["2 of 4", "25s left"]);
	assert.equal(live.endsAt, 40_000);
});

test("a for loop with other work measures its passes and estimates the rest", () => {
	const command = "for i in $(seq 1 10); do curl -s x; sleep 2; done";
	const first = liveSleepProgress(command, seen([3_000], 2_000), 4_000)!;
	assert.deepEqual(first.progress.parts[0], "1 of 10");
	const third = liveSleepProgress(command, seen([3_000, 8_000, 13_000], 2_000), 14_000)!;
	// Passes take 5s; the third began at its sleep, 1s ago.
	near(third.progress.share, 2.2 / 10);
	assert.deepEqual(third.progress.parts, ["3 of 10", "~39s left"]);
	assert.ok(third.progress.share! < 1);
});

test("a poll loop fills for each sleep and counts its checks", () => {
	const command = "while kill -0 123; do sleep 30; done";
	const live = liveSleepProgress(command, seen([0, 31_000, 62_000], 30_000), 74_000)!;
	near(live.progress.share, 12 / 30);
	assert.deepEqual(live.progress.parts, ["check 3", "18s left"]);
	assert.equal(liveSleepProgress(command, seen([0, 31_000], 30_000, false), 61_500), undefined, "between sleeps, the check runs: no fill");
	assert.deepEqual(liveSleepProgress("for f in *.log; do gzip $f; sleep 5; done", seen([0, 6_000], 5_000), 7_000)!.progress.parts, ["pass 2", "4s left"]);
});

test("sleeps before the loop are not counted as passes", () => {
	const live = liveSleepProgress("sleep 5; while true; do sleep 10; done", seen([0, 5_000, 15_000], 10_000), 20_000)!;
	assert.deepEqual(live.progress.parts, ["check 2", "5s left"]);
});
