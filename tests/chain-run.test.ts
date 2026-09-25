import assert from "node:assert/strict";
import test from "node:test";
import { ChainRun, SAVED_TAIL_CHARS } from "../lib/chain/run.ts";
import { splitChain } from "../lib/chain/split.ts";

const chainOf = (command: string) => splitChain(command)!;

test("steps move from waiting to running to done as marks arrive", () => {
	const run = new ChainRun(chainOf("lint && test && build"), 1_000);
	assert.deepEqual([0, 1, 2].map((index) => run.stateOf(index)), ["waiting", "waiting", "waiting"]);
	run.mark({ kind: "start", step: 0 }, 1_000);
	run.write("lint ok\n");
	run.mark({ kind: "end", step: 0, code: 0 }, 2_400);
	run.mark({ kind: "start", step: 1 }, 2_400);
	run.write("test 1\n");
	assert.deepEqual([0, 1, 2].map((index) => run.stateOf(index)), ["ok", "running", "waiting"]);
	assert.equal(run.focus(), 1);
	assert.equal(run.stepMs(0, 9_999), 1_400);
	assert.equal(run.stepMs(1, 3_000), 600);
	assert.equal(run.steps[0]!.output, "lint ok\n");
	assert.equal(run.steps[1]!.output, "test 1\n");
});

test("a failure stops the chain: later steps read as skipped once it ends", () => {
	const run = new ChainRun(chainOf("lint && test && build"), 0);
	run.mark({ kind: "start", step: 0 }, 0);
	run.mark({ kind: "end", step: 0, code: 0 }, 10);
	run.mark({ kind: "start", step: 1 }, 10);
	run.mark({ kind: "end", step: 1, code: 1 }, 20);
	assert.equal(run.stateOf(2), "waiting");
	run.finish("fail", 20);
	assert.deepEqual([0, 1, 2].map((index) => run.stateOf(index)), ["ok", "fail", "skipped"]);
	assert.equal(run.focus(), 1);
	assert.equal(run.ran(), 2);
});

test("a failure caught by || is handled, not an error", () => {
	const run = new ChainRun(chainOf("grep -q X a.ts || echo none"), 0);
	run.mark({ kind: "start", step: 0 }, 0);
	run.mark({ kind: "end", step: 0, code: 1 }, 5);
	run.mark({ kind: "start", step: 1 }, 5);
	run.mark({ kind: "end", step: 1, code: 0 }, 6);
	run.finish("ok", 6);
	assert.deepEqual([0, 1].map((index) => run.stateOf(index)), ["handled", "ok"]);
	assert.equal(run.focus(), 1);
});

test("a timeout lands on the step that was running", () => {
	const run = new ChainRun(chainOf("npm ci && npm run e2e && npm run report"), 0);
	run.mark({ kind: "start", step: 0 }, 0);
	run.mark({ kind: "end", step: 0, code: 0 }, 3_500);
	run.mark({ kind: "start", step: 1 }, 3_500);
	run.finish("timeout", 10_000);
	assert.deepEqual([0, 1, 2].map((index) => run.stateOf(index)), ["ok", "timeout", "skipped"]);
	assert.equal(run.stepMs(1, 99_999), 6_500);
});

test("a leading cd isn't counted as a step that ran", () => {
	const run = new ChainRun(chainOf("cd src && make && make test"), 0);
	for (const step of [0, 1, 2]) {
		run.mark({ kind: "start", step }, step);
		run.mark({ kind: "end", step, code: 0 }, step + 1);
	}
	assert.equal(run.ran(), 2);
});

test("a saved run restores the same states, times and output tails", () => {
	const chain = chainOf("lint && test && build");
	const run = new ChainRun(chain, 5_000);
	run.mark({ kind: "start", step: 0 }, 5_000);
	run.write("x".repeat(SAVED_TAIL_CHARS * 2));
	run.mark({ kind: "end", step: 0, code: 0 }, 6_000);
	run.mark({ kind: "start", step: 1 }, 6_000);
	run.write("FAIL\n");
	run.mark({ kind: "end", step: 1, code: 2 }, 6_500);
	run.finish("fail", 6_500);
	const saved = JSON.parse(JSON.stringify(run.save("call-1")));
	assert.equal(saved.toolCallId, "call-1");
	assert.ok(saved.steps[0].tail.length <= SAVED_TAIL_CHARS);
	const restored = ChainRun.restore(chain, saved)!;
	assert.equal(restored.live, false);
	assert.deepEqual([0, 1, 2].map((index) => restored.stateOf(index)), ["ok", "fail", "skipped"]);
	assert.equal(restored.stepMs(1, 0), 500);
	assert.equal(restored.steps[1]!.output, "FAIL\n");
});

test("a saved run that doesn't match the command is ignored", () => {
	assert.equal(ChainRun.restore(chainOf("a && b"), { v: 1, toolCallId: "x", steps: [{}, {}, {}] }), undefined);
	assert.equal(ChainRun.restore(chainOf("a && b"), { v: 2, toolCallId: "x", steps: [{}, {}] }), undefined);
	assert.equal(ChainRun.restore(chainOf("a && b"), "junk"), undefined);
});
