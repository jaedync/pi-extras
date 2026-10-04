import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { childInstructions } from "../lib/subagents/format.ts";
import { createLauncher } from "../lib/subagents/child.ts";
import { ChildIndex, legacyRecords } from "../lib/subagents/restore.ts";
import { Team } from "../lib/subagents/team.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const worktree = { path: "/tmp/repo.worktrees/scout", branch: "subagent/scout", base: "a".repeat(40) };
const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ name: "scout", parent: "main", depth: 1, task: "Write",
	model: "test/model", readOnly: false, fork: false, blocking: false, state: "idle", activity: null,
	createdAt: 1, runs: 1, toolCalls: 0, usage: NO_USAGE, worktree, ...patch });

function sdkHarness() {
	const directories: string[] = [];
	const session = { sessionFile: undefined, bindExtensions: async () => {}, subscribe: () => () => {}, dispose() {} };
	const sdk = {
		SettingsManager: { create: (cwd: string) => { directories.push(cwd); return {}; } },
		SessionManager: { inMemory: (cwd: string) => { directories.push(cwd); return {}; },
			open: (_file: string, _dir: string, cwd: string) => { directories.push(cwd); return {}; } },
		DefaultResourceLoader: class { constructor(options: { cwd: string }) { directories.push(options.cwd); } async reload() {} },
		resolveCliModel: () => ({ model: { provider: "test", api: "test", id: "model" } }),
		createAgentSession: async (options: { cwd: string }) => { directories.push(options.cwd); return { session }; },
	};
	return { directories, sdk };
}

test("isolated sessions use their saved worktree for settings, tools, resources and transcripts", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "subagent-child-cwd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { sdk, directories } = sdkHarness();
	const launcher = createLauncher({ sdk: sdk as never, agentDir: root, cwd: "/parent", sessionDir: null,
		modelRuntime: async () => ({}) as never, toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "" });
	const isolated = record({ worktree: { ...worktree, path: root } });
	const child = await launcher.launch(isolated, { update() {} });
	assert.deepEqual(directories, [root, root, root, root]);
	await child.dispose();
	const file = join(root, "saved.jsonl");
	writeFileSync(file, "");
	const restored = await launcher.launch({ ...isolated, restored: true, sessionFile: file }, { update() {} });
	assert.deepEqual(directories.slice(4), [root, root, root, root]);
	await restored.dispose();
});

test("missing worktrees refuse resume before replacing the child record", async () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-missing-cwd-"));
	rmSync(root, { recursive: true, force: true });
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100,
		deliverToMain() {}, launcher: { async launch() { throw new Error("must not launch"); } },
	});
	team.restore([record({ worktree: { ...worktree, path: root } })]);
	const before = team.get("scout");
	const result = await team.send("main", "scout", "Continue");
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.error : "", /workspace no longer exists/);
	assert.equal(team.get("scout"), before);
	await team.close();
});

test("held isolated children refuse resume when their workspace disappears", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "subagent-held-cwd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 100,
		deliverToMain() {}, launcher: { async launch() { return {
			prompt: async () => {}, steer() {}, abort: async () => {}, dispose: async () => {},
			messages: () => [], takeQueued: () => [], lastText: () => undefined,
		}; } },
	});
	t.after(() => team.close());
	team.restore([record({ worktree: { ...worktree, path: root } })]);
	assert.ok((await team.send("main", "scout", "Continue")).ok);
	await team.whenDone("scout");
	rmSync(root, { recursive: true, force: true });
	const before = team.get("scout");
	const result = await team.send("main", "scout", "Continue again");
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.error : "", /workspace no longer exists/);
	assert.equal(team.get("scout"), before);
});

test("indexes preserve worktree metadata and accept older shared records", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-worktree-index-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const index = new ChildIndex(dir, "parent", "/parent");
	const warn = (message: string) => assert.fail(message);
	index.save([record()]);
	assert.deepEqual(new ChildIndex(dir, "parent", "/parent").load(warn)[0]?.worktree, worktree);
	index.save([record({ worktree: undefined })]);
	assert.equal(index.load(warn)[0]?.worktree, undefined);
	for (const bad of [null, { ...worktree, path: "relative" }, { ...worktree, branch: "--unsafe" }, { ...worktree, base: "HEAD" }]) {
		index.save([record({ worktree: bad as never })]);
		assert.throws(() => index.load(warn), /Invalid child index/);
	}
});

test("legacy tool results retain isolated workspace metadata", () => {
	const records = legacyRecords([
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagent", arguments: { task: "Write", isolation: "worktree" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "subagent", details: { name: "scout", model: "test/model", sessionFile: "/children/scout.jsonl", worktree } } },
	], "/children", "main", 1, undefined, assert.fail);
	assert.deepEqual(records[0]?.worktree, worktree);
});

test("isolated children get the worktree boundary in their system prompt", () => {
	const prompt = childInstructions({ name: "scout", parent: "main", readOnly: false, canSpawn: true, roster: "", worktree });
	assert.ok(prompt.includes(worktree.path));
	assert.ok(prompt.includes(worktree.branch));
	assert.match(prompt, /parent's current files/);
	assert.match(prompt, /Edit only inside/);
	assert.match(prompt, /Committing there is optional/);
});
