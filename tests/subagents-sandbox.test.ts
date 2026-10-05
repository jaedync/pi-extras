import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { guardBash } from "../lib/subagents/bash-guard.ts";
import { bwrapPrefix, confine, protectedRoots, sandboxFor, seatbeltProfile, type Sandbox } from "../lib/subagents/sandbox.ts";
import { createWorktree } from "../lib/subagents/worktree.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });

test("the protected checkouts are every source the worktree was made from", () => {
	assert.deepEqual(protectedRoots("/x/repo.worktrees/scout"), ["/x/repo"]);
	assert.deepEqual(protectedRoots("/x/repo.worktrees/scout.worktrees/helper"), ["/x/repo.worktrees/scout", "/x/repo"]);
	assert.deepEqual(protectedRoots("/x/repo/scout"), []);
});

test("the seatbelt profile denies writes under each checkout except its git data and node_modules dot-entries", () => {
	assert.equal(seatbeltProfile(["/x/my.repo"]), [
		"(version 1)",
		"(allow default)",
		"(deny file-write* (subpath \"/x/my.repo\"))",
		"(allow file-write* (subpath \"/x/my.repo/.git\"))",
		"(allow file-write* (regex \"^/x/my\\\\.repo/node_modules/\\\\.[^/]+(/|$)\"))",
	].join("\n"));
});

test("the seatbelt profile escapes quotes, backslashes and regex characters", () => {
	const profile = seatbeltProfile(["/x/a\"b\\c(d)+[e]"]);
	assert.ok(profile.includes(String.raw`(deny file-write* (subpath "/x/a\"b\\c(d)+[e]"))`), profile);
	assert.ok(profile.includes(String.raw`(regex "^/x/a\"b\\\\c\\(d\\)\\+\\[e\\]/node_modules/\\.[^/]+(/|$)")`), profile);
});

test("all denials come before the exceptions, so a second checkout can't undo the first one's", () => {
	const lines = seatbeltProfile(["/x/a.worktrees/b", "/x/a"]).split("\n");
	const lastDeny = lines.findLastIndex((line) => line.startsWith("(deny"));
	const firstAllow = lines.findIndex((line) => line.startsWith("(allow file-write*"));
	assert.ok(lastDeny < firstAllow);
});

test("bwrap binds everything writable, each checkout read-only, then its git data and existing node_modules dot-entries writable", (t) => {
	const root = mkdtempSync(join(tmpdir(), "subagent-bwrap-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "node_modules", ".cache"), { recursive: true });
	mkdirSync(join(root, "node_modules", "pkg"));
	assert.deepEqual(bwrapPrefix([root, "/missing"]), [
		"bwrap", "--dev-bind", "/", "/",
		"--ro-bind", root, root,
		"--ro-bind", "/missing", "/missing",
		"--bind", join(root, ".git"), join(root, ".git"),
		"--bind", join(root, "node_modules", ".cache"), join(root, "node_modules", ".cache"),
	]);
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

test("a failed sandboxed command that hit a denied write gets one line naming the parent's checkout", async () => {
	const denied = await run(guardBash(fakeBash({ content: [{ type: "text", text: "touch: /x/repo/a: Operation not permitted\n\nCommand exited with code 1" }], details: undefined, isError: true }), { sandbox }));
	assert.equal(denied.content.at(-1)?.text, `touch: /x/repo/a: Operation not permitted\n\nCommand exited with code 1\n${DENIED_NOTE}`);
	assert.equal(denied.isError, true);
	const readOnly = await run(guardBash(fakeBash({ content: [{ type: "text", text: "Read-only file system" }], details: undefined, isError: true }), { sandbox }));
	assert.equal(readOnly.content[0]!.text, `Read-only file system\n${DENIED_NOTE}`);
});

test("other results are left alone", async () => {
	const ok: Result = { content: [{ type: "text", text: "Operation not permitted" }], details: undefined };
	assert.deepEqual(await run(guardBash(fakeBash(ok), { sandbox })), ok, "a command that exited 0");
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
	const box = sandboxFor(worktree.path);
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

test("no sandbox for a workspace with no source checkout on disk", () => {
	assert.equal(sandboxFor("/nonexistent/repo.worktrees/scout"), undefined);
});
