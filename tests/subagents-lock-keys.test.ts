import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Team } from "../lib/subagents/team.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";
import { WorkTrees } from "../lib/subagents/work-trees.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });

function repository(t: TestContext): { dir: string; root: string } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-lock-keys-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "repo");
	mkdirSync(root);
	git(root, "init", "-q");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.invalid");
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "initial");
	git(root, "worktree", "add", "-q", "-b", "one", join(dir, "one"));
	git(root, "worktree", "add", "-q", "-b", "two", join(dir, "two"));
	mkdirSync(join(dir, "plain"));
	return { dir, root };
}

const record = (name: string): AgentRecord => ({ name, parent: "main", depth: 1, task: "Edit", model: "test/model", readOnly: false, fork: false,
	blocking: false, state: "running", activity: null, runs: 1, createdAt: 1, toolCalls: 0, usage: NO_USAGE });

function team(cwd: string) {
	const created = new Team({ maxConcurrent: 4, maxDepth: 4, replyTimeoutMs: 100, cwd, deliverToMain() {}, launcher: { async launch() { throw new Error("not launched"); } } });
	created.restore(["a", "b", "c"].map(record));
	return created;
}

test("the work tree of a path is git's top level, for missing files and directories too", (t) => {
	const { dir, root } = repository(t);
	const trees = new WorkTrees();
	assert.equal(trees.topOf(join(root, "tracked.txt")), root);
	assert.equal(trees.topOf(join(root, "new", "deep", "file.txt")), root);
	assert.equal(trees.topOf(join(dir, "one", "file.txt")), join(dir, "one"));
	assert.equal(trees.topOf(join(dir, "plain", "file.txt")), undefined);
});

test("the top level is looked up once per directory", (t) => {
	const { root } = repository(t);
	let lookups = 0;
	const trees = new WorkTrees((dir) => { lookups++; return dir; });
	trees.topOf(join(root, "a.txt"));
	trees.topOf(join(root, "b.txt"));
	assert.equal(lookups, 1);
	trees.topOf(join(root, "sub", "c.txt"));
	assert.equal(lookups, 1, "a missing directory is looked up at its nearest existing ancestor");
});

test("children that edit different worktrees of one repository don't block each other", async (t) => {
	const { dir, root } = repository(t);
	const crew = team(root);
	assert.equal(crew.claimEdit("a", join(dir, "one", "file.txt")), undefined);
	assert.equal(crew.claimEdit("b", join(dir, "two", "file.txt")), undefined);
	assert.equal(crew.claimEdit("c", join(root, "file.txt")), undefined);
	await crew.close();
});

test("children that edit the same checkout still block each other", async (t) => {
	const { dir } = repository(t);
	const crew = team(dir);
	assert.equal(crew.claimEdit("a", join(dir, "one", "file.txt")), undefined);
	assert.match(crew.claimEdit("b", join(dir, "one", "sub", "other.txt")) ?? "", /^a is editing files in the checkout \S+\/one until its run ends/);
	await crew.close();
});

test("a target outside any repository falls back to the child's spawn workspace", async (t) => {
	const { dir, root } = repository(t);
	const crew = team(root);
	assert.equal(crew.claimEdit("a", join(dir, "plain", "notes.txt")), undefined);
	assert.match(crew.claimEdit("b", join(dir, "plain", "other.txt")) ?? "", /^a is editing files/);
	assert.match(crew.claimEdit("b") ?? "", /^a is editing files/, "the same key as a claim without a target");
	assert.equal(crew.claimEdit("b", join(root, "file.txt")), undefined, "the repository is a different workspace");
	await crew.close();
});

test("a bash change takes the lock of the work tree it was found in", async (t) => {
	const { dir, root } = repository(t);
	const crew = team(root);
	assert.equal(crew.bashChanged("a", ["file.txt"], join(dir, "one")), undefined);
	assert.equal(crew.mayEdit("a", join(dir, "one")), true);
	assert.equal(crew.mayEdit("a", root), false);
	assert.match(crew.claimEdit("b", join(dir, "one", "x.txt")) ?? "", /^a is editing/);
	assert.equal(crew.claimEdit("b", join(root, "x.txt")), undefined);
	await crew.close();
});
