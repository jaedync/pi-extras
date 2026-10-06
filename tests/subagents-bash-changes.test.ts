import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { guardBash, type ChangeWatch } from "../lib/subagents/bash-guard.ts";
import { changedPaths, fingerprint, statusPaths } from "../lib/subagents/fingerprint.ts";
import { ToolActivity } from "../lib/subagents/tool-activity.ts";
import { Team } from "../lib/subagents/team.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });

function repository(t: TestContext): string {
	const root = join(mkdtempSync(join(tmpdir(), "subagent-bash-changes-")), "repo");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(root);
	git(root, "init", "-q");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.invalid");
	writeFileSync(join(root, ".gitignore"), "build/\n");
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "initial");
	return realpathSync(root);
}

test("status paths read porcelain -z, a rename's source included", () => {
	assert.deepEqual([...statusPaths(" M a.txt\0R  new name.txt\0old name.txt\0?? dir/b.txt\0")], [
		["a.txt", " M"], ["new name.txt", "R "], ["old name.txt", "R "], ["dir/b.txt", "??"],
	]);
	assert.deepEqual([...statusPaths("")], []);
});

test("a fingerprint sees new, changed, reverted and more-edited dirty files, but not ignored ones", async (t) => {
	const root = repository(t);
	writeFileSync(join(root, "dirty.txt"), "one\n");
	const before = await fingerprint(root);
	writeFileSync(join(root, "dirty.txt"), "one more\n");
	writeFileSync(join(root, "tracked.txt"), "changed\n");
	writeFileSync(join(root, "new.txt"), "new\n");
	mkdirSync(join(root, "build"));
	writeFileSync(join(root, "build", "out.js"), "ignored\n");
	const after = await fingerprint(root);
	assert.deepEqual(changedPaths(before, after), ["dirty.txt", "new.txt", "tracked.txt"].map((path) => join(root, path)));
	git(root, "checkout", "--", "tracked.txt");
	assert.deepEqual(changedPaths(after, await fingerprint(root)), [join(root, "tracked.txt")], "a file that became clean again changed too");
	await assert.rejects(fingerprint(mkdtempSync(join(tmpdir(), "subagent-no-git-"))), /not a git repository/i);
});

test("activity: edits open at the start or begun during a watch count; another shell in the same place makes it shared", () => {
	const activity = new ToolActivity();
	activity.editStart("main:1", "/r/early.txt");
	const stop = activity.watch("scout:1", "/r");
	activity.editStart("other:1", "/r/during.txt");
	activity.end("main:1");
	activity.end("other:1");
	activity.shellStart("apart:1", "/elsewhere");
	activity.end("apart:1");
	const first = stop();
	assert.deepEqual([...first.edited].sort(), ["/r/during.txt", "/r/early.txt"]);
	assert.equal(first.shared, false, "a shell in another workspace does not count");
	activity.editStart("main:2", "/r/late.txt");
	assert.equal(first.edited.has("/r/late.txt"), false, "a stopped watch hears nothing more");
	activity.end("main:2");
	activity.shellStart("main:3", "/r");
	const second = activity.watch("scout:2", "/r");
	activity.end("main:3");
	assert.equal(second().shared, true, "main's shell was running at the start");
	const third = activity.watch("scout:3", "/r");
	activity.shellStart("other:2", "/r");
	activity.end("other:2");
	assert.equal(third().shared, true, "another child's shell began during it");
	assert.equal(activity.watch("scout:4", "/r")().shared, false, "ended calls are forgotten");
});

const record = (name: string, patch: Partial<AgentRecord> = {}): AgentRecord => ({ name, parent: "main", depth: 1, task: "Work", model: "test/model",
	readOnly: false, fork: false, blocking: false, state: "running", activity: null, runs: 1, createdAt: 1, toolCalls: 0, usage: NO_USAGE, ...patch });

function harness(root: string) {
	const warnings: string[] = [];
	const team = new Team({ maxConcurrent: 4, maxDepth: 4, replyTimeoutMs: 100, cwd: root, warn: (message) => warnings.push(message),
		deliverToMain() {}, launcher: { async launch() { throw new Error("not launched"); } } });
	team.restore([record("writer"), record("holder"), record("other")]);
	const activity = new ToolActivity();
	const bash = (name: string, cwd = root, during?: () => void) => {
		const watch: ChangeWatch = { cwd, agent: name, activity, mayEdit: (top) => team.mayEdit(name, top), changed: (paths, top) => team.bashChanged(name, paths, top), warn: (message) => warnings.push(message) };
		const definition = guardBash({ name: "bash", label: "bash", description: "", parameters: {} as never,
			async execute(_id: string, params: { command: string }, _signal?: unknown, _onUpdate?: unknown, _ctx?: unknown) {
				const result = spawnSync("/bin/bash", ["-c", params.command], { cwd, encoding: "utf8" });
				during?.();
				return { content: [{ type: "text" as const, text: `${result.stdout}${result.stderr}` || "(no output)" }], details: undefined, ...(result.status ? { isError: true } : {}) };
			} }, { changes: watch });
		let calls = 0;
		return async (command: string) => (await definition.execute(`call-${++calls}`, { command } as never, undefined, undefined, {} as never)).content.map((part) => (part.type === "text" ? part.text : "")).join("");
	};
	return { team, warnings, activity, bash };
}

test("a bash call that changes files takes the free lock silently", async (t) => {
	const root = repository(t);
	const { team, warnings, bash } = harness(root);
	assert.equal(await bash("writer")("echo new > new.txt && echo ok"), "ok\n");
	assert.match(team.claimEdit("other", join(root, "other.txt")) ?? "", /^writer is editing files in the checkout /);
	assert.deepEqual(warnings, []);
	await team.close();
});

test("a bash call that changes files while another child holds the lock gets a note; the holder keeps it", async (t) => {
	const root = repository(t);
	const { team, warnings, bash } = harness(root);
	assert.equal(team.claimEdit("holder", join(root, "held.txt")), undefined);
	const text = await bash("writer")("for n in 1 2 3 4 5 6 7; do echo $n > f$n.txt; done; echo done");
	assert.equal(text, `done\nThis command changed f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and 2 more in the checkout ${realpathSync(root)} while holder holds its edit lock. Don't change files here; tell main if you need a worktree (isolation: "worktree").`);
	assert.match(team.claimEdit("other", join(root, "other.txt")) ?? "", /^holder is editing files in the checkout /, "the holder keeps the lock");
	assert.deepEqual(warnings, [`subagents: writer's bash command changed f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and 2 more in the checkout ${realpathSync(root)} while holder holds its edit lock.`]);
	await team.close();
});

test("a bash call that only reads, or writes only ignored files, takes nothing", async (t) => {
	const root = repository(t);
	const { team, warnings, bash } = harness(root);
	writeFileSync(join(root, "dirty.txt"), "dirty\n");
	const writer = bash("writer");
	assert.equal(await writer("cat tracked.txt dirty.txt && git status --short >/dev/null"), "committed\ndirty\n");
	assert.equal(await writer("mkdir -p build && echo out > build/out.js"), "(no output)");
	assert.equal(team.claimEdit("other", join(root, "other.txt")), undefined, "the lock was still free");
	assert.deepEqual(warnings, []);
	await team.close();
});

test("a workspace that is not a git repository skips detection and warns once", async (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-no-git-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { team, warnings, bash } = harness(dir);
	const writer = bash("writer", dir);
	assert.equal(await writer("echo a > a.txt && echo ok"), "ok\n");
	assert.equal(await writer("echo b > b.txt && echo ok"), "ok\n");
	assert.equal(team.claimEdit("other", join(dir, "other.txt")), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, new RegExp(`^subagents: can't tell which files bash commands change in ${dir.replace(/[.]/g, "\\.")}, so they don't take the edit lock there\\. .*not a git repository`, "i"));
	await team.close();
});

test("paths an edit or write call targeted during the bash call are not the command's changes", async (t) => {
	const root = repository(t);
	const { team, warnings, activity, bash } = harness(root);
	assert.equal(team.claimEdit("holder", join(root, "held.txt")), undefined);
	const edited = join(root, "edited by main.txt");
	const text = await bash("writer", root, () => {
		activity.editStart("main:call-1", edited);
		writeFileSync(edited, "main\n");
		activity.end("main:call-1");
	})("echo ok");
	assert.equal(text, "ok\n", "main's edit is not blamed on the child");
	const both = await bash("writer", root, () => {
		activity.editStart("holder:call-9", join(root, "holder.txt"));
		writeFileSync(join(root, "holder.txt"), "holder\n");
		activity.end("holder:call-9");
	})("echo mine > mine.txt");
	assert.match(both, /This command changed mine\.txt in the checkout \S+ while holder holds/);
	assert.equal(warnings.length, 1);
	await team.close();
});

test("another agent's shell in the same checkout at the same time makes the changes unattributable, so nothing happens", async (t) => {
	const root = repository(t);
	const { team, warnings, activity, bash } = harness(root);
	assert.equal(team.claimEdit("holder", join(root, "held.txt")), undefined);
	// Callers name the work tree as git gives its top level.
	activity.shellStart("main:call-1", realpathSync(root));
	assert.equal(await bash("writer")("echo x > x.txt && echo ok"), "ok\n");
	activity.end("main:call-1");
	assert.deepEqual(warnings, []);
	await team.close();
});

test("a shell in the same work tree started from another directory makes the changes unattributable too", async (t) => {
	const root = repository(t);
	mkdirSync(join(root, "sub"));
	const { team, warnings, activity, bash } = harness(root);
	assert.equal(team.claimEdit("holder", join(root, "held.txt")), undefined);
	activity.shellStart("other:call-1", realpathSync(root));
	assert.equal(await bash("writer", join(root, "sub"))("echo x > x.txt && echo ok"), "ok\n");
	activity.end("other:call-1");
	assert.deepEqual(warnings, [], "a child in a subdirectory shares the work tree with an agent at its top");
	await team.close();
});

test("a child that already holds the lock, or works for its holder, is not fingerprinted", async (t) => {
	const root = repository(t);
	const { team, warnings, activity, bash } = harness(root);
	const watched: string[] = [];
	const watch = activity.watch.bind(activity);
	activity.watch = (id, cwd) => { watched.push(id); return watch(id, cwd); };
	team.restore([record("helper", { parent: "holder", depth: 2 })]);
	assert.equal(team.claimEdit("holder", join(root, "held.txt")), undefined);
	await bash("holder")("echo a > a.txt");
	await bash("helper")("echo b > b.txt");
	await bash("other")("echo ok");
	assert.deepEqual(watched, ["other:call-1"], "only the child that may not edit was watched");
	assert.deepEqual(warnings, []);
	await team.close();
});
