import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { guardBash } from "../lib/subagents/bash-guard.ts";
import { bwrapPrefix, confine, gitWrites, NO_GIT_WRITES, protectedRoots, sandboxFor, seatbeltProfile, type GitWrites, type Sandbox } from "../lib/subagents/sandbox.ts";
import { createWorktree } from "../lib/subagents/worktree.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });

test("the protected checkouts are every source the worktree was made from", () => {
	assert.deepEqual(protectedRoots("/x/repo.worktrees/scout"), ["/x/repo"]);
	assert.deepEqual(protectedRoots("/x/repo.worktrees/scout.worktrees/helper"), ["/x/repo.worktrees/scout", "/x/repo"]);
	assert.deepEqual(protectedRoots("/x/repo/scout"), []);
});

const GIT: GitWrites = {
	trees: ["/x/my.repo/.git/worktrees/scout", "/x/my.repo/.git/objects"],
	files: ["/x/my.repo/.git/refs/heads/subagent/scout", "/x/my.repo/.git/logs/refs/heads/subagent/scout"],
};

test("the seatbelt profile denies writes under each checkout except the worktree's git data, its branch and node_modules/.cache", () => {
	assert.equal(seatbeltProfile(["/x/my.repo"], GIT), [
		"(version 1)",
		"(allow default)",
		"(deny file-write* (subpath \"/x/my.repo\"))",
		"(allow file-write* (subpath \"/x/my.repo/.git/worktrees/scout\"))",
		"(allow file-write* (subpath \"/x/my.repo/.git/objects\"))",
		"(allow file-write* (regex \"^/x/my\\\\.repo/\\\\.git/refs/heads/subagent/scout(\\\\.lock)?$\"))",
		"(allow file-write* (regex \"^/x/my\\\\.repo/\\\\.git/logs/refs/heads/subagent/scout(\\\\.lock)?$\"))",
		"(allow file-write* (literal \"/x/my.repo/.git/refs/heads/subagent\"))",
		"(allow file-write* (literal \"/x/my.repo/.git/logs/refs/heads/subagent\"))",
		"(allow file-write* (subpath \"/x/my.repo/node_modules/.cache\"))",
	].join("\n"));
	assert.equal(seatbeltProfile(["/x/my.repo"], NO_GIT_WRITES).split("\n").filter((line) => line.includes(".git")).length, 0, "no git data writable when it can't be found");
});

test("the seatbelt profile escapes quotes, backslashes and regex characters", () => {
	const root = "/x/a\"b\\c(d)+[e]";
	const profile = seatbeltProfile([root], { trees: [], files: [`${root}/.git/refs/heads/subagent/s`] });
	assert.ok(profile.includes(String.raw`(deny file-write* (subpath "/x/a\"b\\c(d)+[e]"))`), profile);
	assert.ok(profile.includes(String.raw`(regex "^/x/a\"b\\\\c\\(d\\)\\+\\[e\\]/\\.git/refs/heads/subagent/s(\\.lock)?$")`), profile);
});

test("all denials come before the exceptions, so a second checkout can't undo the first one's", () => {
	const lines = seatbeltProfile(["/x/a.worktrees/b", "/x/a"], GIT).split("\n");
	const lastDeny = lines.findLastIndex((line) => line.startsWith("(deny"));
	const firstAllow = lines.findIndex((line) => line.startsWith("(allow file-write*"));
	assert.ok(lastDeny < firstAllow);
});

test("bwrap binds everything writable, each checkout read-only, then the worktree's git data, its branch's folders and node_modules/.cache writable", (t) => {
	const root = mkdtempSync(join(tmpdir(), "subagent-bwrap-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = join(root, ".git");
	// No branch folders: git pack-refs or gc can remove them, and a bind needs them.
	for (const dir of ["worktrees/scout", "objects", "hooks"]) mkdirSync(join(git, dir), { recursive: true });
	mkdirSync(join(root, "node_modules", ".cache"), { recursive: true });
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	mkdirSync(join(root, "node_modules", "pkg"));
	const writes: GitWrites = {
		trees: [join(git, "worktrees", "scout"), join(git, "objects")],
		files: [join(git, "refs", "heads", "subagent", "scout"), join(git, "logs", "refs", "heads", "subagent", "scout")],
	};
	const bind = (path: string) => ["--bind", path, path];
	assert.deepEqual(bwrapPrefix([root, "/missing"], writes), [
		"bwrap", "--dev-bind", "/", "/",
		"--ro-bind", root, root,
		"--ro-bind", "/missing", "/missing",
		...bind(join(git, "worktrees", "scout")), ...bind(join(git, "objects")),
		// A bind over a file would break git's rename of the lock file onto it, so the branch's folder is bound.
		...bind(join(git, "refs", "heads", "subagent")), ...bind(join(git, "logs", "refs", "heads", "subagent")),
		...bind(join(root, "node_modules", ".cache")),
	]);
	assert.ok(existsSync(join(git, "refs", "heads", "subagent")) && existsSync(join(git, "logs", "refs", "heads", "subagent")), "made before the bind");
});

test("a worktree's git writes are its own git folder, the object store and its branch, read from the source checkout", (t) => {
	const root = repository(t);
	const worktree = createWorktree(root, "scout");
	const common = join(realpathSync(root), ".git");
	assert.deepEqual(gitWrites(worktree, realpathSync(root)), {
		trees: [join(common, "worktrees", "scout"), join(common, "objects")],
		files: [join(common, "refs", "heads", "subagent", "scout"), join(common, "logs", "refs", "heads", "subagent", "scout")],
	});
	// The worktree's .git file is the child's to write, so it is never read: a file or a link that points at the repository's own
	// git folder, or at another worktree's, changes nothing.
	const other = createWorktree(root, "other");
	const own = { trees: [join(common, "worktrees", "scout"), join(common, "objects")], files: (gitWrites(worktree, realpathSync(root)) as GitWrites).files };
	writeFileSync(join(worktree.path, ".git"), `gitdir: ${common}\n`);
	assert.deepEqual(gitWrites(worktree, realpathSync(root)), own);
	rmSync(join(worktree.path, ".git"));
	symlinkSync(join(other.path, ".git"), join(worktree.path, ".git"));
	assert.deepEqual(gitWrites(worktree, realpathSync(root)), own, "a link to another worktree's .git file");
	// Its own git folder is the child's to write too. A folder that names another worktree, or a link in its place, gets nothing.
	const refused = (path: string) => new RegExp(`^No folder in ${join(common, "worktrees").replace(/[.]/g, "\\.")} is ${join(path, ".git").replace(/[.]/g, "\\.")}'s alone\\.`);
	writeFileSync(join(common, "worktrees", "scout", "gitdir"), `${join(other.path, ".git")}\n`);
	assert.match(String(gitWrites(worktree, realpathSync(root))), refused(worktree.path));
	assert.match(String(gitWrites(other, realpathSync(root))), refused(other.path), "two folders name the other worktree");
	rmSync(join(common, "worktrees", "scout"), { recursive: true });
	symlinkSync(join(common, "worktrees", "other"), join(common, "worktrees", "scout"), "dir");
	assert.match(String(gitWrites(worktree, realpathSync(root))), refused(worktree.path), "a link in place of its folder");
	assert.match(String(gitWrites(worktree, join(realpathSync(root), "..", "missing"))), /^git can't find the git folder of /);
});

test("the confined command line is fixed text; the prefix and the command travel in the environment", () => {
	const command = `printf '%s|%s|%s|%s' "$PROBE" "\${PI_SUBAGENT_SANDBOX_COMMAND-unset}" "\${PI_SUBAGENT_SANDBOX_ARG_0-unset}" "it's \\"quoted\\""`;
	const hooked = confine(["/usr/bin/env", "PROBE=from prefix"])({ command, cwd: tmpdir(), env: { PATH: process.env.PATH } });
	assert.doesNotMatch(hooked.command, /printf|from prefix|\/usr\/bin\/env/);
	assert.equal(hooked.cwd, tmpdir());
	const output = execFileSync("/bin/bash", ["-c", hooked.command], { env: hooked.env, encoding: "utf8" });
	assert.equal(output, `from prefix|unset|unset|it's "quoted"`);
});

type Result = { content: { type: "text"; text: string }[]; details: undefined; isError?: boolean };
const fakeBash = (result: Result) => ({ name: "bash", label: "bash", description: "", parameters: {} as never, execute: async () => result });
const run = async (definition: ReturnType<typeof guardBash>) => definition.execute("id", { command: "x" } as never, undefined, undefined, {} as never) as Promise<Result>;
const sandbox: Sandbox = { root: "/x/repo", prefix: ["/usr/bin/sandbox-exec"] };
const DENIED_NOTE = "Writes outside your worktree are blocked. /x/repo is your parent's checkout, and node_modules links into it. Change files only in your worktree, or tell your parent what to change there.";

test("a sandboxed command that hit a denied write gets one line naming the parent's checkout, whatever its exit code", async () => {
	const denied = await run(guardBash(fakeBash({ content: [{ type: "text", text: "touch: /x/repo/a: Operation not permitted\n\nCommand exited with code 1" }], details: undefined, isError: true }), { sandbox }));
	assert.equal(denied.content.at(-1)?.text, `touch: /x/repo/a: Operation not permitted\n\nCommand exited with code 1\n${DENIED_NOTE}`);
	assert.equal(denied.isError, true);
	const readOnly = await run(guardBash(fakeBash({ content: [{ type: "text", text: "Read-only file system" }], details: undefined, isError: true }), { sandbox }));
	assert.equal(readOnly.content[0]!.text, `Read-only file system\n${DENIED_NOTE}`);
	const wentOn = await run(guardBash(fakeBash({ content: [{ type: "text", text: "Operation not permitted\ndone" }], details: undefined }), { sandbox }));
	assert.equal(wentOn.content[0]!.text, `Operation not permitted\ndone\n${DENIED_NOTE}`, "a script that went on and exited 0");
	assert.equal(wentOn.isError, undefined);
});

test("other results are left alone", async () => {
	const ok: Result = { content: [{ type: "text", text: "all fine" }], details: undefined };
	assert.deepEqual(await run(guardBash(fakeBash(ok), { sandbox })), ok, "no denied write");
	const failed: Result = { content: [{ type: "text", text: "no such file" }], details: undefined, isError: true };
	assert.deepEqual(await run(guardBash(fakeBash(failed), { sandbox })), failed, "a failure that is not a denied write");
	const unconfined: Result = { content: [{ type: "text", text: "Operation not permitted" }], details: undefined, isError: true };
	assert.deepEqual(await run(guardBash(fakeBash(unconfined), {})), unconfined, "no sandbox");
});

function repository(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-sandbox-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "repo");
	mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
	git(root, "init", "-q");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.invalid");
	writeFileSync(join(root, ".gitignore"), "node_modules\n");
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "initial");
	return root;
}

const macSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

test("a real sandbox keeps a worktree child's shell out of the parent's checkout", { skip: !macSandbox && "needs /usr/bin/sandbox-exec" }, (t) => {
	const root = repository(t);
	const worktree = createWorktree(root, "scout");
	const box = sandboxFor(worktree);
	assert.ok(box, "sandbox-exec applies the profile");
	assert.equal(box.root, realpathSync(root));
	const shell = (command: string) => {
		const hooked = confine(box.prefix)({ command, cwd: worktree.path, env: { ...process.env } });
		return spawnSync("/bin/bash", ["-c", hooked.command], { cwd: hooked.cwd, env: hooked.env, encoding: "utf8" });
	};
	assert.equal(shell("echo inside > inside.txt").status, 0);
	assert.equal(readFileSync(join(worktree.path, "inside.txt"), "utf8"), "inside\n");
	const escape = shell(`echo out > '${join(root, "escape.txt")}'`);
	assert.notEqual(escape.status, 0);
	assert.match(escape.stderr, /Operation not permitted/);
	assert.equal(existsSync(join(root, "escape.txt")), false);
	const commit = shell("git add inside.txt && git commit -qm 'child commit'");
	assert.equal(commit.status, 0, commit.stderr);
	assert.equal(git(worktree.path, "log", "-1", "--format=%s").trim(), "child commit");
	assert.equal(shell("mkdir -p node_modules/.cache/tool && echo c > node_modules/.cache/tool/c").status, 0, "tool caches stay writable");
	assert.equal(readFileSync(join(root, "node_modules", ".cache", "tool", "c"), "utf8"), "c\n");
	assert.notEqual(shell("echo p > node_modules/pkg/index.js").status, 0, "the parent's packages do not");
	assert.equal(existsSync(join(root, "node_modules", "pkg", "index.js")), false);
	const elsewhere = join(tmpdir(), `subagent-sandbox-tmp-${process.pid}`);
	t.after(() => rmSync(elsewhere, { force: true }));
	assert.equal(shell(`echo t > '${elsewhere}'`).status, 0, "writes elsewhere still work");
});

test("a real sandbox lets a worktree child commit on its branch, but not change the parent's hooks, config, branches or packages", { skip: !macSandbox && "needs /usr/bin/sandbox-exec" }, (t) => {
	const root = repository(t);
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	const parentBranch = git(root, "branch", "--show-current").trim();
	const parentHead = git(root, "rev-parse", "HEAD").trim();
	const worktree = createWorktree(root, "scout");
	// Pack the refs, as git gc does: the child's commit must make its branch's folder again.
	git(root, "pack-refs", "--all");
	const box = sandboxFor(worktree);
	assert.ok(box, "sandbox-exec applies the profile");
	const shell = (command: string) => {
		const hooked = confine(box.prefix)({ command, cwd: worktree.path, env: { ...process.env } });
		return spawnSync("/bin/bash", ["-c", hooked.command], { cwd: hooked.cwd, env: hooked.env, encoding: "utf8" });
	};
	const commit = shell("echo one > one.txt && git status --short && git add one.txt && git commit -qm one && echo two > two.txt && git add -A && git commit -qm two && git status --short");
	assert.equal(commit.status, 0, commit.stderr);
	assert.equal(git(worktree.path, "log", "-2", "--format=%s").trim(), "two\none");
	assert.equal(git(root, "rev-parse", "HEAD").trim(), parentHead);
	const gitDir = join(realpathSync(root), ".git");
	const refused = [
		[`printf '#!/bin/sh\\necho hook\\n' > '${join(gitDir, "hooks", "pre-commit")}'`, "a parent's hook"],
		[`git config --file '${join(gitDir, "config")}' core.hooksPath /tmp`, "the parent's config"],
		[`echo x > '${join(gitDir, "info", "exclude")}'`, "the parent's info/exclude"],
		[`git -C '${root}' update-ref refs/heads/${parentBranch} ${worktree.base}`, "the parent's branch"],
		[`git -C '${root}' branch evil`, "a new branch"],
		[`echo evil > '${join(root, "node_modules", ".bin", "vitest")}'`, "a node_modules/.bin shim"],
		[`echo x > '${join(worktree.path, "node_modules", ".package-lock.json")}'`, "another node_modules dot-entry"],
	] as const;
	for (const [command, what] of refused) assert.notEqual(shell(command).status, 0, what);
	assert.equal(existsSync(join(gitDir, "hooks", "pre-commit")), false);
	assert.doesNotMatch(readFileSync(join(gitDir, "config"), "utf8"), /hooksPath/);
	assert.equal(git(root, "rev-parse", parentBranch).trim(), parentHead);
	assert.equal(existsSync(join(root, "node_modules", ".bin", "vitest")), false);
	assert.equal(existsSync(join(root, "node_modules", ".package-lock.json")), false);
});

test("no sandbox for a workspace with no source checkout on disk", () => {
	assert.equal(sandboxFor({ path: "/nonexistent/repo.worktrees/scout", branch: "subagent/scout" }), undefined);
});
