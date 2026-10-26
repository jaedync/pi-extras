import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";
import cacheCompaction from "../extensions/cache-compaction.ts";
import { COMPACTION_PROGRESS_EVENT } from "../lib/cache-compaction/decision.ts";
import { BACKGROUND_SESSION_SUFFIX } from "../lib/cache-compaction/background.ts";

const scratch = mkdtempSync(join(tmpdir(), "background-sdk-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Background fixture must never reach a real provider"); };
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href);
const usage = { input: 10, output: 2, cacheRead: 90, cacheWrite: 0, totalTokens: 102, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const textOf = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const isSummary = (context: any) => textOf(context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST");
// Window 200,000 and reserve 16,384: Pi compacts above 183,616; 90% of that is 165,255.
const BELOW = 150000;
const DUE = 170000;
const OVER = 184001;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Options { readonly background?: boolean; readonly api?: string; readonly baseUrl?: string; readonly percent?: number; readonly tools?: boolean }
/** One scripted main reply: its usage, and whether it calls the tool or fails. */
interface Reply { readonly tokens: number; readonly tool?: boolean; readonly error?: boolean }
async function fixture(options: Options = {}) {
	const { background = true, api = "anthropic-messages", baseUrl = "http://127.0.0.1:1", percent, tools = false } = options;
	const replies: Reply[] = [];
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ cacheCompaction: { enabled: true, background, ...(percent ? { backgroundPercent: percent } : {}), idleSeconds: { fixture: 600 } } }));
	const now = 1_800_000_000_000;
	let usageTokens = 102;
	let summaryMode = "text";
	let hold: Promise<void> | undefined;
	const calls: Array<{ context: any; payload: any; headers: any; sessionId: string; summary: boolean }> = [];
	const progress: any[] = [];
	const errors: unknown[] = [];
	const notices: string[] = [];
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const key = api.includes("responses") ? "input" : "messages";
	runtime.registerProvider("fixture", { api, apiKey: "synthetic-not-a-credential", baseUrl, models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, context: any, opts: any) {
			const stream = new ai.AssistantMessageEventStream();
			void (async () => {
				const summary = isSummary(context);
				const fail = (error: unknown) => { stream.push({ type: "error", reason: "error", error: { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", errorMessage: String(error), timestamp: now, usage } }); stream.end(); };
				try {
					const body = { [key]: structuredClone(context.messages), model: model.id, max_tokens: opts.maxTokens ?? 2000, metadata: { user_id: "fixture" }, prompt_cache_key: opts.sessionId };
					const payload = await opts.onPayload?.(body, model) ?? body;
					calls.push({ context: structuredClone(context), payload: structuredClone(payload), headers: { ...opts.headers }, sessionId: opts.sessionId, summary });
					const text = summary ? "## Goal\nBackground checkpoint." : "Fixture reply.";
					const reply = summary ? undefined : replies.shift();
					const tokens = reply?.tokens ?? usageTokens;
					const stopReason = (summary && summaryMode === "error") || reply?.error ? "error" : reply?.tool ? "toolUse" : "stop";
					const content = reply?.tool ? [{ type: "toolCall", id: `call-${calls.length}`, name: "tiny", arguments: {} }] : [{ type: "text", text }];
					const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: now, usage: summary ? usage : { ...usage, cacheRead: tokens - 12, totalTokens: tokens }, ...(reply?.error ? { errorMessage: "fixture failure" } : {}) };
					if (summary) {
						stream.push({ type: "text_delta", contentIndex: 0, delta: text.slice(0, 7), partial: message });
						if (hold) await hold;
						if (opts.signal?.aborted) { stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } }); stream.end(); return; }
						stream.push({ type: "text_delta", contentIndex: 0, delta: text.slice(7), partial: message });
					}
					stream.push({ type: "done", reason: stopReason, message }); stream.end();
				} catch (error) { fail(error); }
			})();
			return stream;
		},
	});
	const model = runtime.getModel("fixture", "model")!;
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 }, cacheWarming: "off", retry: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => { cacheCompaction(pi, { configFile, now: () => now, settingsManager }); pi.events.on(COMPACTION_PROGRESS_EVENT, (data: any) => progress.push(data)); }] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), ...(tools ? { tools: ["tiny"], customTools: [{ name: "tiny", label: "tiny", description: "Local small tool result", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "Small result." }], details: undefined }) }] } : { noTools: "all" }) });
	await session.bindExtensions({ mode: "tui", uiContext: { notify: (text: string) => notices.push(text) }, onError: (error: unknown) => errors.push(error) });
	const compactions = () => session.sessionManager.getEntries().filter((e: any) => e.type === "compaction");
	const log = () => readFileSync(join(agentDir, "cache-compaction.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return {
		session, calls, progress, errors, notices, compactions, log,
		summaries: () => calls.filter((call) => call.summary),
		script: (...items: Reply[]) => { replies.push(...items); },
		setUsage: (tokens: number) => { usageTokens = tokens; },
		setSummary: (mode: string) => { summaryMode = mode; },
		hold: () => { let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; }); return () => { hold = undefined; release(); }; },
		/** One turn below the start point, then one at it: the background summary starts after the second reply. */
		async reach() { await session.prompt("Old task: preserve file paths and decision."); setTokens(DUE); await session.prompt("Recent task: next step is run the tests."); },
		async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); },
	};
	function setTokens(tokens: number) { usageTokens = tokens; }
}

test("off by default: no summary request before Pi's own trigger", { timeout: 15000 }, async (t) => {
	const f = await fixture({ background: false }); t.after(() => f.close());
	await f.reach(); await tick();
	assert.equal(f.summaries().length, 0);
	f.setUsage(OVER); await f.session.prompt("Threshold task.");
	const decision = f.log().at(-1);
	assert.equal(decision.path, "prefix-sharing"); assert.equal(decision.background, null);
	assert.deepEqual(f.errors, []);
});

test("an edit to an earlier message after the start point falls back", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.reach(); await tick();
	const user = f.session.sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user");
	f.session.sessionManager.appendContextEdit(user.id, { ...user.message, content: "edited old task" }); f.session.refreshContext();
	f.setUsage(OVER); await f.session.prompt("Threshold task.");
	const entry = f.compactions().at(-1);
	assert.ok(entry); assert.notEqual(entry.details?.background, true);
	assert.equal(f.log().at(-1).background, "branch-changed");
});

test("below the start percent: no summary request", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Old task."); f.setUsage(BELOW); await f.session.prompt("Recent task."); await tick();
	assert.equal(f.summaries().length, 0);
});

test("the held summary replaces Pi's compaction at the trigger, with no second request", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.reach(); await tick();
	assert.equal(f.summaries().length, 1, "the summary started in the background");
	assert.equal(f.compactions().length, 0, "nothing applied before the trigger");
	const early = f.summaries()[0];
	const main = f.calls.filter((call) => !call.summary).at(-1)!;
	// The summary shares the cached prefix of the request whose reply crossed the start point.
	assert.deepEqual(early.payload.messages.slice(0, -1), main.payload.messages);
	assert.equal(early.sessionId, f.session.sessionId);
	const keptId = f.session.sessionManager.getBranch().findLast((e: any) => e.type === "message" && e.message.role === "assistant").id;
	f.setUsage(OVER); await f.session.prompt("Threshold task.");
	const entry = f.compactions().at(-1);
	assert.ok(entry, "Pi compacted at its trigger");
	assert.equal(f.summaries().length, 1, "the held summary was used; no new summary request");
	assert.equal(entry.firstKeptEntryId, keptId, "everything after the summarized request stays verbatim");
	assert.equal(entry.details.cachePrefix, true);
	assert.equal(entry.details.background, true);
	assert.match(entry.summary, /Background checkpoint/);
	const decision = f.log().at(-1);
	assert.equal(decision.path, "background"); assert.equal(decision.fallbackReason, null); assert.equal(decision.background, "used");
	assert.ok(f.notices.includes("Compaction: background"));
	// The kept reply and the threshold turn follow the summary in the next request.
	await f.session.prompt("After compaction.");
	const next = f.calls.at(-1)!.context.messages.map(textOf).join("\n");
	assert.match(next, /Background checkpoint/); assert.match(next, /Threshold task/); assert.doesNotMatch(next, /Old task/);
	assert.deepEqual(f.errors, []);
});

test("a summary still streaming at the trigger is awaited, and its text reaches the live band", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	const release = f.hold();
	await f.reach(); await tick();
	assert.equal(f.summaries().length, 1);
	f.setUsage(OVER);
	const run = f.session.prompt("Threshold task.");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(f.compactions().length, 0, "compaction waits for the held summary");
	release(); await run;
	assert.equal(f.summaries().length, 1);
	assert.equal(f.compactions().at(-1).details.background, true);
	assert.deepEqual(f.progress.map((item: any) => item.chars), [7, 30]);
});

test("Meridian: the background summary uses its own session key, and other headers stay", { timeout: 15000 }, async (t) => {
	const f = await fixture({ baseUrl: "http://127.0.0.1:3456" }); t.after(() => f.close());
	await f.reach(); await tick();
	const summary = f.summaries()[0];
	assert.equal(summary.headers["x-session-affinity"], `${f.session.sessionId}${BACKGROUND_SESSION_SUFFIX}`);
	assert.equal(summary.payload.prompt_cache_key, f.session.sessionId, "payload fields stay those of the cached request");
});

test("local chat-completions engines never get a parallel request", { timeout: 15000 }, async (t) => {
	const f = await fixture({ api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1" }); t.after(() => f.close());
	await f.reach(); await tick();
	assert.equal(f.summaries().length, 0);
});

test("a model change drops the held summary; Pi's trigger then uses the prefix-sharing path", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.reach(); await tick();
	await f.session.extensionRunner.emit({ type: "model_select", model: f.session.model, previousModel: f.session.model, source: "set" });
	f.setUsage(OVER); await f.session.prompt("Threshold task.");
	const entry = f.compactions().at(-1);
	assert.ok(entry); assert.notEqual(entry.details?.background, true);
	assert.equal(f.summaries().length, 2, "a new summary request ran at the trigger");
});

test("a failed background summary falls back to prefix sharing and logs why", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	f.setSummary("error"); await f.reach(); await tick();
	f.setSummary("text"); f.setUsage(OVER); await f.session.prompt("Threshold task.");
	const entry = f.compactions().at(-1);
	assert.ok(entry); assert.equal(entry.details.cachePrefix, true); assert.notEqual(entry.details.background, true);
	const decision = f.log().at(-1);
	assert.equal(decision.path, "prefix-sharing"); assert.equal(decision.background, "response-failed");
});

test("too much new conversation after the held summary falls back", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.reach(); await tick();
	f.setUsage(OVER); await f.session.prompt("Large threshold task: " + "abcd ".repeat(80000));
	const entry = f.compactions().at(-1);
	assert.ok(entry); assert.notEqual(entry.details?.background, true);
	assert.equal(f.log().at(-1).background, "tail-too-large");
});

test("manual /compact does not use the held summary and stops it", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	const release = f.hold();
	await f.reach(); await tick();
	const done = f.session.compact("Focus.");
	release();
	const entry = await done;
	assert.notEqual(entry.details?.background, true);
	assert.equal(f.log().at(-1).background, "manual");
	assert.match(textOf(f.summaries().at(-1)!.context.messages.at(-1)), /Focus/);
});

test("a held summary starts only once per trigger", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.reach(); await f.session.prompt("Another turn above the start point."); await tick();
	assert.equal(f.summaries().length, 1);
});

test("mid-run: a tool-call reply at the start point is the kept boundary when Pi compacts between turns", { timeout: 15000 }, async (t) => {
	const f = await fixture({ tools: true }); t.after(() => f.close());
	await f.session.prompt("Old task.");
	f.script({ tokens: DUE, tool: true }, { tokens: OVER, tool: true }, { tokens: 102 });
	await f.session.prompt("Run the tool twice.");
	const entry = f.compactions().at(-1);
	assert.ok(entry, "Pi compacted inside the run");
	assert.equal(entry.details.background, true);
	assert.equal(f.summaries().length, 1);
	const toolReplies = f.session.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "toolUse");
	assert.equal(entry.firstKeptEntryId, toolReplies[0].id);
	// The turn after the compaction: summary, both calls and both results, once each.
	const roles = f.calls.at(-1)!.context.messages.filter((m: any) => m.role !== "system").map((m: any) => m.role);
	assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant", "toolResult"]);
	assert.match(textOf(f.calls.at(-1)!.context.messages.find((m: any) => m.role === "user")), /Background checkpoint/);
	assert.deepEqual(f.errors, []);
});

test("a second cycle updates the previous summary and also uses the background path", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.reach(); await tick(); f.setUsage(OVER); await f.session.prompt("Threshold task.");
	f.setUsage(DUE); await f.session.prompt("Work after the first summary."); await tick();
	assert.equal(f.summaries().length, 2);
	assert.match(textOf(f.summaries()[1].context.messages.at(-1)), /Update the existing structured summary/);
	f.setUsage(OVER); await f.session.prompt("Second threshold task.");
	assert.equal(f.compactions().length, 2);
	assert.equal(f.compactions().at(-1).details.background, true);
	assert.equal(f.summaries().length, 2);
});

test("other providers keep the session's own headers", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.reach(); await tick();
	assert.notEqual(f.summaries()[0].headers["x-session-affinity"], `${f.session.sessionId}${BACKGROUND_SESSION_SUFFIX}`);
	assert.ok(!Object.values(f.summaries()[0].headers).some((value: any) => String(value).endsWith(BACKGROUND_SESSION_SUFFIX)));
});

for (const kind of ["failed", "above-trigger"]) test(`a ${kind} reply starts no background summary`, { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	await f.session.prompt("Old task.");
	if (kind === "above-trigger") { f.setUsage(OVER); await f.session.prompt("Threshold task."); }
	else { f.script({ tokens: DUE, error: true }); await f.session.prompt("Failing task."); }
	await tick();
	// The trigger's own prefix-sharing request asks for history only; a background one for the whole transcript.
	assert.ok(!f.summaries().some((call) => /Summarize the whole transcript/.test(textOf(call.context.messages.at(-1)))));
});

test("shutdown while the summary streams stops it without errors", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.session.dispose());
	const release = f.hold();
	await f.reach(); await tick();
	await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	release(); await tick(); await tick();
	assert.deepEqual(f.progress.map((item: any) => item.chars), [7], "the second part never came");
	assert.deepEqual(f.errors, []);
});

test("overflow recovery stops the held summary and uses the normal path", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close());
	const release = f.hold();
	await f.reach(); await tick();
	const { prepareCompaction } = await import(pathToFileURL(join(agentRoot, "dist/core/compaction/compaction.js")).href);
	const branch = f.session.sessionManager.getBranch();
	const preparation = prepareCompaction(branch, { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 });
	await f.session.extensionRunner.emit({ type: "session_before_compact", preparation, branchEntries: branch, reason: "overflow", willRetry: true, signal: new AbortController().signal });
	release(); await tick(); await tick();
	assert.equal(f.log().at(-1).background, "overflow");
	assert.deepEqual(f.progress.map((item: any) => item.chars), [7], "the held summary was stopped");
});

after(() => { globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
