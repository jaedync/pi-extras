import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createWorktree, worktreeFooter } from "../lib/subagents/worktree.ts";
import { Team } from "../lib/subagents/team.ts";
import { reportText } from "../lib/subagents/format.ts";
import { saveReport } from "../lib/subagents/reports.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });

function repository(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-worktree-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "repo with spaces");
	mkdirSync(root);
	git(root, "init", "-q");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.invalid");
	writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "initial");
	return root;
}

test("worktrees snapshot staged, unstaged and untracked files without changing the source index", (t) => {
	const root = repository(t);
	writeFileSync(join(root, "tracked.txt"), "staged\n");
	git(root, "add", "tracked.txt");
	writeFileSync(join(root, "tracked.txt"), "unstaged\n");
	writeFileSync(join(root, "untracked.txt"), "new\n");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "package.js"), "dependency\n");
	writeFileSync(join(root, "ignored.txt"), "ignored\n");
	mkdirSync(join(root, "nested"));
	const status = git(root, "status", "--porcelain=v1");
	const index = readFileSync(join(root, ".git", "index"));
	const head = git(root, "rev-parse", "HEAD");
	const worktree = createWorktree(join(root, "nested"), "scout");
	assert.equal(readFileSync(join(worktree.path, "tracked.txt"), "utf8"), "unstaged\n");
	assert.equal(readFileSync(join(worktree.path, "untracked.txt"), "utf8"), "new\n");
	assert.equal(existsSync(join(worktree.path, "ignored.txt")), false);
	assert.ok(lstatSync(join(worktree.path, "node_modules")).isSymbolicLink());
	assert.equal(realpathSync(join(worktree.path, "node_modules")), realpathSync(join(root, "node_modules")));
	assert.equal(git(root, "status", "--porcelain=v1"), status);
	assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
	assert.equal(git(root, "rev-parse", "HEAD"), head);
	assert.equal(git(worktree.path, "ls-tree", "--name-only", worktree.base, "--", "node_modules"), "");
	assert.match(worktreeFooter(worktree), /0 files differ from base/);
	assert.equal(git(worktree.path, "diff", "--cached", "--name-only"), "");
	git(worktree.path, "add", "-A");
	assert.match(worktreeFooter(worktree), /0 files differ from base/);
	assert.equal(git(worktree.path, "diff", "--binary", "--cached", worktree.base, "--", ".", ":(exclude)node_modules"), "");
	assert.equal(git(worktree.path, "rev-parse", "HEAD").trim(), worktree.base);
	assert.equal(git(worktree.path, "branch", "--show-current").trim(), "subagent/scout");
});

test("existing paths and branches get numeric suffixes without overwriting", (t) => {
	const root = repository(t);
	mkdirSync(join(`${root}.worktrees`, "scout"), { recursive: true });
	git(root, "branch", "subagent/scout-2");
	const worktree = createWorktree(root, "scout");
	assert.equal(worktree.branch, "subagent/scout-3");
	assert.equal(worktree.path, join(`${realpathSync(root)}.worktrees`, "scout-3"));
	assert.equal(createWorktree(root, "scout").branch, "subagent/scout-4");
});

test("worktree setup refuses non-repositories, unborn HEAD and invalid names", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-no-git-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.throws(() => createWorktree(dir, "scout"), /git repository/i);
	git(dir, "init", "-q");
	assert.throws(() => createWorktree(dir, "scout"), /commit|HEAD/i);
	assert.throws(() => createWorktree(dir, "../unsafe"), /name/i);
});

test("reports count files and child commits and give quoted apply and cleanup commands", (t) => {
	const root = repository(t);
	writeFileSync(join(root, "tracked.txt"), "main uncommitted\n");
	const worktree = createWorktree(root, "scout");
	writeFileSync(join(worktree.path, "tracked.txt"), "child edit\n");
	git(worktree.path, "add", "-A");
	git(worktree.path, "commit", "-qm", "child change");
	writeFileSync(join(worktree.path, "new file.txt"), "new\n");
	const footer = worktreeFooter(worktree);
	assert.match(footer, /2 files.*1 commit/);
	assert.ok(footer.includes(`git -C '${worktree.path}' add -A -- . ':(exclude)node_modules' && git -C '${worktree.path}' diff --binary --cached ${worktree.base} -- . ':(exclude)node_modules' | git -C '${realpathSync(root)}' apply`));
	assert.ok(footer.includes(`git worktree remove --force '${worktree.path}'`));
	assert.ok(footer.includes("git branch -D subagent/scout"));
	assert.ok(existsSync(worktree.path));
	const baseContent = git(worktree.path, "show", `${worktree.base}:tracked.txt`);
	assert.equal(baseContent, "main uncommitted\n");
	execFileSync("git", ["-C", root, "apply"], { input: git(worktree.path, "diff", "--binary", "--cached", worktree.base), timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
	assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "child edit\n");
	assert.equal(readFileSync(join(root, "new file.txt"), "utf8"), "new\n");
	assert.match(worktreeFooter({ ...worktree, path: join(root, "missing") }), /Worktree report unavailable:/);
});

test("report metadata is captured when the child ends, not when a later reader displays it", (t) => {
	const root = repository(t);
	const worktree = createWorktree(root, "scout");
	writeFileSync(join(worktree.path, "tracked.txt"), "first run\n");
	const record: AgentRecord = { name: "scout", parent: "main", depth: 1, task: "Write", model: "test/model", readOnly: false,
		fork: false, blocking: false, state: "idle", activity: null, createdAt: 1, runs: 1, toolCalls: 0, usage: NO_USAGE, worktree };
	const completed = saveReport(record);
	writeFileSync(join(worktree.path, "later.txt"), "next run\n");
	const report = reportText(completed, 2);
	assert.match(report, /1 file differs from base, 0 commits/);
	assert.equal(git(worktree.path, "diff", "--cached", "--name-only").includes("later.txt"), false);
});

test("Team allows isolated writers and gives their shared helpers the same checkout", async (t) => {
	const root = repository(t);
	const team = new Team({ cwd: root, maxConcurrent: 0, maxDepth: 2, replyTimeoutMs: 100,
		deliverToMain() {}, launcher: { async launch() { throw new Error("queued"); } },
	});
	t.after(() => team.close());
	const spawn = (name: string, isolation?: "shared" | "worktree", parent = "main") => team.spawn({ name, parent, isolation,
		task: "Write files", model: "test/model", readOnly: false, fork: false, blocking: false });
	assert.ok(spawn("shared").ok);
	const isolated = spawn("isolated", "worktree");
	assert.ok(isolated.ok);
	assert.ok(isolated.record.worktree);
	const helper = spawn("helper", "shared", "isolated");
	assert.ok(helper.ok);
	assert.deepEqual(helper.record.worktree, isolated.record.worktree);
	assert.notEqual(helper.record.worktree, isolated.record.worktree);
	const nested = spawn("nested", "worktree", "isolated");
	assert.ok(nested.ok);
	assert.notEqual(nested.record.worktree?.path, isolated.record.worktree?.path);
});

test("tracked node_modules are not replaced with a symlink", (t) => {
	const root = repository(t);
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "tracked.txt"), "tracked dependency\n");
	git(root, "add", "-f", "node_modules/tracked.txt");
	git(root, "commit", "-qm", "tracked dependencies");
	const worktree = createWorktree(root, "scout");
	assert.equal(lstatSync(join(worktree.path, "node_modules")).isSymbolicLink(), false);
});
