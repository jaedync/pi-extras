/** Offline real-SDK recovery, canonical history and normal terminal input. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
import { Type } from "typebox";

const scratch = mkdtempSync(join(tmpdir(), "rate-limit-sdk-"));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { default: recovery } = await import("../extensions/rate-limit-recovery.ts");
const { fullscreen } = await import("./support/fullscreen.ts");

const NOW = Date.parse("2026-09-30T02:00:00Z");
const errorBody = (seconds = 1) => JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "synthetic quota rejection", retry_after: seconds } });
const rejected = (seconds = 1) => ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: errorBody(seconds) });

async function setup(options: { autoWait?: boolean; mode?: "tui" | "print"; realWait?: boolean; retry?: boolean; maxRecoveries?: number; sideEffect?: () => void; terminalInput?: (listener: (data: string) => any) => () => void } = {}) {
	const agentDir = mkdtempSync(join(scratch, "case-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ rateLimitRecovery: { autoWait: options.autoWait ?? true, resumeMarginSeconds: 0, maxRecoveries: options.maxRecoveries ?? 3 } }));
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
	const faux = ai.fauxProvider({ provider: "recovery-fixture", models: [{ id: "claude-opus" }, { id: "claude-sonnet" }, { id: "gpt-other" }] });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: options.retry ?? true, maxRetries: 3, baseDelayMs: 1 } } as never);
	let now = NOW;
	let signalStarted!: () => void;
	const started = new Promise<void>((resolve) => { signalStarted = resolve; });
	let finish!: () => void;
	const loader = new sdk.DefaultResourceLoader({
		cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			...(options.sideEffect ? [{ name: "action-fixture", factory: (pi: any) => pi.registerTool({
				name: "record_action", label: "Record action", description: "Synthetic action counter.", parameters: Type.Object({}),
				execute: async () => { options.sideEffect!(); return { content: [{ type: "text", text: "Recorded." }], details: {} }; },
			}) }] : []),
			{ name: "recovery-fixture", factory: (pi) => recovery(pi, { configFile, env: {}, now: () => now,
			wait: async (ms, signal) => {
				signalStarted();
				if (!options.realWait) { now += ms + 234; return true; }
				return new Promise<boolean>((resolve) => {
					finish = () => { now += ms + 234; resolve(true); };
					signal.addEventListener("abort", () => resolve(false), { once: true });
				});
			},
		}) }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: faux.getModel("claude-opus"), settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: options.sideEffect ? "builtin" : "all" });
	const events: any[] = [];
	const errors: unknown[] = [];
	session.subscribe((event) => events.push(event));
	await session.bindExtensions({ mode: options.mode ?? "tui", uiContext: { notify() {}, setWidget() {}, onTerminalInput: options.terminalInput ?? (() => () => {}) } as never, onError: (error: unknown) => errors.push(error) } as never);
	return {
		session, faux, events, errors, started,
		finish: () => finish(),
		async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); },
	};
}

for (const retry of [true, false]) test(`real SDK persists note before exactly one resumed request (native retry ${retry})`, { timeout: 10_000 }, async () => {
	const f = await setup({ retry });
	try {
		let seen: any;
		f.faux.setResponses([rejected(), (context: any) => { seen = context; return ai.fauxAssistantMessage("Recovered."); }]);
		await f.session.prompt("Continue the task.");
		assert.equal(f.faux.state.callCount, 2);
		assert.equal(f.session.getLastAssistantText(), "Recovered.");
		assert.deepEqual(f.errors, []);
		assert.equal(f.events.filter((e) => e.type === "auto_retry_start").length, 0, "only one retry owner");
		assert.match(JSON.stringify(seen.messages), /1.234 seconds/);
		assert.match(JSON.stringify(seen.messages), /Paused at: 2026-09-30T02:00:00.000Z/);
		assert.match(JSON.stringify(seen.messages), /Resumed at: 2026-09-30T02:00:01.234Z/);
		const raw = f.session.sessionManager.getEntries();
		const noteIndex = raw.findIndex((entry: any) => entry.type === "custom_message" && entry.customType === "rate-limit-recovery");
		const responseIndex = raw.findIndex((entry: any) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop");
		assert.ok(noteIndex >= 0 && noteIndex < responseIndex, "canonical note precedes resumed response");
		assert.equal(raw.filter((entry: any) => entry.type === "custom_message" && entry.customType === "rate-limit-recovery").length, 1);
		assert.ok(!f.session.messages.some((message: any) => message.role === "assistant" && message.stopReason === "error"), "failed partial assistant omitted only from projection");
		assert.ok(raw.some((entry: any) => entry.type === "message" && entry.message.stopReason === "error"), "raw failure retained");
	} finally { await f.close(); }
});

test("ordinary transient failures retain native retry ownership", { timeout: 10_000 }, async () => {
	const f = await setup();
	try {
		f.faux.setResponses([ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 temporary upstream failure" }), ai.fauxAssistantMessage("Native retry recovered.")]);
		await f.session.prompt("Work.");
		assert.equal(f.faux.state.callCount, 2);
		assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 1);
		assert.ok(!f.session.messages.some((message: any) => message.customType === "rate-limit-recovery"));
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const delivery of ["steer", "followUp"] as const) test(`queued ${delivery} preserves Pi queue semantics with one recovery`, { timeout: 10_000 }, async () => {
	const f = await setup({ realWait: true });
	try {
		let seenRetry = ""; let seenFollowUp = "";
		f.faux.setResponses([
			rejected(),
			(context: any) => { seenRetry = JSON.stringify(context.messages); return ai.fauxAssistantMessage("Original task complete."); },
			(context: any) => { seenFollowUp = JSON.stringify(context.messages); return ai.fauxAssistantMessage("Follow-up complete."); },
		]);
		const run = f.session.prompt("Original task."); await f.started;
		await f.session[delivery]("New user instructions.");
		f.finish(); await run;
		assert.equal(f.faux.state.callCount, delivery === "steer" ? 2 : 3);
		assert.match(seenRetry, /1.234 seconds/);
		if (delivery === "steer") assert.match(seenRetry, /New user instructions/);
		else {
			assert.doesNotMatch(seenRetry, /New user instructions/);
			assert.match(seenFollowUp, /New user instructions/);
		}
		assert.equal(f.session.messages.filter((message: any) => message.customType === "rate-limit-recovery").length, 1);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("completed side effects are not replayed, and incomplete quota tool calls never execute", { timeout: 10_000 }, async () => {
	let actions = 0;
	const f = await setup({ sideEffect: () => actions++ });
	try {
		f.faux.setResponses([
			ai.fauxAssistantMessage(ai.fauxToolCall("record_action", {})),
			ai.fauxAssistantMessage(ai.fauxToolCall("record_action", {}), { stopReason: "error", errorMessage: errorBody() }),
			ai.fauxAssistantMessage("Recovered without replay."),
		]);
		await f.session.prompt("Perform one action.");
		assert.equal(f.faux.state.callCount, 3);
		assert.equal(actions, 1);
		assert.equal(f.session.messages.filter((message: any) => message.role === "toolResult").length, 1);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("default-off detection stops fast instead of repeating known quota failures", { timeout: 10_000 }, async () => {
	const f = await setup({ autoWait: false });
	try {
		f.faux.setResponses([rejected(), ai.fauxAssistantMessage("Must not run.")]);
		await f.session.prompt("Work.");
		assert.equal(f.faux.state.callCount, 1);
		assert.match((f.session.messages.at(-1) as any).errorMessage, /waiting is off/i);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("noninteractive child-like session fails immediately with reset guidance despite global opt-in", { timeout: 10_000 }, async () => {
	const f = await setup({ mode: "print" });
	try {
		f.faux.setResponses([rejected(9905), ai.fauxAssistantMessage("Must not run.")]);
		await f.session.prompt("Review.");
		assert.equal(f.faux.state.callCount, 1);
		const failure = (f.session.messages.at(-1) as any).errorMessage;
		assert.match(failure, /recovery-fixture/);
		assert.match(failure, /2026-09-30T04:45:05.000Z/);
		assert.match(failure, /9905 seconds/);
		assert.match(failure, /never.*wait/i);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("model selected during the wait is used for the resumed request", { timeout: 10_000 }, async () => {
	const f = await setup({ realWait: true });
	try {
		let resumedModel = "";
		f.faux.setResponses([rejected(), (_context: any, _options: any, _state: any, model: any) => { resumedModel = model.id; return ai.fauxAssistantMessage("Resumed."); }]);
		const run = f.session.prompt("Work.");
		await f.started;
		await f.session.setModel(f.faux.getModel("claude-sonnet"));
		f.finish(); await run;
		assert.equal(resumedModel, "claude-sonnet");
		assert.equal(f.faux.state.callCount, 2);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

for (const key of ["\x1b", "\x03"]) test(`real TUI input ${JSON.stringify(key)} aborts cooldown through an overlay without retry`, { timeout: 10_000 }, async () => {
	const scene = fullscreen();
	const f = await setup({ realWait: true, terminalInput: (listener) => scene.tui.addInputListener(listener) });
	try {
		f.faux.setResponses([rejected(), ai.fauxAssistantMessage("Must not run.")]);
		const run = f.session.prompt("Work.");
		await f.started;
		const overlayKeys: string[] = [];
		scene.tui.showOverlay({ render: () => ["Overlay owns focus"], invalidate() {}, handleInput(data) { overlayKeys.push(data); } });
		scene.key(key);
		await run;
		assert.equal(f.faux.state.callCount, 1);
		assert.deepEqual(overlayKeys, key === "\x03" ? [] : ["\x1b"], "Ctrl+C is consumed; Escape falls through after cancelling");
		assert.ok(!f.session.messages.some((message: any) => message.customType === "rate-limit-recovery"));
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); scene.stop(); }
});

test("repeated quota errors stop after a bounded number of recovery attempts", { timeout: 10_000 }, async () => {
	const f = await setup({ maxRecoveries: 2 });
	try {
		f.faux.setResponses([rejected(), rejected(), rejected(), ai.fauxAssistantMessage("Must not run.")]);
		await f.session.prompt("Work.");
		assert.equal(f.faux.state.callCount, 3);
		assert.match((f.session.messages.at(-1) as any).errorMessage, /recovery limit/i);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("a failure before context preparation cannot repeat a consumed continuation", { timeout: 10_000 }, async () => {
	const f = await setup();
	try {
		const prepare = f.session.agent.prepareRequest;
		let prepared = 0;
		f.session.agent.prepareRequest = async (...args: Parameters<NonNullable<typeof prepare>>) => {
			if (++prepared > 1) throw new Error("synthetic preparation failure");
			const result = await prepare?.(...args);
			return result || undefined;
		};
		f.faux.setResponses([rejected(), ai.fauxAssistantMessage("Must not run.")]);
		await f.session.prompt("Work.");
		assert.equal(prepared, 2);
		assert.equal(f.faux.state.callCount, 1);
		assert.match((f.session.messages.at(-1) as any).errorMessage, /synthetic preparation failure/);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
