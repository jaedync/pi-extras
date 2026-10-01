/** Real parent and child SDK sessions, isolated from account settings and providers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "restore-sdk-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
mkdirSync(agentDir, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;

async function fixture() {
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "restore-faux", models: [{ id: "cheap", contextWindow: 100_000 }, { id: "other", contextWindow: 100_000 }] });
	runtime.registerNativeProvider(faux.provider);
	const open = async (file?: string, notices: string[] = [], options: { cwd?: string; model?: string; unscoped?: boolean } = {}) => {
		const cwd = options.cwd ?? scratch;
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../extensions/subagents.ts", import.meta.url))] });
		await loader.reload();
		const manager = file ? sdk.SessionManager.open(file, join(scratch, "parents"), scratch) : sdk.SessionManager.create(scratch, join(scratch, "parents"));
		if (!file) manager.appendMessage(ai.fauxAssistantMessage("Parent fixture."));
		const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(options.model ?? "cheap"),
			scopedModels: options.unscoped ? [] : [{ model: faux.getModel(options.model ?? "cheap") }],
			settingsManager, resourceLoader: loader, sessionManager: manager });
		await session.bindExtensions({ mode: "print", uiContext: { notify: (text: string) => notices.push(text) } } as never);
		return session;
	};
	return { faux, open };
}
const tool = (session: any, name: string) => session.agent.state.tools.find((t: any) => t.name === name);
const close = async (session: any) => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); };
const wait = async (condition: () => boolean) => {
	for (let i = 0; i < 800 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(condition(), "state transition completed");
};

test("a recreated parent notifies without requesting the provider, then message reopens the interrupted child", { timeout: 20_000 }, async () => {
	const { faux, open } = await fixture();
	const first = await open();
	const file = first.sessionFile!;
	const dir = join(agentDir, "sessions", "subagents", first.sessionManager.getSessionId());
	const index = () => JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
	try {
		faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "sleep 30" }))]);
		await tool(first, "subagent").execute("spawn", { name: "paused", task: "Inspect the workspace", model: "restore-faux/cheap" });
		await wait(() => index().records[0]?.activity === "bash sleep 30");
		await close(first);
		const calls = faux.state.callCount;
		const second = await open(file);
		try {
			assert.equal(faux.state.callCount, calls, "startup does not auto-resume");
			assert.equal(index().records[0]?.state, "interrupted");
			const notices = second.messages.filter((m: any) => m.role === "custom" && m.customType === "subagent-restore");
			assert.equal(notices.length, 1);
			await second.reload();
			assert.equal(faux.state.callCount, calls, "a later reload must not resume the earlier crash/quit interruption");
			assert.equal(second.messages.filter((m: any) => m.customType === "subagent-restore").length, 1, "the same interruption is not announced twice");
			assert.match(JSON.stringify(notices), /Not resumed.*paused.*Inspect the workspace.*bash sleep 30/);
			faux.setResponses([(ctx: any) => ai.fauxAssistantMessage(JSON.stringify(ctx.messages).includes("last tool call may not have completed") ? "Verified before continuing." : "Warning missing.")]);
			await tool(second, "message").execute("resume", { to: "paused", text: "Continue" });
			await wait(() => index().records[0]?.state === "idle");
			assert.equal(index().records[0]?.report, "Verified before continuing.");
			assert.equal(index().records[0]?.runs, 2);
		} finally { await close(second); }
	} finally { await close(first); }
});

test("a second real SDK parent cannot steal another live parent's child registry", { timeout: 20_000 }, async () => {
	const { faux, open } = await fixture();
	const first = await open();
	try {
		faux.setResponses([ai.fauxAssistantMessage("Saved")]);
		await tool(first, "subagent").execute("spawn", { name: "reserved", task: "Save work", model: "restore-faux/cheap" });
		const warnings: string[] = [];
		const second = await open(first.sessionFile!, warnings);
		try {
			assert.equal(tool(second, "subagent"), undefined);
			assert.match(warnings.join("\n"), /already owned by process/);
			assert.ok(tool(first, "message"), "first parent retains control");
		} finally { await close(second); }
	} finally { await close(first); }
});

test("always makes at most one automatic attempt, even if that attempt is interrupted", { timeout: 25_000 }, async () => {
	const { writeFileSync, unlinkSync } = await import("node:fs");
	writeFileSync(join(agentDir, "pi-extras.json"), JSON.stringify({ subagents: { resumePolicy: "always" } }));
	const { faux, open } = await fixture();
	const sessions: any[] = [];
	try {
		const first = await open(); sessions.push(first);
		const file = first.sessionFile!;
		const index = () => JSON.parse(readFileSync(join(agentDir, "sessions", "subagents", first.sessionManager.getSessionId(), "index.json"), "utf8"));
		faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "sleep 30" }))]);
		await tool(first, "subagent").execute("first", { name: "one-attempt", task: "Original complete brief", model: "restore-faux/cheap" });
		await wait(() => index().records[0]?.activity === "bash sleep 30");
		await close(first);
		faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "sleep 30" }))]);
		const second = await open(file); sessions.push(second);
		await wait(() => index().records[0]?.runs === 2 && index().records[0]?.activity === "bash sleep 30");
		await close(second);
		const calls = faux.state.callCount;
		const third = await open(file); sessions.push(third);
		assert.equal(faux.state.callCount, calls);
		assert.equal(index().records[0]?.autoResumeAttempts, 1);
		assert.equal(index().records[0]?.state, "interrupted");
		await third.reload();
		assert.equal(faux.state.callCount, calls);
	} finally { for (const session of sessions) await close(session); unlinkSync(join(agentDir, "pi-extras.json")); }
});

test("an out-of-scope child pauses, a moved workspace warns once, and explicit resume uses the current default and cwd", { timeout: 20_000 }, async () => {
	const { writeFileSync } = await import("node:fs");
	const { ChildIndex } = await import("../lib/subagents/restore.ts");
	const { NO_USAGE } = await import("../lib/subagents/types.ts");
	const { faux, open } = await fixture();
	const first = await open();
	const file = first.sessionFile!;
	const dir = join(agentDir, "sessions", "subagents", first.sessionManager.getSessionId());
	await close(first);
	const child = join(dir, "saved.jsonl");
	const manager = sdk.SessionManager.open(child, dir, scratch);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Original task" }], timestamp: Date.now() });
	manager.appendMessage(ai.fauxAssistantMessage("Prior result."));
	new ChildIndex(dir, first.sessionManager.getSessionId(), scratch).save([{ name: "saved", parent: "main", depth: 1, model: "restore-faux/cheap", task: "Original task",
		readOnly: false, fork: false, blocking: false, state: "interrupted", createdAt: 1, activity: "bash", runs: 1, toolCalls: 0, usage: NO_USAGE,
		sessionFile: child, interruptedBy: "signal", interruptionId: "saved-interruption" }]);
	writeFileSync(join(dir, "invalid.jsonl"), "not a Pi session");
	writeFileSync(join(dir, "empty.jsonl"), "");
	const moved = join(scratch, "moved"); mkdirSync(moved);
	const warnings: string[] = [];
	const second = await open(file, warnings, { cwd: moved, model: "other", unscoped: true });
	try {
		assert.equal(faux.state.callCount, 0);
		assert.ok(tool(second, "subagent"), "bad child files do not disable the extension");
		assert.equal(readFileSync(join(dir, "empty.jsonl"), "utf8"), "");
		await second.reload();
		assert.equal(warnings.filter((warning) => warning.includes("workspace changed")).length, 1);
		faux.setResponses([(context: any) => ai.fauxAssistantMessage(JSON.stringify(context.messages).includes("current default restore-faux/other") && JSON.stringify(context.messages).includes("workspace moved") ? "Default and workspace verified." : "Missing guidance.")]);
		const result = await tool(second, "message").execute("resume", { to: "saved", text: "Continue" });
		assert.match(JSON.stringify(result.content), /Model restore-faux\/cheap is not available now, running on restore-faux\/other/);
		assert.ok(warnings.some((warning) => warning.includes("Model restore-faux/cheap is not available now, running on restore-faux/other")));
		await wait(() => JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).records[0]?.state === "idle");
		const restored = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).records[0];
		assert.equal(restored.model, "restore-faux/other");
		assert.equal(restored.report, "Default and workspace verified.");
	} finally { await close(second); }
});

test("missing-session resume launches remain retryable and get their own run-log entries", { timeout: 20_000 }, async () => {
	const { unlinkSync, writeFileSync } = await import("node:fs");
	const { faux, open } = await fixture();
	const first = await open();
	const file = first.sessionFile!;
	const dir = join(agentDir, "sessions", "subagents", first.sessionManager.getSessionId());
	const index = () => JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
	faux.setResponses([ai.fauxAssistantMessage("Initial report.")]);
	await tool(first, "subagent").execute("spawn", { name: "retryable", task: "Keep my work", model: "restore-faux/cheap" });
	await wait(() => index().records[0]?.state === "idle");
	const childFile = index().records[0].sessionFile;
	const transcript = readFileSync(childFile, "utf8");
	await close(first);
	unlinkSync(childFile);
	const second = await open(file);
	try {
		await tool(second, "message").execute("missing", { to: "retryable", text: "Continue" });
		await wait(() => index().records[0]?.state === "interrupted" && !!index().records[0]?.launchError);
		assert.match(index().records[0].error, /session is missing/);
		const rows = readFileSync(join(agentDir, "subagents", "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const failure = rows.filter((row) => row.parentSession === first.sessionManager.getSessionId() && row.event === "resume_launch_failed");
		assert.equal(failure.length, 1);
		assert.equal(failure[0].launchAttempt, 1);
		assert.equal(failure[0].usage.cost, 0, "a launch failure does not charge the previous run again");
		writeFileSync(childFile, transcript);
		faux.setResponses([ai.fauxAssistantMessage("Retry succeeded.")]);
		await tool(second, "message").execute("retry", { to: "retryable", text: "Try again" });
		await wait(() => index().records[0]?.state === "idle");
		assert.equal(index().records[0]?.report, "Retry succeeded.");
	} finally { await close(second); }
});

test("restoration filesystem warnings use Pi's notification channel, never stderr", { timeout: 20_000, skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
	const { chmodSync } = await import("node:fs");
	const { faux, open } = await fixture();
	const first = await open();
	const file = first.sessionFile!;
	const dir = join(agentDir, "sessions", "subagents", first.sessionManager.getSessionId());
	const index = () => JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
	faux.setResponses([ai.fauxAssistantMessage("Done.")]);
	await tool(first, "subagent").execute("spawn", { name: "saved", task: "Keep my work", model: "restore-faux/cheap" });
	await wait(() => index().records[0]?.state === "idle");
	await close(first);
	const original = console.warn;
	const warnings: string[] = [];
	let second: Awaited<ReturnType<typeof open>> | undefined;
	try {
		chmodSync(dir, 0o300);
		console.warn = () => assert.fail("restoration must not write to stderr");
		second = await open(file, warnings);
		assert.equal(index().records[0]?.restored, true);
		assert.equal(warnings.filter((warning) => warning.includes(`could not inspect ${dir}`)).length, 1);
	} finally {
		console.warn = original;
		chmodSync(dir, 0o700);
		if (second) await close(second);
	}
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
