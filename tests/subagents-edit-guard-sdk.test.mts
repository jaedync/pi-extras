/** A child's edit and write calls pass through its edit guard in a real SDK session, driven by Pi's faux provider. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "subagents-edit-guard-"));
// Set before importing the SDK. This test must never read real settings or credentials.
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { createLauncher } = await import("../lib/subagents/child.ts");
const { Team } = await import("../lib/subagents/team.ts");
const { NO_USAGE } = await import("../lib/subagents/types.ts");

const lastToolResult = (context: any): string => {
	const result = [...context.messages].reverse().find((message: any) => message.role === "toolResult");
	return result?.content?.map((part: any) => part.text ?? "").join("") ?? "";
};

async function setup(cwd: string) {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	let team!: InstanceType<typeof Team>;
	team = new Team({
		maxConcurrent: 2, maxDepth: 2, replyTimeoutMs: 5_000, cwd,
		deliverToMain: () => undefined,
		launcher: createLauncher({
			sdk: sdk as never, agentDir, cwd, sessionDir: null,
			modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: ["write"], customTools: [] }),
			instructions: () => "",
			claimEdit: (name) => team.claimEdit(name),
		}),
	});
	return { team, faux };
}

const holder = { name: "holder", parent: "main", depth: 1, task: "Edit", model: "faux/cheap", readOnly: false, fork: false, blocking: false,
	state: "running" as const, createdAt: 1, activity: null, toolCalls: 0, usage: NO_USAGE, runs: 1 };

test("a child's write is blocked, not run, while another child holds the checkout", { timeout: 20_000 }, async () => {
	const cwd = mkdtempSync(join(scratch, "locked-"));
	const { team, faux } = await setup(cwd);
	team.restore([holder]);
	assert.equal(team.claimEdit("holder"), undefined);
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("write", { path: "notes.txt", content: "mine" })),
		(context: any) => ai.fauxAssistantMessage(lastToolResult(context)),
	]);
	assert.ok(team.spawn({ name: "writer", task: "Write notes", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
	const done = await team.whenDone("writer");
	assert.equal(done.state, "idle", done.error);
	assert.match(done.report ?? "", /holder is editing files outside git, for the workspace \S+, until its run ends\. Do work that does not edit files, or tell main you need a cwd of your own/);
	assert.equal(existsSync(join(cwd, "notes.txt")), false, "the blocked call never ran");
	await team.close();
});

test("a child's write runs and takes the free lock", { timeout: 20_000 }, async () => {
	const cwd = mkdtempSync(join(scratch, "free-"));
	const { team, faux } = await setup(cwd);
	team.restore([{ ...holder, name: "other" }]);
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("write", { path: "notes.txt", content: "mine" })),
		() => {
			// Still inside the writer's run: it holds the checkout now.
			assert.match(team.claimEdit("other") ?? "", /^writer is editing files outside git, for the workspace /);
			return ai.fauxAssistantMessage("Wrote notes.");
		},
	]);
	assert.ok(team.spawn({ name: "writer", task: "Write notes", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
	const done = await team.whenDone("writer");
	assert.equal(done.state, "idle", done.error);
	assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "mine");
	assert.equal(team.claimEdit("other"), undefined, "released once its run ended");
	await team.close();
});

test("a worktree child's write outside its worktree is blocked; inside it runs", { timeout: 20_000 }, async () => {
	const cwd = mkdtempSync(join(scratch, "parent-"));
	const tree = mkdtempSync(join(scratch, "tree-"));
	const { team, faux } = await setup(cwd);
	team.restore([{ ...holder, name: "isolated", state: "idle", runs: 0, worktree: { path: tree, branch: "subagent/isolated", base: "a".repeat(40) } }]);
	const results: string[] = [];
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("write", { path: join(cwd, "escape.txt"), content: "out" })),
		(context: any) => {
			results.push(lastToolResult(context));
			return ai.fauxAssistantMessage(ai.fauxToolCall("write", { path: "inside.txt", content: "in" }));
		},
		(context: any) => {
			results.push(lastToolResult(context));
			return ai.fauxAssistantMessage("Done.");
		},
	]);
	assert.ok((await team.send("main", "isolated", "Write the files.")).ok);
	const done = await team.whenDone("isolated");
	assert.equal(done.state, "idle", done.error);
	assert.match(results[0] ?? "", new RegExp(`escape\\.txt is outside your worktree ${tree.replace(/[.]/g, "\\.")}\\.`));
	assert.equal(existsSync(join(cwd, "escape.txt")), false, "the blocked call never ran");
	assert.equal(readFileSync(join(tree, "inside.txt"), "utf8"), "in");
	await team.close();
});
