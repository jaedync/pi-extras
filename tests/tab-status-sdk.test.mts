import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
import tabStatus from "../extensions/tab-status.ts";
import { ChildIndex } from "../lib/subagents/restore.ts";
import { BACKGROUND_EVENT, RATE_WAIT_EVENT } from "../lib/tab-status/events.ts";
import { tuiReference } from "./support/tui-reference.ts";
import { createLauncher } from "../lib/subagents/child.ts";
import type { AgentRecord } from "../lib/subagents/types.ts";
import subagentsExtension from "../extensions/subagents.ts";
import cacheCompactionExtension from "../extensions/cache-compaction.ts";

const scratch = mkdtempSync(join(tmpdir(), "tab-status-sdk-"));
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const tui = await import("@earendil-works/pi-tui");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function provider(failing: () => boolean, writes: string[], cacheCalls: string[]) {
	return { api: "anthropic-messages", apiKey: "synthetic", baseUrl: "http://127.0.0.1:1", models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, context: any, options: any) {
			const stream = new ai.AssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.({ messages: structuredClone(context.messages), model: model.id, tools: [], max_tokens: 100 }, model);
				const cacheRequest = JSON.stringify(context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST");
				if (cacheRequest) cacheCalls.push(writes.findLast((w) => w.includes("]21337;")) ?? "");
				const done = context.messages.at(-1)?.role === "toolResult" || options.cacheRetention === "none" || cacheRequest;
				const content = failing() ? [] : done ? [{ type: "text", text: "Done.\nSecond line." }] : [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "printf tab-status" } }];
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: failing() ? "error" : done ? "stop" : "toolUse", errorMessage: failing() ? "fixture failure\nmore" : undefined, timestamp: Date.now(), usage };
				stream.push({ type: "start", partial: message });
				if (!failing() && !done) stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push(failing() ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message });
				stream.end();
			})();
			return stream;
		},
	};
}

async function fixture({ mode = "tui", hasUI = true, tty = true, native = false, env = { LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7.0" } as NodeJS.ProcessEnv, settings = {}, subagents = false, cacheCompaction = false } = {}) {
	let failing = false, eventBus: any, widget: any;
	const writes: string[] = [], errors: unknown[] = [], cacheCalls: string[] = [];
	const flushIdle = () => new Promise((resolve) => setTimeout(resolve, 20));
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const registerProvider = () => runtime.registerProvider("tab-fixture", provider(() => failing, writes, cacheCalls));
	registerProvider();
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 2000 }, cacheWarming: "off", retry: { enabled: false }, terminal: { showTerminalProgress: native } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir: join(scratch, "agent"), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => {
			eventBus = pi.events; tabStatus(pi, { env, isTTY: () => tty, settings, idleDelayMs: 10 });
			if (subagents) subagentsExtension(pi);
			if (cacheCompaction) cacheCompactionExtension(pi, { settingsManager });
		}] });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir: join(scratch, "agent"), modelRuntime: runtime, model: runtime.getModel("tab-fixture", "model"), thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch) });
	const theme = { colors: { accent: tui.rgbColor(1, 2, 3), warning: tui.rgbColor(4, 5, 6), dim: tui.rgbColor(7, 8, 9), error: tui.rgbColor(255, 0, 0) } };
	const terminal = { write: (bytes: string) => writes.push(bytes) };
	await session.bindExtensions({ mode, uiContext: hasUI ? { theme, notify() {}, setWidget: (_key: string, factory: any) => { widget = typeof factory === "function" ? factory(tuiReference({ terminal, requestRender() {} }), theme) : undefined; }, confirm: async () => true } : undefined, onError: (error: unknown) => errors.push(error) });
	await flushIdle();
	return { session, writes, errors, runtime, settingsManager, cacheCalls, flushIdle, registerProvider, get bus() { return eventBus; },
		async prompt(text: string) { await session.prompt(text); await flushIdle(); },
		async compact() { const result = await session.compact(); await flushIdle(); return result; },
		fail: (value: boolean) => { failing = value; }, render: () => widget?.render(80),
		changeTheme: () => { theme.colors.dim = tui.rgbColor(20, 30, 40); widget?.invalidate(); },
		async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); },
	};
}

test("real SDK: prompt, real bash tool, settlement, failure and next prompt emit terminal bytes", async (t) => {
	const f = await fixture(); t.after(() => f.close());
	assert.match(f.writes.join(""), /status=idle/); assert.deepEqual(f.render(), []);
	await f.prompt("Run one bash command.");
	const bytes = f.writes.join("");
	assert.match(bytes, /status=working.*detail=thinking/); assert.match(bytes, /detail=writing bash call/);
	assert.match(bytes, /detail=running bash/); assert.match(bytes, /status=idle.*detail=Done/);
	assert.match(bytes, /\x1b\]9;4;3\x07/);
	assert.ok(bytes.lastIndexOf("status=idle") > bytes.indexOf("detail=running bash"));
	f.fail(true); await f.prompt("Fail.");
	assert.match(f.writes.at(-1)!, /status=waiting.*indicator=#ff0000.*detail=Error: fixture failure/);
	assert.match(f.writes.at(-1)!, /\x1b\]9;4;2\x07/);
	f.fail(false); await f.prompt("Retry."); assert.match(f.writes.at(-1)!, /status=idle/);
	await f.compact(); assert.ok(f.writes.some((w) => w.includes("detail=compacting")));
	assert.match(f.writes.at(-1)!, /status=idle/); assert.deepEqual(f.errors, []);
	await f.close(); assert.match(f.writes.at(-1)!, /status=;indicator=;status-color=;detail=/);
	assert.match(f.writes.at(-1)!, /\x1b\]9;4;0\x07/);
});

test("real SDK Cache Compaction observes working before its in-hook model request", async (t) => {
	const f = await fixture({ cacheCompaction: true }); t.after(() => f.close());
	await f.prompt("Warm the cache."); await f.prompt("Recent work.");
	const result = await f.compact();
	assert.equal(result.details.cachePrefix, true);
	assert.ok(f.cacheCalls.length); assert.ok(f.cacheCalls.every((w) => w.includes("detail=compacting")));
	assert.deepEqual(f.errors, []);
});

test("real SDK reply detail is opt-in and restored only when requested", async (t) => {
	const f = await fixture({ settings: { detail: "reply" } }); t.after(() => f.close());
	await f.prompt("Reply."); assert.match(f.writes.at(-1)!, /detail=Done\./);
	await f.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	await f.flushIdle(); assert.match(f.writes.at(-1)!, /detail=Done\./);
});

test("real SDK reload hands off owned metadata and disabled successors clear exactly once", async (t) => {
	const settings: Record<string, unknown> = {};
	const f = await fixture({ settings }); t.after(() => f.close());
	await f.prompt("Own the tab."); const before = f.writes.length, oldRunner = f.session.extensionRunner;
	settings.enabled = false;
	await f.session.reload({ beforeSessionStart: async () => { assert.equal(f.writes.length, before, "reload shutdown must not send a status change"); } });
	assert.notEqual(f.session.extensionRunner, oldRunner);
	assert.equal(f.writes.length, before + 1);
	assert.match(f.writes.at(-1)!, /status=;indicator=;status-color=;detail=/);
	assert.match(f.writes.at(-1)!, /9;4;0/);
	await f.session.reload(); assert.equal(f.writes.length, before + 1);
	assert.deepEqual(f.errors, []);
});

test("real SDK public dialog events pause and resume a run", async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.extensionRunner.emit({ type: "agent_start" });
	await f.session.extensionRunner.createContext().ui.confirm("Allow bash?", "Permission");
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(f.writes.some((w) => w.includes("status=waiting") && w.includes("detail=Allow bash?") && w.includes("9;4;4;100")));
	assert.match(f.writes.at(-1)!, /status=working/); assert.deepEqual(f.errors, []);
});

test("idle tab follows the active theme without writing from render or invalidation", async (t) => {
	const f = await fixture(); t.after(() => f.close()); const before = f.writes.length;
	f.changeTheme(); assert.equal(f.writes.length, before); await f.flushIdle();
	assert.match(f.writes.at(-1)!, /indicator=#141e28/);
});

test("background events scoped to this session, keepalive, invalid payloads and reload reset", async (t) => {
	const f = await fixture(); t.after(() => f.close()); const sessionId = f.session.sessionManager.getSessionId();
	for (const payload of [null, { sessionId, source: "subagents", count: -1 }, { sessionId: "child", source: "subagents", count: 1 }]) f.bus.emit(BACKGROUND_EVENT, payload);
	assert.match(f.writes.at(-1)!, /status=idle/);
	f.bus.emit(BACKGROUND_EVENT, { sessionId, source: "subagents", count: 1 });
	assert.match(f.writes.at(-1)!, /status=working.*detail=running 1 subagent/);
	const before = f.writes.length; await new Promise((resolve) => setTimeout(resolve, 1100)); assert.ok(f.writes.length > before);
	f.bus.emit(BACKGROUND_EVENT, { sessionId, source: "subagents", count: 0 }); await f.flushIdle(); assert.match(f.writes.at(-1)!, /status=idle/);
	await f.session.extensionRunner.emit({ type: "agent_start" });
	f.bus.emit(RATE_WAIT_EVENT, { sessionId, active: true }); assert.match(f.writes.at(-1)!, /9;4;4;100/);
	await f.session.extensionRunner.emit({ type: "session_start", reason: "reload" }); await f.flushIdle();
	assert.match(f.writes.at(-1)!, /status=idle/); assert.deepEqual(f.errors, []);
});

test("Pi native progress owns 9;4; unknown terminals and overrides", async (t) => {
	const native = await fixture({ native: true }); t.after(() => native.close());
	await native.prompt("Run bash."); assert.ok(native.writes.length); assert.ok(native.writes.every((w) => !w.includes("9;4;")));
	native.settingsManager.setShowTerminalProgress(false); await native.prompt("Run bash."); assert.ok(native.writes.some((w) => w.includes("9;4;3")));
	const unknown = await fixture({ env: {} }); t.after(() => unknown.close()); await unknown.prompt("Run bash."); assert.deepEqual(unknown.writes, []);
	const forced = await fixture({ env: {}, settings: { progress: true } }); t.after(() => forced.close()); await forced.prompt("Run bash."); assert.ok(forced.writes.some((w) => w.includes("9;4;3")));
	const tmux = await fixture({ env: { LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7.0", TMUX: "fixture" } }); t.after(() => tmux.close());
	await tmux.prompt("Run bash."); assert.ok(tmux.writes.every((w) => w.startsWith("\x1bPtmux;\x1b\x1b]")));
});

for (const options of [{ mode: "print" }, { mode: "json" }, { mode: "rpc" }, { hasUI: false }, { tty: false }]) {
	test(`real SDK child/noninteractive silence ${JSON.stringify(options)}`, async (t) => {
		const f = await fixture(options); t.after(() => f.close()); await f.prompt("Run bash.");
		f.fail(true); await f.prompt("Fail."); await f.close(); assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
	});
}

test("real SDK subagent count broadcasts keep idle main working until its child finishes", async (t) => {
	const f = await fixture({ subagents: true }); t.after(() => f.close()); const snapshots: any[] = [];
	f.bus.on(BACKGROUND_EVENT, (value: any) => snapshots.push(value));
	await f.session.getToolDefinition("subagent")!.execute("spawn", { task: "Run bash.", name: "worker", wait: true } as never, undefined, undefined, f.session.extensionRunner.createContext());
	assert.ok(snapshots.some((s) => s.source === "subagents" && s.count === 1)); assert.equal(snapshots.at(-1).count, 0);
	await f.flushIdle(); assert.ok(f.writes.some((w) => w.includes("status=working") && w.includes("running 1 subagent")));
	assert.match(f.writes.at(-1)!, /status=idle/); assert.deepEqual(f.errors, []);
});

test("real SDK restored paused children stay idle, resumed restored children count as work", async (t) => {
	const f = await fixture({ subagents: true }); t.after(() => f.close());
	const ctx = () => f.session.extensionRunner.createContext();
	await f.session.getToolDefinition("subagent")!.execute("spawn", { task: "Run bash.", name: "worker", wait: true }, undefined, undefined, ctx());
	const snapshots: any[] = [];
	const sessionId = f.session.sessionManager.getSessionId();
	const index = new ChildIndex(join(sdk.getAgentDir(), "sessions", "subagents", sessionId), sessionId, scratch);
	await f.session.reload({ beforeSessionStart: async () => {
		f.registerProvider();
		f.bus.on(BACKGROUND_EVENT, (value: any) => snapshots.push(value));
		const records = index.load(() => {});
		index.save(records.map((r) => ({ ...r, state: "interrupted" as const, interruptedBy: "quit" as const, interruptedOwner: "previous", interruptionId: "synthetic", interruptionAnnounced: false })), "quit", "previous");
	} });
	await f.flushIdle();
	assert.ok(snapshots.length); assert.ok(snapshots.every((s) => s.count === 0));
	assert.equal(index.load(() => {})[0].state, "interrupted"); assert.equal(index.load(() => {})[0].restored, true);
	assert.match(f.writes.at(-1)!, /status=idle/);
	await f.session.getToolDefinition("message")!.execute("resume", { to: "worker", text: "Continue your task." }, undefined, undefined, ctx());
	assert.ok(snapshots.some((s) => s.count === 1));
	assert.ok(f.writes.some((w) => w.includes("status=working") && w.includes("running 1 subagent")));
	assert.deepEqual(f.errors, []);
});

test("real in-process subagent that loads Tab Status emits no OSC, even with a parent TTY", async (t) => {
	const parent = await fixture(); t.after(() => parent.close()); const extension = join(scratch, "child-tab-status.ts");
	writeFileSync(extension, `import tabStatus from ${JSON.stringify(process.env.TAB_STATUS_MUTANT ?? fileURLToPath(new URL("../extensions/tab-status.ts", import.meta.url)))};
export default function(pi) { tabStatus(pi, { env: { LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7.0" }, isTTY: () => true });
pi.registerTool({ name: "probe", label: "Probe", description: "Synthetic", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } }); }`);
	const errors: unknown[] = []; let widgetCalls = 0; let restoreWidget = () => {}; t.after(() => restoreWidget());
	const observingSdk = { ...sdk, async createAgentSession(options: any) {
		const result = await sdk.createAgentSession(options), ui = result.session.extensionRunner.getUIContext();
		const original = ui.setWidget; ui.setWidget = () => { widgetCalls++; };
		restoreWidget = () => { ui.setWidget = original; }; return result;
	} };
	const launcher = createLauncher({ sdk: observingSdk as never, agentDir: join(scratch, "agent"), cwd: scratch, sessionDir: null, modelRuntime: async () => parent.runtime, toolsFor: () => ({ tools: ["probe", "bash"], customTools: [], extensionPaths: [extension] }), instructions: () => "Synthetic child", onExtensionError: (e) => errors.push(e) });
	const child = await launcher.launch({ name: "child", parent: "main", depth: 1, task: "run bash", model: "tab-fixture/model", state: "starting", readOnly: false, fork: false, blocking: false, createdAt: Date.now(), activity: null, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, runs: 0 } as AgentRecord, { update() {} });
	const bytes: string[] = [], originalWrite = process.stdout.write;
	process.stdout.write = ((data: string | Uint8Array, ...args: unknown[]) => { bytes.push(String(data)); return Reflect.apply(originalWrite, process.stdout, [data, ...args]); }) as typeof process.stdout.write;
	try { await child.prompt("Run bash."); parent.fail(true); await assert.rejects(child.prompt("Fail."), /fixture failure/); await child.dispose(); }
	finally { process.stdout.write = originalWrite; restoreWidget(); }
	assert.equal(widgetCalls, 0, "a print-mode child must not touch even the no-op terminal widget");
	assert.equal(bytes.filter((b) => b.includes("]21337;") || b.includes("]9;4;")).length, 0); assert.deepEqual(errors, []);
});

after(() => rmSync(scratch, { recursive: true, force: true }));
