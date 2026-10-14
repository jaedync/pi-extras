/** A run that changed files without a check says so in its report, so the parent does not take the child's word for it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { NOT_CHECKED_LINE, reportWithCheck } from "../lib/subagents/checks.ts";
import { subagentDescription } from "../lib/subagents/describe.ts";
import { reportText } from "../lib/subagents/format.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import type { MainDelivery } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const settled = async () => { for (let i = 0; i < 6; i++) await tick(); };
const reports = (main: readonly MainDelivery[]) => main.filter((delivery): delivery is Extract<MainDelivery, { kind: "report" }> => delivery.kind === "report");

test("the line names the gap and tells the parent what to do", () => {
	assert.equal(NOT_CHECKED_LINE, "Not checked: this run changed files and had no check command. Verify the work before you rely on it.");
});

test("an edit in a run without a check flags its report; the parent and the saved report both carry the line", async () => {
	const h = teamHarness();
	const name = h.spawn("change a.ts", { name: "impl" });
	await tick();
	assert.equal(h.team.claimEdit(name, "/repo/a.ts"), undefined);
	h.lastCall(name).finish("Done. It works.");
	const done = await h.team.whenDone(name);
	assert.equal(done.changedRun, 1);
	assert.match(reportText(done, Date.now()), /Done\. It works\.\n\nNot checked: this run changed files and had no check command\. Verify the work before you rely on it\.$/);
	assert.match(reportWithCheck(done)!, /^Done\. It works\.\n\nNot checked: /, "the saved report and the user's row show it too");
	assert.match(reportText(reports(h.main)[0]!.record, Date.now()), /Not checked: /, "the record main gets");
	await h.team.close();
});

test("a bash command that the harness saw change files counts as a change", async () => {
	const h = teamHarness();
	const name = h.spawn("format", { name: "fmt" });
	await tick();
	h.team.bashChanged(name, ["a.ts"], "/repo");
	h.lastCall(name).finish("Formatted.");
	const done = await h.team.whenDone(name);
	assert.match(reportText(done, Date.now()), new RegExp(`${NOT_CHECKED_LINE.replace(/[.]/g, "\\.")}$`));
	await h.team.close();
});

test("no flag for a run that changed nothing, a run with a check, or a later run that changed nothing", async () => {
	const h = teamHarness({ check: async () => ({ exitCode: 0, output: "ok" }) });
	const reader = h.spawn("read only", { name: "reader", readOnly: true });
	const idle = h.spawn("answer", { name: "idle" });
	const checked = h.spawn("change", { name: "checked", check: { command: "npm test", fixUntilPass: 0 } });
	await tick();
	h.hooks.get(idle)?.toolCalled?.("bash");
	assert.equal(h.team.claimEdit(checked, "/other/a.ts"), undefined);
	for (const name of [reader, idle, checked]) h.lastCall(name).finish("Done.");
	for (const name of [reader, idle, checked]) assert.doesNotMatch(reportText(await h.team.whenDone(name), Date.now()), /Not checked/, name);
	assert.ok((await h.team.send("main", idle, "Edit now.")).ok);
	await settled();
	assert.equal(h.team.claimEdit(idle, "/third/a.ts"), undefined);
	h.lastCall(idle).finish("Edited.");
	assert.match(reportText(await h.team.whenDone(idle), Date.now()), /Not checked/, "the run that edited");
	assert.ok((await h.team.send("main", idle, "What did you change?")).ok);
	await settled();
	h.lastCall(idle).finish("a.ts.");
	assert.doesNotMatch(reportText(await h.team.whenDone(idle), Date.now()), /Not checked/, "an answer that changed nothing");
	await h.team.close();
});

test("a run that did not end normally gets no flag: its report already says how it ended", async () => {
	const h = teamHarness();
	const name = h.spawn("change", { name: "impl" });
	await tick();
	assert.equal(h.team.claimEdit(name, "/repo/a.ts"), undefined);
	await h.team.stop(name);
	const done = await h.team.whenDone(name);
	assert.equal(done.state, "stopped");
	assert.doesNotMatch(reportText(done, Date.now()), /Not checked/);
	await h.team.close();
});

test("a refused edit is no change", async () => {
	const h = teamHarness();
	const holder = h.spawn("hold", { name: "holder" });
	const other = h.spawn("try", { name: "other" });
	await tick();
	assert.equal(h.team.claimEdit(holder, "/repo/a.ts"), undefined);
	assert.match(h.team.claimEdit(other, "/repo/b.ts") ?? "", /holder is editing/);
	h.lastCall(other).finish("Could not edit.");
	assert.doesNotMatch(reportText(await h.team.whenDone(other), Date.now()), /Not checked/);
	await h.team.close();
});

test("the run that changed files is kept in the index", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagents-unchecked-index-"));
	try {
		const record = { name: "impl", parent: "main", depth: 1, task: "t", model: "m", readOnly: false, fork: false, blocking: false, state: "idle" as const, createdAt: 1, activity: null, toolCalls: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, runs: 2, changedRun: 2 };
		new ChildIndex(dir, "parent", dir).save([record]);
		const [loaded] = new ChildIndex(dir, "parent", dir).load(() => undefined);
		assert.equal(loaded?.changedRun, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the subagent tool tells the model that work that changes code needs a check, and research does not", () => {
	for (const forChild of [false, true]) {
		const text = subagentDescription({ models: "", defaultModel: null, guide: "", forChild });
		assert.match(text, /A task that changes code needs check: the shell command that proves the work \(tests, typecheck or build\)\. With fixUntilPass a failure goes back to the child to fix\. Read-only and research tasks need no check\./);
	}
});
