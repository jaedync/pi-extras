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
	// The line runs git only in the parent's checkout, on a tree main wrote with the worktree's verified git folder.
	const tree = /diff --binary --no-ext-diff --no-textconv \S+ ([0-9a-f]{40,64}) /.exec(footer)?.[1] ?? "";
	assert.equal(git(worktree.path, "diff", "--cached", "--name-only"), "", "the report stages nothing in the worktree");
	git(worktree.path, "add", "-A");
	assert.equal(git(worktree.path, "rev-parse", `${tree}^{tree}`).trim(), git(worktree.path, "write-tree").trim(), "the tree of the worktree's files now");
	const quoted = `'${realpathSync(root)}'`;
	assert.ok(footer.includes(`\nApply: git -C ${quoted} diff --binary --no-ext-diff --no-textconv ${worktree.base} ${tree} -- . ':(exclude)node_modules' | git -C ${quoted} apply\n`), footer);
	assert.ok(!footer.includes(`git -C '${worktree.path}'`), "nothing runs git in the child's worktree");
	assert.ok(footer.includes(`git worktree remove --force '${worktree.path}'`));
	assert.ok(footer.includes("git branch -D subagent/scout"));
	assert.ok(existsSync(worktree.path));
	const baseContent = git(worktree.path, "show", `${worktree.base}:tracked.txt`);
	assert.equal(baseContent, "main uncommitted\n");
	execFileSync("/bin/bash", ["-c", /\nApply: (.*)\n/.exec(footer)![1]!], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
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

for (const [layout, ignore] of [["node_modules", "node_modules\n"], ["node_modules/", "node_modules/\n"], ["no entry", ""]] as const) {
	test(`with a real node_modules and .gitignore ${layout}, the worktree, its report and the apply command leave dependencies alone`, (t) => {
		const root = repository(t);
		writeFileSync(join(root, ".gitignore"), `ignored.txt\n${ignore}`);
		git(root, "add", "-A");
		git(root, "commit", "-qm", "ignore rules", "--allow-empty");
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(root, "node_modules", "pkg", "index.js"), "dependency\n");
		const worktree = createWorktree(root, "scout");
		assert.equal(git(worktree.path, "ls-tree", "-r", "--name-only", worktree.base).includes("node_modules"), false, "the base leaves dependencies out");
		assert.equal(lstatSync(join(worktree.path, "node_modules")).isSymbolicLink(), true);
		writeFileSync(join(worktree.path, "tracked.txt"), "child edit\n");
		const footer = worktreeFooter(worktree);
		assert.match(footer, /1 file differs from base, 0 commits/);
		const apply = footer.split("\n").find((line) => line.startsWith("Apply: "))!.slice("Apply: ".length);
		execFileSync("/bin/bash", ["-c", apply], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
		assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "child edit\n");
		assert.equal(lstatSync(join(root, "node_modules")).isDirectory(), true, "the parent's node_modules is still a directory");
		assert.equal(readFileSync(join(root, "node_modules", "pkg", "index.js"), "utf8"), "dependency\n");
	});
}

test("a worktree report counts every change without staging anything in the worktree", (t) => {
	const root = repository(t);
	const worktree = createWorktree(root, "lead");
	writeFileSync(join(worktree.path, "feature.txt"), "the change\n");
	writeFileSync(join(worktree.path, "scratch.txt"), "not for commit\n");
	git(worktree.path, "add", "feature.txt");
	const staged = git(worktree.path, "diff", "--cached", "--name-only");
	assert.match(worktreeFooter(worktree), /2 files differ from base/);
	assert.equal(git(worktree.path, "diff", "--cached", "--name-only"), staged, "the lead's own staging stays as it was");
});

test("a helper in its lead's worktree reports without the lead's worktree footer", async (t) => {
	const root = repository(t);
	const prompts = new Map<string, string[]>();
	const finish = new Map<string, (text: string) => void>();
	const team = new Team({ maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, deliverToMain: () => undefined, warn: () => undefined,
		launcher: { async launch(record: AgentRecord) {
			const transcript: unknown[] = [];
			return { prompt: (text: string) => new Promise<void>((resolve) => {
				prompts.set(record.name, [...(prompts.get(record.name) ?? []), text]);
				finish.set(record.name, (said) => { transcript.push({ role: "assistant", content: [{ type: "text", text: said }] }); resolve(); });
			}), steer: () => undefined, abort: async () => undefined, lastText: () => undefined, messages: () => transcript, takeQueued: () => [], dispose: async () => undefined };
		} } });
	const spawn = (name: string, parent: string, extra: object = {}) => {
		const result = team.spawn({ name, task: name, parent, model: "m", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
	};
	const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
	spawn("lead", "main", { cwd: root, isolation: "worktree" }); await flush();
	spawn("helper", "lead"); await flush();
	assert.equal(team.get("helper")!.worktree?.path, team.get("lead")!.worktree?.path);
	finish.get("lead")!("waiting for helper"); await flush();
	finish.get("helper")!("Checked the docs."); await flush();
	const toLead = prompts.get("lead")!.at(-1)!;
	assert.match(toLead, /Checked the docs/);
	assert.doesNotMatch(toLead, /git worktree remove|Worktree:/);
	assert.match(reportText(team.get("lead")!, Date.now()), /Worktree: /, "the lead's own report keeps it");
	await team.close();
});

/** What a child in a worktree can write without leaving it: a git folder of its own that runs `marker`'s command, named by the worktree's .git file. */
function plantGitFolder(worktree: string, root: string, marker: string): void {
	const evil = join(worktree, ".evil");
	git(worktree, "init", "-q", "--bare", evil);
	writeFileSync(join(evil, "objects", "info", "alternates"), `${join(root, ".git", "objects")}\n`);
	mkdirSync(join(evil, "hooks"), { recursive: true });
	writeFileSync(join(evil, "hooks", "post-index-change"), `#!/bin/sh\necho hook > '${marker}.hook'\n`, { mode: 0o755 });
	writeFileSync(join(evil, "config"), [
		"[core]", "\tbare = false", `\tfsmonitor = "echo fsmonitor > '${marker}.fsmonitor'; false"`,
		`[filter "x"]`, `\tclean = "echo filter > '${marker}.filter'; cat"`,
	].join("\n"));
	writeFileSync(join(worktree, ".gitattributes"), "* filter=x\n");
	writeFileSync(join(worktree, ".git"), "gitdir: .evil\n");
}

const ran = (marker: string): string[] => ["hook", "fsmonitor", "filter"].filter((kind) => existsSync(`${marker}.${kind}`));

test("main's git commands in a child's worktree use the worktree's own git folder and run nothing the child set up", async (t) => {
	const root = repository(t);
	const worktree = createWorktree(realpathSync(root), "scout");
	const marker = join(realpathSync(root), "..", "ran");
	writeFileSync(join(worktree.path, "new.txt"), "new\n");
	plantGitFolder(worktree.path, realpathSync(root), marker);
	const footer = worktreeFooter(worktree);
	assert.deepEqual(ran(marker), [], footer);
	assert.match(footer, /; \d+ files differ from base, 0 commits\./, "the worktree's own index and HEAD, not the planted folder's");
	const { fingerprint } = await import("../lib/subagents/fingerprint.ts");
	assert.ok((await fingerprint(worktree.path, worktree)).has(join(worktree.path, "new.txt")));
	assert.deepEqual(ran(marker), []);
	writeFileSync(join(worktree.path, "other.txt"), "other\n");
	const last = worktreeFooter(worktree);
	assert.match(last, /\nApply: /, last);
	// Main's bash runs the Apply line too.
	execFileSync("/bin/bash", ["-c", /\nApply: (.*)\n/.exec(last)![1]!], { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
	assert.deepEqual(ran(marker), []);
	assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "other\n");
	// A subagent of the child that gets its own worktree: main makes it from the child's worktree.
	const nested = createWorktree(worktree.path, "nested", undefined, worktree);
	assert.deepEqual(ran(marker), []);
	assert.equal(nested.path, join(`${worktree.path}.worktrees`, "nested"));
	assert.equal(readFileSync(join(nested.path, "other.txt"), "utf8"), "other\n", "with the child's uncommitted files");
	assert.match(git(realpathSync(root), "worktree", "list"), /scout\.worktrees\/nested /);
	// The nested worktree's git folder is found from the first checkout, never through the child's .git or its folder.
	writeFileSync(join(nested.path, "deep.txt"), "deep\n");
	assert.match(worktreeFooter(nested), /; \d+ files? differs? from base, 0 commits\./);
	assert.deepEqual(ran(marker), []);
	// The worktree's own git folder is the child's to write too. Git takes the config from GIT_COMMON_DIR, not its commondir
	// file, but reads the worktree's refs through that file, so the report fails there; nothing runs.
	const fake = join(worktree.path, ".fake");
	git(worktree.path, "init", "-q", "--bare", fake);
	writeFileSync(join(fake, "config"), `[core]\n\tbare = false\n[filter "x"]\n\tclean = "echo filter > '${marker}.filter'; cat"\n`);
	writeFileSync(join(realpathSync(root), ".git", "worktrees", "scout", "commondir"), `${fake}\n`);
	worktreeFooter(worktree);
	await fingerprint(worktree.path, worktree);
	assert.throws(() => createWorktree(worktree.path, "again", undefined, worktree));
	assert.deepEqual(ran(marker), []);
});

test("main's change check outside a subagent worktree runs with the safe config only, also in a clone that sits where a worktree would", async (t) => {
	const root = realpathSync(repository(t));
	const clone = join(`${root}.worktrees`, "clone");
	git(root, "clone", "-q", root, clone);
	writeFileSync(join(clone, "new.txt"), "new\n");
	const { fingerprint } = await import("../lib/subagents/fingerprint.ts");
	assert.ok((await fingerprint(clone)).has(join(clone, "new.txt")));
	t.after(() => rmSync(`${root}.worktrees`, { recursive: true, force: true }));
});

test("main's change check runs no fsmonitor or hook that a repository's config sets, also outside subagent worktrees", async (t) => {
	const root = realpathSync(repository(t));
	const marker = join(root, "..", "ran");
	git(root, "config", "core.fsmonitor", `echo fsmonitor > '${marker}.fsmonitor'; false`);
	writeFileSync(join(root, ".git", "hooks", "post-index-change"), `#!/bin/sh\necho hook > '${marker}.hook'\n`, { mode: 0o755 });
	writeFileSync(join(root, "new.txt"), "new\n");
	const { fingerprint } = await import("../lib/subagents/fingerprint.ts");
	assert.ok((await fingerprint(root)).has(join(root, "new.txt")));
	assert.deepEqual(ran(marker), []);
});
