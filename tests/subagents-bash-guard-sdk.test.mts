/** A child's bash calls run through its guarded bash tool in a real SDK session, driven by Pi's faux provider. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "subagents-bash-guard-"));
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
const { ToolActivity } = await import("../lib/subagents/tool-activity.ts");
const { NO_USAGE } = await import("../lib/subagents/types.ts");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 });
const lastToolResult = (context: any): string => {
	const result = [...context.messages].reverse().find((message: any) => message.role === "toolResult");
	return result?.content?.map((part: any) => part.text ?? "").join("") ?? "";
};

function repository(): string {
	const root = join(mkdtempSync(join(scratch, "repo-")), "repo");
	mkdirSync(root);
	git(root, "init", "-q");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.invalid");
	writeFileSync(join(root, ".gitignore"), "ignored/\n");
	writeFileSync(join(root, "tracked.txt"), "committed\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "initial");
	return root;
}

async function setup(cwd: string) {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const warnings: string[] = [];
	let team!: InstanceType<typeof Team>;
	team = new Team({
		maxConcurrent: 2, maxDepth: 2, replyTimeoutMs: 5_000, cwd, warn: (message) => warnings.push(message),
		deliverToMain: () => undefined,
		launcher: createLauncher({
			sdk: sdk as never, agentDir, cwd, sessionDir: null,
			modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: ["bash", "write"], customTools: [] }),
			instructions: () => "",
			claimEdit: (name, target) => team.claimEdit(name, target),
			activity: new ToolActivity(),
			mayEdit: (name, top) => team.mayEdit(name, top),
			bashChanged: (name, paths, top) => team.bashChanged(name, paths, top),
		}),
	});
	return { team, faux, warnings };
}

const spawn = (team: InstanceType<typeof Team>, name: string, isolation?: "worktree") =>
	team.spawn({ name, task: "Run commands", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, ...(isolation ? { isolation } : {}) });

const commandsOf = (messages: readonly any[]): string[] => messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
	? message.content.filter((part: any) => part.type === "toolCall" && part.name === "bash").map((part: any) => part.arguments.command) : []);

test("a worktree child's transcript keeps its own bash command; a write into the parent's checkout fails with a note, also when the command goes on", { timeout: 30_000 }, async () => {
	const root = repository();
	const { team, faux } = await setup(root);
	const escape = `echo out > '${join(root, "escape.txt")}'`;
	const results: string[] = [];
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "echo inside > inside.txt && echo ran" })),
		(context: any) => {
			results.push(lastToolResult(context));
			return ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: escape }));
		},
		(context: any) => {
			results.push(lastToolResult(context));
			// A script often carries on after a failed write and exits 0.
			return ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `${escape}; echo still-going` }));
		},
		(context: any) => {
			results.push(lastToolResult(context));
			return ai.fauxAssistantMessage("Done.");
		},
	]);
	const spawned = spawn(team, "isolated", "worktree");
	assert.ok(spawned.ok, spawned.ok ? "" : spawned.error);
	const done = await team.whenDone("isolated");
	assert.equal(done.state, "idle", done.error);
	const tree = spawned.record.worktree!.path;
	assert.equal(readFileSync(join(tree, "inside.txt"), "utf8"), "inside\n");
	assert.equal(results[0], "ran\n");
	assert.deepEqual(commandsOf(team.messages("isolated")), ["echo inside > inside.txt && echo ran", escape, `${escape}; echo still-going`]);
	const sandboxed = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
	if (sandboxed) {
		assert.equal(existsSync(join(root, "escape.txt")), false, "the sandbox refused the write");
		assert.match(results[1] ?? "", /Operation not permitted[\s\S]*Command exited with code 1\nWrites outside your worktree are blocked\. .* is your parent's checkout/);
		assert.match(results[2] ?? "", /Operation not permitted[\s\S]*still-going[\s\S]*Writes outside your worktree are blocked\./);
	}
	assert.doesNotMatch(JSON.stringify(team.messages("isolated")), /PI_SUBAGENT_SANDBOX|sandbox-exec/);
	await team.close();
});

const running = (name: string) => ({ name, parent: "main", depth: 1, task: "Edit", model: "faux/cheap", readOnly: false, fork: false, blocking: false,
	state: "running" as const, createdAt: 1, activity: null, toolCalls: 0, usage: NO_USAGE, runs: 1 });

test("a shared child's bash call that changes files takes the free lock", { timeout: 30_000 }, async () => {
	const root = repository();
	const { team, faux, warnings } = await setup(root);
	team.restore([running("other")]);
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "echo new > new.txt" })),
		() => {
			assert.match(team.claimEdit("other", join(root, "other.txt")) ?? "", /^shell is editing files in this checkout/);
			return ai.fauxAssistantMessage("Done.");
		},
	]);
	assert.ok(spawn(team, "shell").ok);
	const done = await team.whenDone("shell");
	assert.equal(done.state, "idle", done.error);
	assert.deepEqual(warnings, []);
	await team.close();
});

test("a shared child's bash call that changes files beside the holder gets a note, and the user a warning", { timeout: 30_000 }, async () => {
	const root = repository();
	const { team, faux, warnings } = await setup(root);
	team.restore([running("holder")]);
	assert.equal(team.claimEdit("holder", join(root, "held.txt")), undefined);
	const results: string[] = [];
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "echo changed > tracked.txt && echo wrote" })),
		(context: any) => {
			results.push(lastToolResult(context));
			return ai.fauxAssistantMessage("Done.");
		},
	]);
	assert.ok(spawn(team, "shell").ok);
	const done = await team.whenDone("shell");
	assert.equal(done.state, "idle", done.error);
	assert.equal(results[0], "wrote\nThis command changed tracked.txt in this checkout while holder holds its edit lock. Don't change files here; tell main if you need a worktree (isolation: \"worktree\").");
	assert.deepEqual(warnings, ["subagents: shell's bash command changed tracked.txt in the shared checkout while holder holds its edit lock."]);
	assert.match(team.claimEdit("shell", join(root, "other.txt")) ?? "", /^holder is editing/, "the holder keeps the lock");
	await team.close();
});
