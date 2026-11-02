import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";
import cacheCompaction from "../extensions/cache-compaction.ts";
import { CACHE_WARM_ENTRY, WAKE_PENDING_EVENT, WARM_INSTRUCTION } from "../lib/cache-compaction/warm.ts";
import { BACKGROUND_EVENT } from "../lib/tab-status/events.ts";

const scratch = mkdtempSync(join(tmpdir(), "warm-sdk-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Warm fixture must never reach a real provider"); };
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href);
const textOf = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const isWarm = (context: any) => textOf(context.messages.at(-1)) === WARM_INSTRUCTION;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const HOUR = 3_600_000;
const PERIOD = 3_240_000;
const PROMPT = 46000;

interface Options { readonly warm?: Record<string, unknown>; readonly longTtl?: boolean; readonly tokens?: number; readonly piWarmer?: boolean; readonly budget?: boolean; readonly slowTool?: boolean }
async function fixture(options: Options = {}) {
	const { warm, longTtl = true, tokens = PROMPT, piWarmer = false, budget = false, slowTool = false } = options;
	let failTimers = false;
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ cacheCompaction: { enabled: true, ...(warm ? { warm } : {}) } }));
	let clock = 1_800_000_000_000;
	let warmMode = "ok";
	let hold: Promise<void> | undefined;
	const timers: Array<{ fn: () => void; ms: number; at: number; cleared: boolean }> = [];
	const calls: Array<{ context: any; payload: any; headers: any; warm: boolean; maxTokens: number | undefined }> = [];
	const hooks = { context: 0, request: 0, headers: 0 };
	const errors: unknown[] = [];
	const events: Array<{ name: string; data: any }> = [];
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("fixture", { api: "anthropic-messages", apiKey: "synthetic-not-a-credential", baseUrl: "http://127.0.0.1:1", models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 32000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }, ...(piWarmer ? { promptCache: { short: 11 } } : {}) }],
		streamSimple(model: any, context: any, opts: any) {
			const stream = new ai.AssistantMessageEventStream();
			void (async () => {
				const warmCall = isWarm(context);
				const usage = warmCall ? { input: 3, output: 4, cacheRead: tokens, cacheWrite: 900, totalTokens: tokens + 907, cost: { input: 0, output: 0.0001, cacheRead: 0.023, cacheWrite: 0.009, total: 0.0321 } }
					: { input: 10, output: 2, cacheRead: tokens - 10, cacheWrite: 0, totalTokens: tokens + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
				const cache = longTtl ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
				const body = { messages: structuredClone(context.messages).map((m: any, i: number, all: any[]) => i === all.length - 1 ? { ...m, content: [{ type: "text", text: textOf(m), cache_control: cache }] } : m), system: [{ type: "text", text: "system", cache_control: cache }], model: model.id, max_tokens: opts.maxTokens ?? 2000, ...(budget ? { thinking: { type: "enabled", budget_tokens: 1024 } } : {}) };
				const payload = await opts.onPayload?.(body, model) ?? body;
				calls.push({ context: structuredClone(context), payload: structuredClone(payload), headers: { ...opts.headers }, warm: warmCall, maxTokens: opts.maxTokens });
				const callTool = slowTool && !warmCall && !context.messages.some((m: any) => m.role === "toolResult");
				const content = callTool ? [{ type: "toolCall", id: "slow-1", name: "slow", arguments: {} }] : [{ type: "text", text: warmCall ? "ok" : "Fixture reply." }];
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: callTool ? "toolUse" : "stop", timestamp: clock, usage };
				if (warmCall && hold) await hold;
				const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				if (opts.signal?.aborted) { stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted", ...(warmMode === "abort-empty" ? { usage: empty } : {}) } }); stream.end(); return; }
				if (warmCall && warmMode === "error") { stream.push({ type: "error", reason: "error", error: { ...message, content: [], stopReason: "error", errorMessage: "429 rate limit private text" } }); stream.end(); return; }
				stream.push({ type: "done", reason: callTool ? "toolUse" : "stop", message }); stream.end();
			})();
			return stream;
		},
	});
	const model = runtime.getModel("fixture", "model")!;
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: piWarmer ? "streaming" : "off", retry: { enabled: false } });
	const timerApi = {
		set: (fn: () => void, ms: number) => { if (failTimers) throw new Error("timer failure"); const timer = { fn, ms, at: clock + ms, cleared: false }; timers.push(timer); return timer; },
		clear: (timer: any) => { if (timer) timer.cleared = true; },
	};
	let piRef: any;
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => {
			piRef = pi;
			cacheCompaction(pi, { configFile, now: () => clock, settingsManager, timers: timerApi });
			pi.on("context_with_system", () => { hooks.context++; });
			pi.on("before_provider_request", () => { hooks.request++; });
			pi.on("before_provider_headers", () => { hooks.headers++; });
		}] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), ...(slowTool ? { tools: ["slow"], customTools: [{ name: "slow", label: "slow", description: "A slow local tool", parameters: Type.Object({}), execute: async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); return { content: [{ type: "text", text: "Slow result." }], details: undefined }; } }] } : { noTools: "all" }) });
	await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
	const logFile = join(agentDir, "cache-warm.log");
	return {
		session, calls, hooks, errors, events, timers,
		warms: () => calls.filter((call) => call.warm),
		mains: () => calls.filter((call) => !call.warm),
		entries: () => session.sessionManager.getEntries().filter((e: any) => e.type === "custom" && e.customType === CACHE_WARM_ENTRY),
		log: () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
		live: () => timers.filter((t) => !t.cleared),
		setWarm: (mode: string) => { warmMode = mode; },
		failTimers: () => { failTimers = true; },
		send: (message: unknown, opts: unknown) => piRef.sendMessage(message, opts),
		hold: () => { let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; }); return () => { hold = undefined; release(); }; },
		emit: (name: string, data: unknown) => piRef.events.emit(name, data),
		wake: (pending: boolean, key = "test:1", sessionId = session.sessionId) => piRef.events.emit(WAKE_PENDING_EVENT, { sessionId, key, pending }),
		/** Run the newest live timer at its planned time, or `late` ms after it. */
		async fire(late = 0) {
			const timer = timers.filter((t) => !t.cleared).at(-1);
			assert.ok(timer, "a warm timer is scheduled");
			timer.cleared = true;
			clock = timer.at + late;
			timer.fn();
			for (let i = 0; i < 5; i++) await tick();
		},
		advance: (ms: number) => { clock += ms; },
		async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); },
	};
}

test("no warm when nothing will wake the session", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	assert.equal(f.live().length, 1);
	assert.equal(f.live()[0].ms, PERIOD, "a one-hour ttl warms at 54 minutes");
	await f.fire();
	assert.equal(f.warms().length, 0);
	assert.equal(f.live().length, 0, "the warmer stops");
	assert.equal(f.log().at(-1).event, "stop");
	assert.equal(f.log().at(-1).reason, "no-wake");
	assert.deepEqual(f.errors, []);
});

test("a pending wake warms with the captured request plus the instruction, and schedules the next warm", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.wake(true);
	const hooks = { ...f.hooks };
	await f.fire();
	assert.equal(f.warms().length, 1);
	const warm = f.warms()[0];
	const main = f.mains().at(-1)!;
	// Point 6: a registry request runs no provider hooks, so the capture of the real request stays as it was.
	assert.deepEqual(f.hooks, hooks, "no context, header or payload hook ran for the warm");
	assert.deepEqual(warm.payload.messages.slice(0, -1).map((m: any) => textOf(m)), main.payload.messages.map((m: any) => textOf(m)));
	assert.equal(textOf(warm.payload.messages.at(-1)), WARM_INSTRUCTION);
	assert.deepEqual(warm.payload.system, main.payload.system);
	assert.equal(warm.maxTokens, 16);
	const entry = f.entries()[0];
	assert.ok(entry, "the warm's usage is recorded");
	assert.equal(entry.data.provider, "fixture");
	assert.equal(entry.data.model, "model");
	assert.equal(entry.data.usage.cost.total, 0.0321);
	assert.equal(JSON.stringify(entry.data).includes('"ok"'), false, "no provider text");
	const line = f.log().at(-1);
	assert.equal(line.event, "warm");
	assert.equal(line.promptTokens, PROMPT);
	assert.equal(f.live().length, 1);
	assert.equal(f.live()[0].ms, PERIOD);
	// A second warm still replays the real request, not the first warm.
	await f.fire();
	assert.equal(f.warms().length, 2);
	assert.deepEqual(f.warms()[1].payload.messages.slice(0, -1), warm.payload.messages.slice(0, -1));
	assert.equal(textOf(f.warms()[1].payload.messages.at(-1)), WARM_INSTRUCTION);
	assert.deepEqual(f.errors, []);
});

test("a five-minute cache warms at 4.5 minutes", { timeout: 15000 }, async (t) => {
	const f = await fixture({ longTtl: false }); t.after(() => f.close());
	await f.session.prompt("Task.");
	assert.equal(f.live()[0].ms, 270_000);
});

test("a wake for another session or a cleared wake does not warm", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.wake(true, "other:1", "another-session");
	f.wake(true, "mine"); f.wake(false, "mine");
	await f.fire();
	assert.equal(f.warms().length, 0);
});

test("shell jobs and subagents announce their work through the background-work event", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.emit(BACKGROUND_EVENT, { sessionId: f.session.sessionId, source: "shell-jobs", count: 1 });
	await f.fire();
	assert.equal(f.warms().length, 1);
	f.emit(BACKGROUND_EVENT, { sessionId: f.session.sessionId, source: "shell-jobs", count: 0 });
	await f.fire();
	assert.equal(f.warms().length, 1);
	assert.equal(f.log().at(-1).reason, "no-wake");
});

test("a watched artifact form is a wake until its feedback arrives", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	const runner = f.session.extensionRunner;
	await runner.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "artifact_ask", args: { title: "Q" } });
	await runner.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "artifact_ask", result: {}, isError: false });
	await runner.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "artifact_ask", args: { title: "Q", watch: false } });
	await runner.emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "artifact_ask", result: {}, isError: false });
	await f.fire();
	assert.equal(f.warms().length, 1);
	await runner.emit({ type: "message_end", message: { role: "custom", customType: "artifact-feedback", content: "answers", display: true, timestamp: 1 } });
	await f.fire();
	assert.equal(f.warms().length, 1, "feedback cleared the wake");
});

test("feedback for one form leaves the other form's wake open", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	const runner = f.session.extensionRunner;
	const ask = async (call: string, form: string) => {
		const details = { tool: "ask", watching: true, form: { id: form, url: `https://artifact.test/${form}`, role: "form" } };
		await runner.emit({ type: "tool_execution_start", toolCallId: call, toolName: "artifact_ask", args: { title: "Q" } });
		await runner.emit({ type: "tool_execution_end", toolCallId: call, toolName: "artifact_ask", result: { details }, isError: false });
	};
	await ask("c1", "f1");
	await ask("c2", "f2");
	const feedback = { role: "custom", customType: "artifact-feedback", content: "answer", display: true, timestamp: 1, details: { changes: [{ kind: "answer", artifact_id: "f1" }] } };
	await runner.emit({ type: "message_end", message: feedback });
	await f.fire();
	assert.equal(f.warms().length, 1, "only the answered form's wake was cleared");
	assert.equal(f.log().at(-1).wakes, 1);
});

test("a long tool call warms while it runs", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	const runner = f.session.extensionRunner;
	await runner.emit({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "sleep" } });
	await f.fire();
	assert.equal(f.warms().length, 1);
	await runner.emit({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: {}, isError: false });
	await f.fire();
	assert.equal(f.warms().length, 1);
});

test("a real request aborts an in-flight warm and restarts the schedule", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.wake(true);
	const release = f.hold();
	await f.fire();
	assert.equal(f.warms().length, 1);
	await f.session.prompt("Next task.");
	release(); await tick(); await tick();
	// The provider had the request and reported its usage: it is billed, so it is recorded.
	assert.equal(f.entries().length, 1, "a sent warm that reported usage is recorded");
	assert.equal(f.entries()[0].data.stopReason, "aborted");
	assert.equal(f.log().at(-1).event, "warm");
	assert.equal(f.log().at(-1).stopReason, "aborted");
	assert.equal(f.live().length, 1, "the real request scheduled a new warm");
	assert.equal(f.live()[0].ms, PERIOD);
	assert.deepEqual(f.errors, []);
});

test("a failed warm stops warming and logs no provider text", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.wake(true); f.setWarm("error");
	await f.fire();
	assert.equal(f.live().length, 0);
	const line = f.log().at(-1);
	assert.equal(line.event, "stop");
	assert.equal(line.reason, "rate-limited");
	assert.equal(JSON.stringify(f.log()).includes("private"), false);
});

test("economics and the cap stop warming", { timeout: 15000 }, async (t) => {
	const small = await fixture({ tokens: 5000 }); t.after(() => small.close());
	await small.session.prompt("Task."); small.wake(true);
	await small.fire();
	assert.equal(small.warms().length, 0);
	assert.equal(small.log().at(-1).reason, "small-context");
	const capped = await fixture({ warm: { maxHours: 1 } }); t.after(() => capped.close());
	await capped.session.prompt("Task."); capped.wake(true);
	await capped.fire();
	assert.equal(capped.warms().length, 1);
	await capped.fire();
	assert.equal(capped.warms().length, 1);
	assert.equal(capped.log().at(-1).reason, "max-hours");
	const late = await fixture(); t.after(() => late.close());
	await late.session.prompt("Task."); late.wake(true);
	await late.fire(HOUR);
	assert.equal(late.warms().length, 0);
	assert.equal(late.log().at(-1).reason, "deadline-missed");
});

test("warming off in config, or an API outside the list, sends nothing", { timeout: 15000 }, async (t) => {
	for (const warm of [{ enabled: false }, { apis: ["openai-responses"] }]) {
		const f = await fixture({ warm }); t.after(() => f.close());
		await f.session.prompt("Task."); f.wake(true);
		if (f.live().length) await f.fire();
		assert.equal(f.warms().length, 0, JSON.stringify(warm));
	}
});

test("a session shutdown drops the wakes and the timer", { timeout: 15000 }, async (t) => {
	const f = await fixture();
	await f.session.prompt("Task."); f.wake(true);
	await f.close();
	assert.equal(f.live().length, 0);
	t.after(() => {});
});

test("a sent warm aborted with no usage logs its estimated cost", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.wake(true); f.setWarm("abort-empty");
	const release = f.hold();
	await f.fire();
	await f.session.prompt("Next task.");
	release(); await tick(); await tick();
	assert.equal(f.entries().length, 0);
	const line = f.log().at(-1);
	assert.equal(line.event, "stop");
	assert.equal(line.reason, "aborted-sent");
	assert.ok(line.estimatedCost > 0);
});

test("Pi's own warmer stands down for the APIs this warmer owns, so the wait is not reset", { timeout: 15000 }, async (t) => {
	const f = await fixture({ piWarmer: true, slowTool: true }); t.after(() => f.close());
	await f.session.prompt("Task.");
	assert.equal(f.calls.filter((call) => call.maxTokens === 1).length, 0, "no refresh from Pi's warmer");
	assert.equal(f.mains().length, 2, "the tool call and the final reply");
	assert.equal(f.hooks.request, 2, "only the two real requests ran the payload hook");
	assert.equal(f.timers.length, 2, "one plan per real request, none from a refresh");
});

test("Pi's own warmer keeps its decision for an API outside the list", { timeout: 15000 }, async (t) => {
	const f = await fixture({ piWarmer: true, slowTool: true, warm: { apis: ["openai-responses"] } }); t.after(() => f.close());
	await f.session.prompt("Task.");
	assert.ok(f.calls.filter((call) => call.maxTokens === 1).length >= 1, "Pi's warmer refreshed during the slow tool");
});

test("a user prompt clears artifact wakes; a custom message that starts a run does not", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	const runner = f.session.extensionRunner;
	const ask = async (id: string) => {
		await runner.emit({ type: "tool_execution_start", toolCallId: id, toolName: "artifact_ask", args: { title: "Q" } });
		await runner.emit({ type: "tool_execution_end", toolCallId: id, toolName: "artifact_ask", result: {}, isError: false });
	};
	await ask("a1");
	f.send({ customType: "shell-job-complete", content: "job done", display: true }, { triggerTurn: true });
	for (let i = 0; i < 20 && f.mains().length < 2; i++) await tick();
	await f.session.agent.waitForIdle?.();
	assert.equal(f.mains().length, 2);
	await f.fire();
	assert.equal(f.warms().length, 1, "the form wake survived a delivered message");
	await f.session.prompt("New task from the user.");
	await f.fire();
	assert.equal(f.warms().length, 1);
	assert.equal(f.log().at(-1).reason, "no-wake");
});

test("artifact_publish is not a wake by default", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	const runner = f.session.extensionRunner;
	await runner.emit({ type: "tool_execution_start", toolCallId: "p1", toolName: "artifact_publish", args: { html: "<p>" } });
	await runner.emit({ type: "tool_execution_end", toolCallId: "p1", toolName: "artifact_publish", result: {}, isError: false });
	await f.fire();
	assert.equal(f.warms().length, 0);
});

test("a running agent with no tool call defers the warm in short steps", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.wake(true);
	const runner = f.session.extensionRunner;
	await runner.emit({ type: "agent_start" });
	await f.fire();
	assert.equal(f.warms().length, 0);
	assert.equal(f.log().at(-1).event, "defer");
	assert.equal(f.log().at(-1).reason, "agent-running");
	assert.equal(f.live().at(-1)!.ms, 30_000);
	await runner.emit({ type: "agent_end", messages: [] });
	await f.fire();
	assert.equal(f.warms().length, 1, "the deferred warm goes out once the agent is idle");
	await runner.emit({ type: "agent_start" });
	await f.fire();
	// Past due + margin / 2 (3 minutes for a one-hour cache), a retry would be a full write.
	await f.fire(180_000);
	assert.equal(f.log().at(-1).reason, "deadline-missed");
	assert.equal(f.live().length, 0);
});

test("budget thinking never warms, and says so when the request is captured", { timeout: 15000 }, async (t) => {
	const f = await fixture({ budget: true }); t.after(() => f.close());
	await f.session.prompt("Task.");
	assert.equal(f.live().length, 0);
	assert.equal(f.log().at(-1).reason, "thinking-budget");
});

test("an internal failure in a timer is logged with a fixed reason", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Task.");
	f.wake(true); f.failTimers();
	await f.fire();
	assert.equal(f.warms().length, 1);
	assert.equal(f.log().at(-1).event, "stop");
	assert.equal(f.log().at(-1).reason, "internal");
});

after(() => { globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
