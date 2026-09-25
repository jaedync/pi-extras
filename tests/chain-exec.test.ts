import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { chainOperations, outcomeOfError, withChains, type ActiveRuns, type ShellOperations } from "../lib/chain/exec.ts";
import type { ChainRun } from "../lib/chain/run.ts";

/** A real shell behind the operations interface, as Pi's local backend runs it. */
const shell: ShellOperations = {
	exec: (command, cwd, options) => new Promise((resolve) => {
		const child = spawn("/bin/bash", ["-c", command], { cwd });
		child.stdout.on("data", options.onData);
		child.stderr.on("data", options.onData);
		child.on("close", (code) => resolve({ exitCode: code }));
	}),
};

function harness(enabled = true) {
	const active: ActiveRuns = new Map();
	let clock = 0;
	const events: string[] = [];
	const runs = new Map<string, ChainRun>();
	const ops = chainOperations(shell, active, () => ++clock);
	// Stands in for Pi's bash tool: runs through the operations, collects output, throws on failure.
	const bash = {
		name: "bash",
		async execute(_id: string, params: unknown) {
			const { command } = params as { command: string };
			let out = "";
			const { exitCode } = await ops.exec(command, "/", { onData: (data) => { out += data.toString(); } });
			if (exitCode !== 0) throw new Error(`${out}\n\nCommand exited with code ${exitCode}`);
			return { content: [{ type: "text", text: out }] };
		},
	};
	const wrapped = withChains(bash, "/bin/bash", active, {
		enabled: () => enabled,
		now: () => ++clock,
		nonce: () => "abcdef012345",
		started: (id, run) => { events.push(`start ${id}`); runs.set(id, run); },
		ended: (id) => { events.push(`end ${id}`); },
	});
	return { wrapped, events, runs, active };
}

test("a chain runs step by step and the output is exactly the original's", async () => {
	const h = harness();
	const result = await h.wrapped.execute("c1", { command: "echo one && echo two && printf three" }, undefined, undefined, undefined) as { content: Array<{ text: string }> };
	assert.equal(result.content[0]!.text, "one\ntwo\nthree");
	assert.deepEqual(h.events, ["start c1", "end c1"]);
	const run = h.runs.get("c1")!;
	assert.deepEqual([0, 1, 2].map((index) => run.stateOf(index)), ["ok", "ok", "ok"]);
	assert.deepEqual(run.steps.map((step) => step.output), ["one\n", "two\n", "three"]);
	assert.equal(run.outcome, "ok");
	assert.equal(h.active.size, 0);
});

test("a failing chain records the failed step and still throws Pi's error", async () => {
	const h = harness();
	await assert.rejects(h.wrapped.execute("c2", { command: "echo a && (exit 3) && echo never" }, undefined, undefined, undefined), /Command exited with code 3$/);
	const run = h.runs.get("c2")!;
	assert.deepEqual([0, 1, 2].map((index) => run.stateOf(index)), ["ok", "fail", "skipped"]);
	assert.equal(run.outcome, "fail");
});

test("single commands, unsplittable ones and a disabled setting run untouched", async () => {
	for (const command of ["echo solo", "cd /tmp && pwd", "for i in 1 2; do echo $i; done"]) {
		const h = harness();
		await h.wrapped.execute("c", { command }, undefined, undefined, undefined);
		assert.deepEqual(h.events, [], command);
	}
	const off = harness(false);
	await off.wrapped.execute("c", { command: "echo a && echo b" }, undefined, undefined, undefined);
	assert.deepEqual(off.events, []);
});

test("a shell that can't take the rewrite is left alone", async () => {
	const active: ActiveRuns = new Map();
	let started = 0;
	const bash = { execute: async () => ({ content: [] }) };
	const wrapped = withChains(bash, "/usr/bin/fish", active, { enabled: () => true, now: () => 0, nonce: () => "abcdef012345", started: () => { started++; }, ended: () => {} });
	await wrapped.execute("c", { command: "echo a && echo b" }, undefined, undefined, undefined);
	assert.equal(started, 0);
});

test("errors read as a timeout, an abort or a failure", () => {
	assert.equal(outcomeOfError(new Error("out\n\nCommand timed out after 10 seconds")), "timeout");
	assert.equal(outcomeOfError(new Error("Command aborted")), "aborted");
	assert.equal(outcomeOfError(new Error("x\n\nCommand exited with code 1")), "fail");
	assert.equal(outcomeOfError("weird"), "fail");
});
