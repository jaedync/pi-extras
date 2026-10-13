/**
 * A lead's Apply line is a tree written when the lead ended. When main stops
 * the lead and then resumes its helper, the helper's later edits need an
 * Apply line of their own: in the shared worktree, from the lead's tree; in a
 * worktree made from the lead's, into main's checkout. A live agent never
 * gets a line that applies outside its own worktree.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { reportText } from "../lib/subagents/format.ts";
import { Team } from "../lib/subagents/team.ts";
import type { AgentRecord, MainDelivery } from "../lib/subagents/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** A repository and a team whose agents end when the test says, recording what main and each agent got. */
function setUp(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-orphan-apply-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(realpathSync(dir), "repo");
	mkdirSync(root);
	git(root, "init", "-q"); git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@example.invalid");
	writeFileSync(join(root, "a.txt"), "a\n"); git(root, "add", "-A"); git(root, "commit", "-qm", "init");
	const main: MainDelivery[] = [];
	const received = new Map<string, string[]>();
	const got = (name: string, text: string) => received.set(name, [...(received.get(name) ?? []), text]);
	const finish = new Map<string, (text: string) => void>();
	const team = new Team({ maxConcurrent: 4, maxDepth: 3, replyTimeoutMs: 60_000, deliverToMain: (delivery) => main.push(delivery), warn: () => undefined,
		launcher: { async launch(record: AgentRecord) {
			const transcript: unknown[] = [];
			return { prompt: (text: string) => new Promise<void>((resolve) => {
				got(record.name, text);
				finish.set(record.name, (said) => { transcript.push({ role: "assistant", content: [{ type: "text", text: said }] }); resolve(); });
			}), steer: (text: string) => got(record.name, text), abort: async () => undefined, lastText: () => undefined, messages: () => transcript, takeQueued: () => [], dispose: async () => undefined };
		} } });
	t.after(() => team.close());
	const spawn = (name: string, parent: string, extra: object) => {
		const result = team.spawn({ name, task: name, parent, model: "m", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
	};
	const reportsToMain = () => main.flatMap((delivery) => delivery.kind === "report" ? [reportText(delivery.record, Date.now())] : []);
	return { root, team, spawn, finish, received, reportsToMain };
}

/** Main stops `lead` after it edits, resumes `helper`, which edits too; returns main's checkout and the report texts main got. */
async function stopLeadThenResumeHelper(t: TestContext, helperIsolation: "worktree" | undefined): Promise<{ root: string; texts: string[] }> {
	const { root, team, spawn, finish, reportsToMain } = setUp(t);
	spawn("lead", "main", { cwd: root, isolation: "worktree" }); await flush();
	spawn("helper", "lead", helperIsolation ? { isolation: helperIsolation } : {}); await flush();
	writeFileSync(join(team.get("lead")!.worktree!.path, "lead.txt"), "lead\n");
	await team.stop("lead"); await flush();
	const sent = await team.send("main", "helper", "Finish the job.");
	assert.ok(sent.ok, !sent.ok ? sent.error : "");
	await flush();
	writeFileSync(join(team.get("helper")!.worktree!.path, "helper.txt"), "helper\n");
	finish.get("helper")!("Wrote helper.txt."); await flush();
	return { root, texts: reportsToMain() };
}

const applyLine = (text: string): string | undefined => /\nApply: (.*)\n/.exec(text)?.[1];

function applyAll(texts: readonly string[]): void {
	for (const text of texts) {
		const apply = applyLine(text);
		if (apply) execFileSync("/bin/bash", ["-c", apply], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
	}
}

function assertBothApplied(root: string, texts: readonly string[]): void {
	assert.ok(existsSync(join(root, "lead.txt")), "the lead's own edit applies");
	assert.ok(existsSync(join(root, "helper.txt")), `the helper's later edit reaches main's checkout. Reports to main:\n${texts.join("\n----\n")}`);
}

test("a helper in its stopped lead's worktree reports an Apply line for what changed after the lead's tree", async (t) => {
	const { root, texts } = await stopLeadThenResumeHelper(t, undefined);
	applyAll(texts);
	assertBothApplied(root, texts);
});

test("a worktree made from a stopped lead's worktree applies into main's checkout, in the order main got the reports", async (t) => {
	const { root, texts } = await stopLeadThenResumeHelper(t, "worktree");
	applyAll(texts);
	assertBothApplied(root, texts);
});

test("a worktree made from a stopped lead's worktree applies into main's checkout, also when main applies it first", async (t) => {
	const { root, texts } = await stopLeadThenResumeHelper(t, "worktree");
	applyAll([...texts].reverse());
	assertBothApplied(root, texts);
});

test("a live lead gets an Apply line into its own worktree when the helper that made a nested worktree ended", async (t) => {
	const { root, team, spawn, finish, received } = setUp(t);
	spawn("lead", "main", { cwd: root, isolation: "worktree" }); await flush();
	spawn("helper", "lead", {}); await flush();
	spawn("nested", "helper", { isolation: "worktree" }); await flush();
	const lead = team.get("lead")!.worktree!.path;
	await team.stop("helper"); await flush();
	assert.equal(team.get("lead")!.state, "running");
	const sent = await team.send("main", "nested", "Finish the job.");
	assert.ok(sent.ok, !sent.ok ? sent.error : "");
	await flush();
	writeFileSync(join(team.get("nested")!.worktree!.path, "n.txt"), "n\n");
	finish.get("nested")!("Wrote n.txt."); await flush();
	const toLead = (received.get("lead") ?? []).join("\n");
	const apply = applyLine(toLead);
	assert.ok(apply, `the lead gets nested's Apply line:\n${toLead}`);
	execFileSync("/bin/bash", ["-c", apply], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
	assert.ok(existsSync(join(lead, "n.txt")), `applies into the lead's worktree: ${apply}`);
	assert.ok(!existsSync(join(root, "n.txt")), `never into main's checkout: ${apply}`);
});
