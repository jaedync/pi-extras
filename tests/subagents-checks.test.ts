/** `check`: the harness runs a command when a run ends normally, and the report carries what it found. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bashCheck, checkBlock, fixPrompt, reportWithCheck, tailOf } from "../lib/subagents/checks.ts";
import { reportText } from "../lib/subagents/format.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import type { CheckResult, CheckRun, MainDelivery } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const reports = (main: readonly MainDelivery[]) => main.filter((delivery): delivery is Extract<MainDelivery, { kind: "report" }> => delivery.kind === "report");

/** Check results the test hands out one by one, with the calls that asked for them. After `hold()`, the next check waits for `go()` or an abort. */
function scripted(...runs: CheckRun[]) {
	const asked: Array<{ name: string; command: string; timeoutMs: number; signal: AbortSignal }> = [];
	let gate: { promise: Promise<void>; open(): void } | undefined;
	return {
		asked,
		hold() { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); gate = { promise, open }; },
		go() { gate?.open(); },
		check: async (record: { name: string }, command: string, options: { timeoutMs: number; signal: AbortSignal }) => {
			asked.push({ name: record.name, command, timeoutMs: options.timeoutMs, signal: options.signal });
			const next = runs.shift() ?? { exitCode: 0, output: "ok" };
			const waiting = gate;
			if (waiting) await Promise.race([waiting.promise, new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }))]);
			if (gate === waiting) gate = undefined;
			return options.signal.aborted ? { exitCode: null, output: "Command aborted" } : next;
		},
	};
}

const settled = async () => { for (let i = 0; i < 6; i++) await tick(); };

/** The child calls these tools in the run under way, as an assistant message in its transcript. */
const calls = (h: ReturnType<typeof teamHarness>, name: string, ...tools: string[]) => {
	const parts = tools.map((tool, i) => ({ type: "toolCall", id: `${tool}-${i}`, name: tool, arguments: {} }));
	h.transcripts.set(name, [...(h.transcripts.get(name) ?? []), { role: "assistant", content: parts }]);
};

test("a check that passes runs once as part of the run, and the report carries its block", async () => {
	const script = scripted({ exitCode: 0, output: "# pass 12\n# fail 0" });
	const h = teamHarness({ check: script.check });
	const name = h.spawn("make the tests pass", { name: "impl", check: { command: "npm test", fixUntilPass: 0 } });
	await tick();
	script.hold();
	h.lastCall(name).finish("Done. Tests pass.");
	await settled();
	assert.equal(h.team.get(name)!.state, "running", "the check is part of the run");
	assert.equal(h.team.get(name)!.activity, "check: npm test");
	assert.equal(reports(h.main).length, 0, "nothing goes up while it runs");
	script.go();
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "idle");
	assert.deepEqual(script.asked.map((call) => [call.name, call.command, call.timeoutMs]), [["impl", "npm test", 600_000]]);
	assert.equal(done.checked?.exitCode, 0);
	assert.equal(done.runs, 1);
	const text = reportText(done, Date.now());
	assert.match(text, /Done\. Tests pass\.\n\nCheck run by the harness, not by the agent: passed \(exit 0\) in \d+s\.\nCommand: npm test\nLast lines of output:\n```\n# pass 12\n# fail 0\n```/);
	assert.equal(reports(h.main).length, 1);
	await h.team.close();
});

test("a failed check goes back to the child as the same run, and the parent hears only the last result", async () => {
	const script = scripted({ exitCode: 1, output: "FAIL test/a.test.ts\nexpected 2, got 3" }, { exitCode: 0, output: "all green" });
	const h = teamHarness({ check: script.check });
	const name = h.spawn("fix the bug", { name: "impl", check: { command: "npm test", fixUntilPass: 2, timeoutMinutes: 2 } });
	await tick();
	h.lastCall(name).finish("Fixed.");
	await settled();
	const fix = h.lastCall(name).text;
	assert.match(fix, /^The harness ran your check when your run ended, and it failed\./);
	assert.match(fix, /fix round 1 of 2/);
	assert.match(fix, /failed \(exit 1\)[\s\S]*expected 2, got 3/);
	assert.equal(h.team.get(name)!.runs, 1, "a fix round is the same run");
	assert.equal(reports(h.main).length, 0);
	calls(h, name, "edit");
	h.lastCall(name).finish("Fixed for real. Report: ...");
	const done = await h.team.whenDone(name);
	assert.equal(script.asked.length, 2);
	assert.equal(script.asked[0]!.timeoutMs, 120_000);
	assert.equal(done.checked?.attempt, 2);
	assert.equal(done.report, "Fixed for real. Report: ...");
	assert.match(reportText(done, Date.now()), /passed \(exit 0\) in \d+s, attempt 2 of 3\./);
	assert.equal(reports(h.main).length, 1, "one report, one wake");
	await h.team.close();
});

test("a check that keeps failing ends the run after its fix rounds with the last failure", async () => {
	const script = scripted({ exitCode: 1, output: "one" }, { exitCode: 2, output: "two" });
	const h = teamHarness({ check: script.check });
	const name = h.spawn("try", { name: "impl", check: { command: "make check", fixUntilPass: 1 } });
	await tick();
	h.lastCall(name).finish("First try.");
	await settled();
	calls(h, name, "edit");
	h.lastCall(name).finish("Second try.");
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "idle");
	assert.equal(script.asked.length, 2);
	assert.match(reportText(done, Date.now()), /failed \(exit 2\) in \d+s, attempt 2 of 2\.[\s\S]*two/);
	await h.team.close();
});

test("without fix rounds a failure goes straight into the report", async () => {
	const script = scripted({ exitCode: 1, output: "broken" });
	const h = teamHarness({ check: script.check });
	const name = h.spawn("try", { name: "impl", check: { command: "make check", fixUntilPass: 0 } });
	await tick();
	h.lastCall(name).finish("Claimed done.");
	const done = await h.team.whenDone(name);
	assert.equal(h.calls.get(name)!.length, 1);
	assert.match(reportText(done, Date.now()), /Claimed done\.\n\nCheck run by the harness, not by the agent: failed \(exit 1\)/);
	await h.team.close();
});

test("a stop during the check aborts it, and a failed run skips it", async () => {
	const script = scripted();
	const h = teamHarness({ check: script.check });
	const name = h.spawn("long", { name: "impl", check: { command: "sleep 100", fixUntilPass: 3 } });
	await tick();
	script.hold();
	h.lastCall(name).finish("Done.");
	await settled();
	assert.equal(script.asked.length, 1);
	const stopped = await h.team.stop(name, { by: "main" });
	assert.equal(script.asked[0]!.signal.aborted, true, "the command's process group goes with the stop");
	await settled();
	assert.equal(stopped?.state, "stopped");
	assert.equal(h.team.get(name)!.state, "stopped");
	assert.equal(h.calls.get(name)!.length, 1, "no fix round after a stop");
	const other = h.spawn("other", { name: "other", check: { command: "true", fixUntilPass: 0 } });
	await tick();
	h.lastCall(other).fail(new Error("model error"));
	assert.equal((await h.team.whenDone(other)).state, "failed");
	assert.equal(script.asked.length, 1, "a failed run is not checked");
	await h.team.close();
});

test("a run over its budget during the check is stopped and its check aborted", async () => {
	const script = scripted();
	const h = teamHarness({ check: script.check });
	const name = h.spawn("slow check", { name: "impl", maxMinutes: 0.001, check: { command: "sleep 100", fixUntilPass: 0 } });
	await tick();
	script.hold();
	h.lastCall(name).finish("Done.");
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "stopped");
	assert.match(done.stopReason ?? "", /budget/);
	assert.equal(script.asked[0]?.signal.aborted, true);
	await h.team.close();
});

test("a child waiting on its subagents is checked only when it would end idle", async () => {
	const script = scripted();
	const h = teamHarness({ check: script.check });
	const lead = h.spawn("lead", { name: "lead", check: { command: "npm test", fixUntilPass: 0 } });
	await tick();
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: lead, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await tick();
	h.lastCall(lead).finish("Started a helper.");
	await settled();
	assert.equal(h.team.get(lead)!.state, "waiting");
	assert.equal(script.asked.length, 0);
	h.lastCall("helper").finish("Helped.");
	await settled();
	h.lastCall(lead).finish("All done.");
	await h.team.whenDone(lead);
	assert.deepEqual(script.asked.map((call) => call.name), ["lead"]);
	await h.team.close();
});

test("fix rounds count across the whole run: one that waited on its subagents or on an answer goes on counting", async () => {
	const script = scripted({ exitCode: 1, output: "one" }, { exitCode: 1, output: "two" }, { exitCode: 1, output: "three" }, { exitCode: 1, output: "four" }, { exitCode: 1, output: "five" });
	const h = teamHarness({ check: script.check });
	const lead = h.spawn("lead", { name: "lead", check: { command: "npm test", fixUntilPass: 3 } });
	const peer = h.spawn("peer", { name: "peer" });
	await tick();
	h.lastCall(lead).finish("First try.");
	await settled();
	assert.match(h.lastCall(lead).text, /fix round 1 of 3/);
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: lead, model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await tick();
	h.lastCall(lead).finish("A helper fixes it.");
	await settled();
	assert.equal(h.team.get(lead)!.state, "waiting");
	h.lastCall("helper").finish("Fixed.");
	await settled();
	calls(h, lead, "edit");
	h.lastCall(lead).finish("Second try.");
	await settled();
	assert.match(h.lastCall(lead).text, /fix round 2 of 3/, "the wait on its subagent did not start the count again");
	assert.ok((await h.team.send(lead, peer, "Which flag?", { expectReply: true })).ok);
	h.lastCall(lead).finish("Waiting for peer.");
	await settled();
	assert.equal(h.team.get(lead)!.state, "waiting");
	assert.ok((await h.team.send(peer, lead, "Use --strict.")).ok);
	await settled();
	calls(h, lead, "edit");
	h.lastCall(lead).finish("Third try.");
	await settled();
	assert.match(h.lastCall(lead).text, /fix round 3 of 3/, "nor did the wait for an answer");
	calls(h, lead, "edit");
	h.lastCall(lead).finish("Last try.");
	const done = await h.team.whenDone(lead);
	assert.equal(script.asked.length, 4);
	assert.equal(done.checked?.attempt, 4);
	assert.match(reportText(done, Date.now()), /failed \(exit 1\) in \d+s, attempt 4 of 4\./);
	assert.ok((await h.team.send("main", lead, "Try once more.")).ok);
	await settled();
	calls(h, lead, "edit");
	h.lastCall(lead).finish("New run.");
	await settled();
	assert.match(h.lastCall(lead).text, /fix round 1 of 3/, "a new run starts its own count");
	await h.team.close();
});

test("a run that called no tool that can change files since the last check skips it, and its report says so", async () => {
	const script = scripted();
	const h = teamHarness({ check: script.check });
	const name = h.spawn("impl", { name: "impl", check: { command: "npm test", fixUntilPass: 0 } });
	await tick();
	const run = async (text: string, tools: string[], options: { check?: { command: string } } = {}) => {
		assert.ok((await h.team.send("main", name, text, options)).ok);
		await settled();
		if (tools.length > 0) calls(h, name, ...tools);
		h.lastCall(name).finish(`${text} done.`);
		return h.team.whenDone(name);
	};
	calls(h, name, "read", "edit");
	h.lastCall(name).finish("Implemented.");
	await h.team.whenDone(name);
	assert.equal(script.asked.length, 1, "the first run edited files");
	const answered = await run("Which file?", ["message"]);
	assert.equal(script.asked.length, 1, "an answer by message changes no files");
	assert.equal(answered.checkSkipped, answered.runs);
	assert.match(reportText(answered, Date.now()), /Which file\? done\.\n\nCheck skipped: no changes since the last check\.$/);
	assert.doesNotMatch(reportText(answered, Date.now()), /Check run by the harness/, "the last run's check is not this run's");
	await run("Look again.", ["read", "grep", "find", "ls", "stop_subagent"]);
	await run("Just say it.", []);
	assert.equal(script.asked.length, 1, "reading and writing text change nothing");
	await run("Run it.", ["bash"]);
	assert.equal(script.asked.length, 2, "bash can change files");
	const unknown = await run("Search.", ["web_search"]);
	assert.equal(script.asked.length, 3, "a tool it does not know counts as a change");
	assert.equal(unknown.checkSkipped, undefined);
	await run("Delegate.", ["subagent"]);
	assert.equal(script.asked.length, 4, "a subagent can change files for it");
	await run("Lint too.", ["message"], { check: { command: "npm run lint" } });
	assert.equal(script.asked.length, 5, "a new check command has not run yet");
	assert.equal(script.asked.at(-1)?.command, "npm run lint");
	await h.team.close();
});

test("a fix round that changed nothing ends with the failed check, and a run that changed files and then failed is checked next time", async () => {
	const script = scripted({ exitCode: 1, output: "broken" }, { exitCode: 0, output: "ok" });
	const h = teamHarness({ check: script.check });
	const name = h.spawn("impl", { name: "impl", check: { command: "npm test", fixUntilPass: 2 } });
	await tick();
	calls(h, name, "edit");
	h.lastCall(name).finish("Implemented.");
	await settled();
	assert.match(h.lastCall(name).text, /fix round 1 of 2/);
	h.lastCall(name).finish("I can't fix this.");
	const done = await h.team.whenDone(name);
	assert.equal(script.asked.length, 1, "nothing changed since the check failed");
	assert.equal(done.checked?.exitCode, 1);
	assert.match(reportText(done, Date.now()), /failed \(exit 1\) in \d+s, attempt 1 of 3\.[\s\S]*broken\n```\n\nCheck skipped: no changes since the last check\.$/);
	assert.ok((await h.team.send("main", name, "Try a different fix.")).ok);
	await settled();
	calls(h, name, "write");
	h.lastCall(name).fail(new Error("model error"));
	assert.equal((await h.team.whenDone(name)).state, "failed");
	assert.ok((await h.team.send("main", name, "What did you change?")).ok);
	await settled();
	calls(h, name, "message");
	h.lastCall(name).finish("I wrote a.ts.");
	await h.team.whenDone(name);
	assert.equal(script.asked.length, 2, "the failed run's write is not covered by any check yet");
	await h.team.close();
});

test("mail that arrives during the check is read first, then the check runs again", async () => {
	const script = scripted({ exitCode: 0, output: "first" }, { exitCode: 0, output: "second" });
	const h = teamHarness({ check: script.check });
	const name = h.spawn("impl", { name: "impl", check: { command: "npm test", fixUntilPass: 0 } });
	await tick();
	script.hold();
	h.lastCall(name).finish("Done.");
	await settled();
	h.late.set(name, ["Message from main:\nAlso update the README."]);
	script.go();
	await settled();
	assert.equal(h.lastCall(name).text, "Message from main:\nAlso update the README.");
	assert.equal(h.team.get(name)!.state, "running");
	calls(h, name, "edit");
	h.lastCall(name).finish("Done, README too.");
	const done = await h.team.whenDone(name);
	assert.equal(script.asked.length, 2, "the README change is checked too");
	assert.equal(done.report, "Done, README too.");
	assert.equal(reports(h.main).length, 1);
	await h.team.close();
});

test("a message's check replaces the stored one for the runs it starts; only main or an agent above may set it", async () => {
	const script = scripted();
	const h = teamHarness({ check: script.check, maxDepth: 2 });
	const lead = h.spawn("lead", { name: "lead" });
	const peer = h.spawn("peer", { name: "peer" });
	await tick();
	assert.ok(h.team.spawn({ name: "helper", task: "help", parent: lead, model: "m", readOnly: false, fork: false, blocking: false, check: { command: "make a", fixUntilPass: 2 } }).ok);
	await tick();
	h.lastCall("helper").finish("Helped.");
	await settled();
	const refused = await h.team.send(peer, "helper", "Check this too.", { check: { command: "rm -rf build" } });
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /Only main or an agent helper works for can set its check\./);
	assert.equal(h.team.get("helper")!.check?.command, "make a");
	assert.ok((await h.team.send(lead, "helper", "Now b.", { check: { command: "make b" } })).ok);
	assert.deepEqual(h.team.get("helper")!.check, { command: "make b", fixUntilPass: 2 }, "fixUntilPass stays when left out");
	await settled();
	h.lastCall("helper").finish("Did b.");
	await settled();
	assert.equal(script.asked.at(-1)?.command, "make b");
	assert.ok((await h.team.send("main", "peer", "Verify.", { check: { command: "true", fixUntilPass: 0, timeoutMinutes: 5 } })).ok);
	const readOnly = h.spawn("reader", { name: "reader", readOnly: true });
	const fix = await h.team.send("main", readOnly, "x", { check: { command: "npm test", fixUntilPass: 1 } });
	assert.match(fix.ok ? "" : fix.error, /read-only agent can't fix a failed check/);
	const bad = h.team.spawn({ task: "x", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, check: { command: " ", fixUntilPass: 0 } });
	assert.match(bad.ok ? "" : bad.error, /check must be a shell command/);
	const many = h.team.spawn({ task: "x", parent: "main", model: "m", readOnly: false, fork: false, blocking: false, check: { command: "true", fixUntilPass: 6 } });
	assert.match(many.ok ? "" : many.error, /fixUntilPass must be a whole number from 0 to 5/);
	await h.team.close();
});

test("the check runs through the agent's bash tool: exit codes, output, and a timeout that kills its process group", async () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-check-"));
	try {
		const bash = createBashToolDefinition(dir) as unknown as ToolDefinition;
		const signal = new AbortController().signal;
		const passed = await bashCheck(bash, "echo hello; pwd", { timeoutMs: 10_000, signal, id: "c1" });
		assert.equal(passed.exitCode, 0);
		assert.match(passed.output, /hello/);
		assert.ok(passed.output.includes(dir.split("/").at(-1)!), "it runs in the agent's directory");
		const failed = await bashCheck(bash, "echo broken >&2; exit 3", { timeoutMs: 10_000, signal, id: "c2" });
		assert.equal(failed.exitCode, 3);
		assert.match(failed.output, /broken/);
		assert.doesNotMatch(failed.output, /Command exited with code/, "the block says the exit code itself");
		const pidFile = join(dir, "pid");
		const started = Date.now();
		const timedOut = await bashCheck(bash, `sleep 30 & echo $! > ${pidFile}; wait`, { timeoutMs: 500, signal, id: "c3" });
		assert.equal(timedOut.exitCode, null);
		assert.equal(timedOut.timedOut, true);
		assert.ok(Date.now() - started < 10_000);
		const pid = Number(readFileSync(pidFile, "utf8"));
		await sleep(100);
		assert.throws(() => process.kill(pid, 0), "the background process went with its group");
		const stop = new AbortController();
		const aborted = bashCheck(bash, "sleep 30", { timeoutMs: 60_000, signal: stop.signal, id: "c4" });
		setTimeout(() => stop.abort(), 100);
		const result = await aborted;
		assert.equal(result.exitCode, null);
		assert.match(result.output, /aborted/);
		const input = await bashCheck(bash, "cat; echo end", { timeoutMs: 10_000, signal, id: "c5" });
		assert.equal(input.exitCode, 0, "no stdin: cat reads nothing and ends");
		writeFileSync(join(dir, "x"), "");
		assert.ok(existsSync(join(dir, "x")));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the block is bounded, fenced past any backticks, and shows the exact command", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	assert.equal(tailOf(lines, { lines: 40, chars: 4_000 }).split("\n").length, 40);
	assert.equal(tailOf("x".repeat(9_000), { lines: 40, chars: 4_000 }).length, 4_000);
	const result: CheckResult = { run: 1, command: "npm test -- --grep 'a b'", exitCode: 1, durationMs: 65_000, tail: "```\ncode\n```", attempt: 1, attempts: 1 };
	const block = checkBlock(result);
	assert.match(block, /^Check run by the harness, not by the agent: failed \(exit 1\) in 1m05s\.\nCommand: npm test -- --grep 'a b'\nLast lines of output:\n````\n```\ncode\n```\n````$/);
	assert.match(checkBlock({ ...result, command: "a\nb" }), /Command:\n```\na\nb\n```/);
	assert.match(checkBlock({ ...result, exitCode: null, timedOut: true }), /timed out after 1m05s/);
	assert.match(checkBlock({ ...result, exitCode: null, tail: "" }), /could not run\.[\s\S]*No output\./);
	assert.match(fixPrompt({ ...result, attempts: 3 }), /fix round 1 of 2/);
	assert.equal(reportWithCheck({ report: "r", runs: 2, checked: result }), "r", "a report shows only its own run's check");
	assert.match(reportWithCheck({ report: undefined, runs: 1, checked: result })!, /^Check run by the harness/);
});

test("check and its result are kept in the index", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-check-index-"));
	try {
		const record = { name: "impl", parent: "main", depth: 1, task: "t", model: "m", readOnly: false, fork: false, blocking: false, state: "idle" as const, createdAt: 1, activity: null, toolCalls: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, runs: 1, check: { command: "npm test", fixUntilPass: 2, timeoutMinutes: 5 },
			checked: { run: 1, command: "npm test", exitCode: 0, durationMs: 10, tail: "ok", attempt: 1, attempts: 3 } };
		new ChildIndex(dir, "parent", dir).save([record]);
		const [loaded] = new ChildIndex(dir, "parent", dir).load(() => undefined);
		assert.deepEqual(loaded?.check, record.check);
		assert.deepEqual(loaded?.checked, record.checked);
		writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, parentSession: "parent", cwd: dir, records: [{ ...record, check: { command: 5, fixUntilPass: 0 } }] }));
		assert.throws(() => new ChildIndex(dir, "parent", dir).load(() => undefined), /Invalid child index/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only an agent that can run bash itself may set a check, and a message's check is for one agent", async () => {
	const { childMessageTool, mainMessageTool, subagentTool } = await import("../lib/subagents/tools.ts");
	const h = teamHarness({ maxDepth: 2 });
	const luna = { ref: "openai-codex/gpt-6-luna", model: { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } };
	const tc = { team: h.team, allowed: [luna as never], fallbackModel: luna.ref, thinking: {}, modelTable: "", guide: "", replyTimeoutMs: 60_000, now: Date.now,
		childTools: (readOnly: boolean) => (readOnly ? ["read", "grep"] : ["read", "bash", "edit"]) };
	const run = (tool: { execute: unknown }, params: object) => (tool.execute as any)("id", params, undefined, undefined);
	const spawned = await run(subagentTool(tc, "main"), { task: "Fix it", name: "impl", check: "npm test", fixUntilPass: 2, checkTimeoutMinutes: 3 });
	assert.match(spawned.content[0].text, /Its report will end with the harness's check\./);
	assert.deepEqual(h.team.get("impl")?.check, { command: "npm test", fixUntilPass: 2, timeoutMinutes: 3 });
	await assert.rejects(run(subagentTool(tc, "main"), { task: "x", fixUntilPass: 1 }), /fixUntilPass and checkTimeoutMinutes go with check/);
	h.spawn("reader", { name: "reader", readOnly: true });
	h.spawn("no-shell", { name: "no-shell", tools: ["read", "edit"] });
	await tick();
	for (const self of ["reader", "no-shell"]) {
		await assert.rejects(run(subagentTool(tc, self), { task: "x", check: "make" }), /Only an agent that can run bash commands itself can set a check/);
		await assert.rejects(run(childMessageTool(tc, self), { to: "impl", text: "x", check: "make" }), /Only an agent that can run bash commands itself can set a check/);
	}
	const helper = await run(subagentTool(tc, "impl"), { task: "Help", name: "helper", check: "make lint" });
	assert.ok(helper);
	assert.deepEqual(h.team.get("helper")?.check, { command: "make lint", fixUntilPass: 0 });
	await run(childMessageTool(tc, "impl"), { to: "helper", text: "Also types.", check: "make types" });
	assert.equal(h.team.get("helper")?.check?.command, "make types");
	await assert.rejects(run(mainMessageTool(tc), { to: "all", text: "x", check: "make" }), /A check is for one agent/);
	await run(mainMessageTool(tc), { to: "reader", text: "Verify the build.", check: "npm run build" });
	assert.equal(h.team.get("reader")?.check?.command, "npm run build", "main may check a read-only agent's work");
	await h.team.close();
});

test("a run whose check did not pass is news: its report is never quiet, and a spawn after it hears so", async () => {
	const failing = async () => ({ exitCode: 1, output: "FAIL 3 tests" });
	const h = teamHarness({ check: failing, warn: () => undefined });
	h.spawn("impl", { name: "impl", check: { command: "npm test", fixUntilPass: 0 } });
	h.spawn("review", { name: "review", after: ["impl"] });
	h.spawn("rev", { name: "rev" });
	await tick();
	h.lastCall("impl").finish("Done, all tests pass.");
	await settled();
	assert.equal(reports(h.main).at(-1)?.record.name, "impl");
	assert.equal(reports(h.main).at(-1)?.quiet, undefined, "a spawn waits for it, but main still hears of the failed check");
	assert.match(h.lastCall("review").text, /- impl finished, but the harness's check failed \(exit 1\)\. /);
	assert.deepEqual(await h.team.send("rev", "impl", "Fix the null check in a.ts.", { expectReply: true }), { ok: true, delivered: "resumed" });
	await settled();
	calls(h, "impl", "edit");
	h.lastCall("impl").finish("Fixed.");
	await settled();
	assert.equal(reports(h.main).at(-1)?.quiet, undefined, "a peer started this run, but its check failed");
	assert.deepEqual(await h.team.send("main", "impl", "Which file?", { expectReply: true }), { ok: true, delivered: "resumed" });
	await settled();
	calls(h, "impl", "edit");
	calls(h, "impl", "message");
	await h.team.send("impl", "main", "a.ts");
	assert.equal(h.team.get("impl")!.answeredMain, true);
	h.lastCall("impl").finish("a.ts");
	await settled();
	assert.equal(reports(h.main).at(-1)?.record.answeredMain, undefined, "an answer can't stand in for a report whose check failed");
	await h.team.close();
});

test("mail that comes during a failing check goes with the fix prompt, so no fix round goes unseen", async () => {
	const script = scripted({ exitCode: 1, output: "broken" }, { exitCode: 0, output: "ok" });
	const h = teamHarness({ check: script.check });
	const name = h.spawn("impl", { name: "impl", check: { command: "npm test", fixUntilPass: 1 } });
	await tick();
	script.hold();
	h.lastCall(name).finish("Done.");
	await settled();
	h.late.set(name, ["Message from main:\nAlso update the README."]);
	script.go();
	await settled();
	const prompt = h.lastCall(name).text;
	assert.match(prompt, /^Message from main:\nAlso update the README\.\n\nThe harness ran your check when your run ended, and it failed\./);
	assert.match(prompt, /fix round 1 of 1/);
	calls(h, name, "edit");
	h.lastCall(name).finish("Fixed both.");
	const done = await h.team.whenDone(name);
	assert.equal(done.checked?.exitCode, 0);
	assert.equal(done.checked?.attempt, 2);
	await h.team.close();
});

test("a check that could not run gets no fix rounds: the child can't repair the harness", async () => {
	const h = teamHarness();
	const name = h.spawn("impl", { name: "impl", check: { command: "npm test", fixUntilPass: 2 } });
	await tick();
	h.lastCall(name).finish("Done.");
	const done = await h.team.whenDone(name);
	assert.equal(h.calls.get(name)!.length, 1);
	assert.match(reportText(done, Date.now()), /could not run, attempt 1 of 3\.[\s\S]*can't run checks/);
	await h.team.close();
});

test("only the trailing exit status leaves the output; a line of the command's own that looks like it stays", async () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-check-status-"));
	try {
		const bash = createBashToolDefinition(dir) as unknown as ToolDefinition;
		const run = await bashCheck(bash, "echo 'Command exited with code 7'; echo real-output; exit 2", { timeoutMs: 10_000, signal: new AbortController().signal, id: "s1" });
		assert.equal(run.exitCode, 2);
		assert.equal(run.output, "Command exited with code 7\nreal-output");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a check that timed out or could not run is news too, and the spawn after it hears which", async () => {
	for (const [run, said] of [[{ exitCode: null, output: "Command timed out after 600 seconds", timedOut: true }, "timed out"], [{ exitCode: null, output: "no shell" }, "could not run"]] as const) {
		const h = teamHarness({ check: async () => ({ ...run }), warn: () => undefined });
		h.spawn("impl", { name: "impl", check: { command: "npm test", fixUntilPass: 0 } });
		h.spawn("review", { name: "review", after: ["impl"] });
		await tick();
		h.lastCall("impl").finish("Done.");
		await settled();
		assert.equal(reports(h.main).at(-1)?.quiet, undefined, `a check that ${said} wakes main`);
		assert.ok(h.lastCall("review").text.includes(`- impl finished, but the harness's check ${said}. `), h.lastCall("review").text);
		await h.team.close();
	}
});
