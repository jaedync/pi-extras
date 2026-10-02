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
const { childInstructions, REPORT_MAX_CHARS } = await import("../lib/subagents/format.ts");
const { MainMail } = await import("../lib/subagents/deliver.ts");

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

test("a long SDK report is saved in full and its completion message names that run's file", { timeout: 20_000 }, async () => {
	const { team, faux, main } = await setup();
	const full = "# Review\n\n" + "evidence 🍎\n".repeat(2_000) + "CRITICAL FINAL DETAIL";
	faux.setResponses([ai.fauxAssistantMessage(full), ai.fauxAssistantMessage("Follow-up complete.")]);
	try {
		assert.ok(team.spawn({ name: "long-report", task: "Review", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false }).ok);
		const first = await team.whenDone("long-report");
		assert.ok(first.reportFile?.endsWith("long-report.run-1.report.md"), first.reportFile);
		assert.equal(readFileSync(first.reportFile!, "utf8"), full);
		let completion = "";
		const mail = new MainMail({ batchMs: 0, port: { send: (message) => { completion = message.content; } } });
		mail.deliver(main.at(-1)!);
		await new Promise((resolve) => setTimeout(resolve, 20));
		mail.dispose();
		assert.ok(completion.includes(`Report: ${first.reportFile}`));
		assert.ok(completion.includes(`(report cut at ${REPORT_MAX_CHARS} characters. The whole report is in ${first.reportFile}.)`));
		assert.ok(!completion.includes("CRITICAL FINAL DETAIL"));
		await team.send("main", "long-report", "Follow up");
		const second = await team.whenDone("long-report");
		assert.ok(second.reportFile?.endsWith("long-report.run-2.report.md"), second.reportFile);
		assert.equal(readFileSync(second.reportFile!, "utf8"), "Follow-up complete.");
		assert.equal(readFileSync(first.reportFile!, "utf8"), full, "the older completion's file is unchanged");
	} finally {
		await team.close();
	}
});

test("/subagents report shows the latest saved path without adding a report tool", { timeout: 20_000 }, async () => {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
	const { default: extension } = await import("../extensions/subagents.ts");
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "cheap")!,
		settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch) });
	const notices: string[] = [];
	try {
		await session.bindExtensions({ mode: "print", uiContext: { notify: (text: string) => notices.push(text) } as never } as never);
		await session.prompt("/subagents report");
		assert.equal(notices.at(-1), "Usage: /subagents report <name>");
		await session.prompt("/subagents report missing");
		assert.equal(notices.at(-1), "No subagent named missing.");
		await session.prompt("/subagents nobody");
		assert.equal(notices.at(-1), "No subagent named nobody.", "a name that isn't an agent is a typo, not a request for the list");
		const tool = session.agent.state.tools.find((tool) => tool.name === "subagent")!;
		assert.ok(tool);
		assert.ok(!session.agent.state.tools.some((tool) => /report/.test(tool.name)));
		faux.setResponses([ai.fauxAssistantMessage("Full command report.")]);
		const result = await tool.execute("spawn", { name: "command-report", task: "Report", wait: true }) as { content: Array<{ text: string }> };
		const path = result.content[0]!.text.match(/\nReport: (.+)/)?.[1];
		assert.ok(path, result.content[0]!.text);
		await session.prompt("/subagents report command-report");
		assert.equal(notices.at(-1), `Report for command-report: ${path}`);
		assert.equal(readFileSync(path, "utf8"), "Full command report.");
		faux.setResponses([ai.fauxAssistantMessage("")]);
		const restored = await tool.execute("restored", { name: "restored-report", task: "Report", wait: true }) as { details: { sessionFile: string } };
		const base = restored.details.sessionFile.replace(/\.jsonl$/, "");
		writeFileSync(`${base}.run-2.report.md`, "older");
		writeFileSync(`${base}.run-10.report.md`, "latest restored report");
		await session.prompt("/subagents report restored-report");
		assert.equal(notices.at(-1), `Report for restored-report: ${base}.run-10.report.md`);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
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

test("a recreated team reopens a finished child session when main messages it", { timeout: 20_000 }, async () => {
	const first = await setup();
	first.faux.setResponses([ai.fauxAssistantMessage("Remember restoration-token-42.")]);
	first.team.spawn({ name: "restore-child", task: "Remember this", parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	const record = await first.team.whenDone("restore-child");
	await first.team.close();
	const second = await setup();
	second.team.restore([{ ...record, restored: true }]);
	second.faux.setResponses([(context: any) => ai.fauxAssistantMessage(JSON.stringify(context.messages).includes("restoration-token-42") ? "Context restored." : "Context lost.")]);
	assert.deepEqual(await second.team.send("main", "restore-child", "What do you remember?"), { ok: true, delivered: "resumed" });
	const done = await second.team.whenDone("restore-child");
	assert.equal(done.report, "Context restored.");
	assert.equal(done.runs, 2);
	await second.team.close();
});

test("a real SDK child interrupted before its first prompt gets its complete original brief", { timeout: 20_000 }, async () => {
	const { team, faux } = await setup();
	team.restore([{ name: "unstarted", parent: "main", depth: 1, task: "THE COMPLETE ORIGINAL SDK BRIEF", model: "faux/cheap",
		readOnly: false, fork: false, blocking: false, state: "interrupted", createdAt: Date.now(), activity: "queued", runs: 0,
		toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, restored: true,
		sessionFile: join(agentDir, "sessions", "subagents", "parent-1", "unstarted.jsonl") }]);
	faux.setResponses([(context: any) => ai.fauxAssistantMessage(JSON.stringify(context.messages).includes("THE COMPLETE ORIGINAL SDK BRIEF") && JSON.stringify(context.messages).includes("last tool call may not have completed") ? "Received original brief and warning." : "Brief missing.")]);
	await team.send("main", "unstarted", "Continue");
	assert.equal((await team.whenDone("unstarted")).report, "Received original brief and warning.");
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

test("the real parent SDK reload rebuilds its roster, resumes running children, and appends one notice", { timeout: 20_000 }, async () => {
	const { fileURLToPath } = await import("node:url");
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const model = faux.getModel("cheap");
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/subagents.ts", import.meta.url))] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model,
		resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.create(scratch, join(scratch, "parents")) });
	try {
		await session.bindExtensions({ mode: "print", onError: (error: unknown) => { throw error; } } as never);
		const spawn = () => session.agent.state.tools.find((tool: any) => tool.name === "subagent")!;
		faux.setResponses([ai.fauxAssistantMessage("Finished child report.")]);
		await spawn().execute("spawn-finished", { name: "finished", task: "Finish now", model: "faux/cheap" }, undefined);
		const dir = join(agentDir, "sessions", "subagents", session.sessionManager.getSessionId());
		const index = () => JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
		for (let i = 0; i < 200 && index().records[0]?.state !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(index().records[0]?.state, "idle");
		faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "sleep 30" }))]);
		await spawn().execute("spawn-running", { name: "running", task: "Wait for work", model: "faux/cheap" }, undefined);
		for (let i = 0; i < 800 && !index().records.some((r: any) => r.activity === "bash sleep 30"); i++) await new Promise((r) => setTimeout(r, 10));
		assert.ok(index().records.some((r: any) => r.activity === "bash sleep 30"));
		faux.setResponses([ai.fauxAssistantMessage("Reload resumed me.")]);
		await session.reload();
		for (let i = 0; i < 200 && index().records.find((r: any) => r.name === "running")?.state !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(index().records.length, 2);
		assert.equal(index().records.find((r: any) => r.name === "running")?.report, "Reload resumed me.");
		const notices = session.messages.filter((m: any) => m.role === "custom" && m.customType === "subagent-restore");
		assert.equal(notices.length, 1);
		assert.match(JSON.stringify(notices), /Auto-resuming.*running.*Wait for work.*bash sleep 30/);
		faux.setResponses([ai.fauxAssistantMessage("Finished child reached.")]);
		const message = session.agent.state.tools.find((tool: any) => tool.name === "message")!;
		const result = await message.execute("message-finished", { to: "finished", text: "Answer again" }, undefined);
		assert.equal((result.details as any).delivered, "resumed");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
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

test("a resumed SDK run still saves its report after compaction shrinks its messages", { timeout: 20_000 }, async () => {
	const settingsFile = join(agentDir, "settings.json");
	writeFileSync(settingsFile, JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 } }));
	for (const part of ["a", "b", "c"]) writeFileSync(join(scratch, `report-${part}.txt`), `${part} `.repeat(6_000));
	const { team, faux } = await setup([{ id: "report-tiny", contextWindow: 8_000 }]);
	try {
		faux.setResponses(Array.from({ length: 12 }, (_, i) => ai.fauxAssistantMessage(`Seed report ${i}.`)));
		team.spawn({ name: "compact-report", task: "Seed context", parent: "main", model: "faux/report-tiny", readOnly: false, fork: false, blocking: false });
		await team.whenDone("compact-report");
		for (let i = 1; i < 12; i++) { await team.send("main", "compact-report", `Seed turn ${i}`); await team.whenDone("compact-report"); }
		const before = team.messages("compact-report").length;
		const full = "Final report after compaction, with all critical details.";
		let reads = 0;
		const step = (context: any) => {
			if (JSON.stringify(context).includes("context summarization assistant")) return ai.fauxAssistantMessage("## Goal\nRead three report files.");
			reads++;
			return reads <= 3 ? ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: join(scratch, `report-${"abc"[reads - 1]}.txt`) })) : ai.fauxAssistantMessage(full);
		};
		faux.setResponses(Array.from({ length: 12 }, () => step));
		await team.send("main", "compact-report", "Read all three files and report.");
		const done = await team.whenDone("compact-report");
		assert.equal(done.state, "idle", done.error);
		const entries = readFileSync(done.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(entries.some((entry) => entry.type === "compaction"));
		assert.ok(team.messages("compact-report").length < before, "Pi shortened the messages below the run's former start position");
		assert.equal(done.report, full);
		assert.ok(done.reportFile?.endsWith(".run-13.report.md"), done.reportFile);
		assert.equal(readFileSync(done.reportFile!, "utf8"), full);
	} finally { rmSync(settingsFile, { force: true }); await team.close(); }
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
