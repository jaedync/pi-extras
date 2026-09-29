/** Real child sessions from the pinned SDK, driven by Pi's faux provider. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "subagents-sdk-"));
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
const { childMessageTool } = await import("../lib/subagents/tools.ts");
const { childInstructions } = await import("../lib/subagents/format.ts");

type Delivery = import("../lib/subagents/types.ts").MainDelivery;

async function setup() {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const main: Delivery[] = [];
	let tools: any;
	const team = new Team({
		maxConcurrent: 2, maxDepth: 1, replyTimeoutMs: 5_000,
		sessionFileFor: (name) => join(agentDir, "sessions", "subagents", "parent-1", `${name}.jsonl`),
		deliverToMain: (delivery) => main.push(delivery),
		launcher: createLauncher({
			sdk: sdk as never, agentDir, cwd: scratch, sessionDir: join(agentDir, "sessions", "subagents", "parent-1"),
			modelRuntime: async () => runtime,
			toolsFor: (record) => ({ tools: ["read"], customTools: [childMessageTool(tools, record.name)] }),
			instructions: (record) => childInstructions({ name: record.name, parent: record.parent, readOnly: false, canSpawn: false, roster: "" }),
		}),
	});
	tools = { team, replyTimeoutMs: 5_000 };
	return { team, faux, main };
}

const lastToolResult = (context: any): string => {
	const result = [...context.messages].reverse().find((message: any) => message.role === "toolResult");
	return result?.content?.map((part: any) => part.text ?? "").join("") ?? "";
};

test("a child session runs on its model, messages main, and reports", { timeout: 20_000 }, async () => {
	const { team, faux, main } = await setup();
	let sawInstructions = false;
	faux.setResponses([
		(context: any) => {
			sawInstructions = JSON.stringify(context).includes('You are the subagent \\"count-files\\"');
			return ai.fauxAssistantMessage(ai.fauxToolCall("message", { to: "main", text: "halfway there" }));
		},
		ai.fauxAssistantMessage("Counted 3 files."),
	]);
	const spawned = team.spawn({ task: "Count files", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	assert.ok(spawned.ok);
	const done = await team.whenDone("count-files");
	assert.equal(done.state, "idle", done.error);
	assert.equal(done.report, "Counted 3 files.");
	assert.equal(done.toolCalls, 1);
	assert.ok(sawInstructions, "child instructions reach the system prompt");
	assert.deepEqual(main.map((d) => d.kind), ["note", "report"]);
	assert.ok(done.sessionFile?.endsWith("/parent-1/count-files.jsonl"), done.sessionFile);
	assert.ok(existsSync(done.sessionFile!), "the child session is persisted where the spawn said");
	assert.equal(done.contextWindow, 100_000);
	await team.close();
});

test("a child blocks on a question until main answers, then uses the answer", { timeout: 20_000 }, async () => {
	const { team, faux, main } = await setup();
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("message", { to: "main", text: "Which branch?", expectReply: true })),
		(context: any) => ai.fauxAssistantMessage(`Using: ${lastToolResult(context).split("\n")[1]}`),
	]);
	team.spawn({ task: "Pick a branch", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	for (let i = 0; i < 100 && team.get("pick-branch")?.state !== "asking"; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(team.get("pick-branch")?.state, "asking");
	assert.deepEqual(main.at(-1), { kind: "question", from: "pick-branch", text: "Which branch?" });
	await team.send("main", "pick-branch", "release/2.0");
	const done = await team.whenDone("pick-branch");
	assert.equal(done.report, "Using: release/2.0");
	await team.close();
});

test("main resumes a finished child, which keeps its context", { timeout: 20_000 }, async () => {
	const { team, faux } = await setup();
	faux.setResponses([
		ai.fauxAssistantMessage("The secret is 42."),
		(context: any) => {
			const seen = context.messages.some((message: any) => JSON.stringify(message.content ?? "").includes("The secret is 42."));
			return ai.fauxAssistantMessage(seen ? "I still remember 42." : "I forgot.");
		},
	]);
	team.spawn({ task: "Remember a secret", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	await team.whenDone("remember-secret");
	assert.deepEqual(await team.send("main", "remember-secret", "What was it?"), { ok: true, delivered: "resumed" });
	await new Promise((r) => setTimeout(r, 50));
	const done = await team.whenDone("remember-secret");
	assert.equal(done.report, "I still remember 42.");
	assert.equal(done.runs, 2);
	await team.close();
});

test("an unknown model fails the child, not the session", { timeout: 20_000 }, async () => {
	const { team, main } = await setup();
	team.spawn({ task: "anything", parent: "main", model: "faux/nope", readOnly: false, fork: false, blocking: false });
	const done = await team.whenDone("anything");
	assert.equal(done.state, "failed");
	assert.equal(main.at(-1)?.kind, "report");
	await team.close();
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
