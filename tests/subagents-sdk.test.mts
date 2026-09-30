/** Real child sessions from the pinned SDK, driven by Pi's faux provider. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function setup(models: Array<{ id: string; contextWindow: number }> = [{ id: "cheap", contextWindow: 100_000 }]) {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models });
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

test("a child runs only the extensions that own its tools; another extension's factory never runs with the child's API", { timeout: 20_000 }, async () => {
	// An extension like remote-pi keeps module-level state that its factory rebinds to whichever
	// session called it last, so running its factory for a child steals the parent's messages.
	const extAgentDir = join(scratch, "agent-extensions");
	const extDir = join(scratch, "extensions");
	mkdirSync(extDir, { recursive: true });
	const factory = (label: string, tool: string, text: string) => `export default function (pi) {
	(globalThis.__childFactoryRuns ??= []).push(${JSON.stringify(label)});
	pi.registerTool({ name: ${JSON.stringify(tool)}, label: ${JSON.stringify(tool)}, description: "Synthetic test tool.",
		parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: ${JSON.stringify(text)} }], details: {} }; } });
}
`;
	const owner = join(extDir, "owner.js");
	const bystander = join(extDir, "bystander.js");
	writeFileSync(owner, factory("owner", "probe_tool", "probe-ok"));
	writeFileSync(bystander, factory("bystander", "agent_send", "never"));
	mkdirSync(extAgentDir, { recursive: true });
	writeFileSync(join(extAgentDir, "settings.json"), JSON.stringify({ extensions: [owner, bystander] }));
	const runs = ((globalThis as any).__childFactoryRuns = [] as string[]);
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const team = new Team({
		maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 5_000,
		deliverToMain: () => undefined,
		launcher: createLauncher({
			sdk: sdk as never, agentDir: extAgentDir, cwd: scratch, sessionDir: join(extAgentDir, "sessions"),
			modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: ["probe_tool"], customTools: [], extensionPaths: [owner] }),
			instructions: () => "",
		}),
	});
	faux.setResponses([
		ai.fauxAssistantMessage(ai.fauxToolCall("probe_tool", {})),
		(context: any) => ai.fauxAssistantMessage(lastToolResult(context)),
	]);
	assert.ok(team.spawn({ task: "Probe", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
	const done = await team.whenDone("probe");
	assert.equal(done.state, "idle", done.error);
	assert.equal(done.report, "probe-ok", "the owning extension's tool works in the child");
	assert.deepEqual(runs, ["owner"], "only the owner's factory ran for the child");
	await team.close();
});

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

test("a resumed child that answers main then keeps working wakes main with its report; one that stops does not", { timeout: 20_000 }, async () => {
	writeFileSync(join(scratch, "notes.txt"), "two files need fixes\n");
	const { team, faux, main } = await setup();
	faux.setResponses([
		ai.fauxAssistantMessage("First pass done."),
		ai.fauxAssistantMessage(ai.fauxToolCall("message", { to: "main", text: "Yes, starting now." })),
		ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: join(scratch, "notes.txt") })),
		ai.fauxAssistantMessage("Fixed both files."),
		ai.fauxAssistantMessage(ai.fauxToolCall("message", { to: "main", text: "It is notes.txt." })),
		ai.fauxAssistantMessage("It is notes.txt."),
	]);
	team.spawn({ task: "Review notes", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	await team.whenDone("review-notes");
	await team.send("main", "review-notes", "Fix the rest too?", { expectReply: true });
	await new Promise((r) => setTimeout(r, 50));
	const worked = await team.whenDone("review-notes");
	assert.equal(worked.report, "Fixed both files.");
	assert.deepEqual(main.map((d) => d.kind), ["report", "reply", "report"]);
	assert.equal(worked.answeredMain, undefined, "work after the answer makes the report wake main");
	await team.send("main", "review-notes", "Which file was it?", { expectReply: true });
	await new Promise((r) => setTimeout(r, 50));
	const answered = await team.whenDone("review-notes");
	assert.equal(answered.report, "It is notes.txt.");
	assert.deepEqual(main.slice(3).map((d) => d.kind), ["reply", "report"]);
	assert.equal(answered.answeredMain, true, "an answer followed only by the final text need not wake main twice");
	await team.close();
});

test("a message that lands while the child writes its final answer still gets handled", { timeout: 20_000 }, async () => {
	const { team, faux } = await setup();
	let releaseFinal!: () => void;
	const finalStarted = new Promise<void>((started) => {
		faux.setResponses([
			async () => {
				started();
				await new Promise<void>((release) => { releaseFinal = release; });
				return ai.fauxAssistantMessage("APPLE");
			},
			(context: any) => ai.fauxAssistantMessage(JSON.stringify(context.messages).includes("BANANA") ? "BANANA" : "no steer seen"),
		]);
	});
	team.spawn({ task: "Say a fruit", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	await finalStarted;
	assert.deepEqual(await team.send("main", "say-fruit", "Say BANANA instead."), { ok: true, delivered: "steered" });
	releaseFinal();
	const done = await team.whenDone("say-fruit");
	assert.equal(done.report, "BANANA");
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

test("with another extension's subagent tool, Subagents stands down entirely", { timeout: 20_000 }, async () => {
	const { fileURLToPath } = await import("node:url");
	const settingsManager = sdk.SettingsManager.inMemory();
	const notices: string[] = [];
	const loader = new sdk.DefaultResourceLoader({
		cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./fixtures/foreign-subagent.mjs", import.meta.url)),
			fileURLToPath(new URL("../extensions/subagents.ts", import.meta.url)),
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(scratch) });
	try {
		await session.bindExtensions({ uiContext: { notify: (text: string) => notices.push(text) } as never } as never);
		const names = session.agent.state.tools.map((tool) => tool.name);
		assert.equal(names.filter((name) => name === "subagent").length, 1);
		assert.ok(!names.includes("message"), "no stray message tool");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

test("a child compacts its own context when it fills up, and says so while it does", { timeout: 20_000 }, async () => {
	// Pi's own auto-compaction, from the user's settings, with a small window so three reads fill it.
	const settingsFile = join(agentDir, "settings.json");
	writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 } }));
	for (const part of ["a", "b", "c"]) writeFileSync(join(scratch, `${part}.txt`), `${part} `.repeat(6_000));
	const { team, faux } = await setup([{ id: "tiny", contextWindow: 8_000 }]);
	try {
		let reads = 0;
		const step = (context: any) => {
			if (JSON.stringify(context).includes("context summarization assistant")) return ai.fauxAssistantMessage("## Goal\nRead three files.");
			reads++;
			return reads <= 3 ? ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: join(scratch, `${"abc"[reads - 1]}.txt`) })) : ai.fauxAssistantMessage("Read all three.");
		};
		faux.setResponses(Array.from({ length: 10 }, () => step));
		const activities: string[] = [];
		let unknownAfterCompacting = false;
		team.onChange((record) => {
			if (record?.activity) activities.push(record.activity);
			if (activities.includes("compacting context") && record?.contextTokens === undefined && record?.state === "running") unknownAfterCompacting = true;
		});
		assert.ok(team.spawn({ task: "Read the files", parent: "main", model: "faux/tiny", readOnly: false, fork: false, blocking: false }).ok);
		const done = await team.whenDone("read-files");
		assert.equal(done.state, "idle", done.error);
		assert.equal(done.report, "Read all three.");
		const entries = readFileSync(done.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(entries.some((entry) => entry.type === "compaction"), "the child session holds a compaction");
		assert.ok(activities.includes("compacting context"), activities.join(", "));
		assert.ok(unknownAfterCompacting, "the old context size is dropped when compaction ends");
		// Three reads alone would overflow the 8k window. When Pi compacts after the last reply, the size is unknown.
		assert.ok(done.contextTokens === undefined || done.contextTokens < 8_000, `context after compaction: ${done.contextTokens}`);
	} finally {
		rmSync(settingsFile, { force: true });
		await team.close();
	}
});
