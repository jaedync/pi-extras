import assert from "node:assert/strict";
import { test, after } from "node:test";
import { Type } from "typebox";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
import cacheCompaction from "../extensions/cache-compaction.ts";
import usageGuard, { GUARD_CUSTOM_TYPE } from "../extensions/usage-guard.ts";
import { createLimitStore } from "../lib/limit-store.ts";
import { estimateRequestTokens, estimateRequestContext, contextSafetyTokens } from "../lib/cache-compaction/estimate.ts";

const scratch = mkdtempSync(join(tmpdir(), "prefix-sdk-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Prefix fixture must never reach a real provider"); };
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const usage = { input: 10, output: 2, cacheRead: 90, cacheWrite: 0, totalTokens: 102, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const textOf = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

async function fixture(api = "anthropic-messages", enabled = true, automatic?: "after" | "pre" | "codex" | "large-anthropic", reserveTokens = 16384, modelMaxTokens?: number, withUsageGuard = false) {
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	mkdirSync(agentDir, { recursive: true });
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ cacheCompaction: { enabled, idleSeconds: { fixture: 60 } } }));
	let now = 1_800_000_000_000;
	let responseMode = "text";
	let lateTransform = false;
	let rewriteUser = false;
	let filterInternal = false;
	const internal = (message: any) => message.role === "custom" && (message.customType === "remote-pi:received-image" || (message.customType?.startsWith("remote-pi:") && message.display === false));
	let usageTokens = 102;
	let simulateWarmer = false;
	const notices: string[] = [];
	const calls: Array<{ context: any; payload: any; sessionId: string; cacheRetention?: string }> = [];
	const captures: any[][] = [];
	const errors: unknown[] = [];
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const key = api.includes("responses") ? "input" : api.startsWith("google") ? "contents" : "messages";
	runtime.registerProvider("fixture", { api, apiKey: "synthetic-not-a-credential", baseUrl: "http://127.0.0.1:1", models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: automatic === "large-anthropic" ? 500000 : automatic ? 200000 : 100000, maxTokens: modelMaxTokens ?? (automatic ? 32000 : 2000), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, context: any, options: any) {
			const stream = new ai.AssistantMessageEventStream();
			void (async () => {
				try {
					const isPrefix = textOf(context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST");
					const generated = { [key]: structuredClone(context.messages), model: model.id, reasoning: { effort: isPrefix ? "high" : "low", summary: "auto" }, tools: [{ name: "read", schema: { type: "object" } }], tool_choice: "auto", max_tokens: options.maxTokens ?? 2000, metadata: { user_id: "fixture-session" }, prompt_cache_key: options.sessionId };
					const body = automatic === "codex" ? Object.fromEntries(Object.entries(generated).filter(([name]) => name !== "max_tokens")) : generated;
					if (!isPrefix && simulateWarmer && calls.length) {
						const previous = calls.at(-1)!.payload;
						const warmer = api === "openai-codex-responses" ? Object.fromEntries(Object.entries(previous).filter(([name]) => name !== "max_tokens")) : api === "openai-responses" ? { ...previous, max_output_tokens: 16 } : { ...previous, max_tokens: 2049 };
						await options.onPayload?.(warmer, model);
					}
					const payload = await options.onPayload?.(body, model) ?? body;
					calls.push({ context: structuredClone(context), payload: structuredClone(payload), sessionId: options.sessionId, cacheRetention: options.cacheRetention });
					const content = automatic === "large-anthropic" && !isPrefix && calls.length === 2 ? [{ type: "toolCall", id: "small-result", name: "tiny", arguments: {} }] : isPrefix && responseMode === "empty" ? [] : isPrefix && responseMode === "tool" ? [{ type: "toolCall", id: "not-executed", name: "read", arguments: {} }] : [{ type: "text", text: isPrefix ? "## Goal\nPrefix checkpoint." : "Fixture reply." }];
					const stopReason = automatic === "large-anthropic" && !isPrefix && calls.length === 2 ? "toolUse" : !isPrefix && responseMode === "aborted" ? "aborted" : isPrefix && responseMode === "error" ? "error" : isPrefix && responseMode === "length" ? "length" : "stop";
					if (automatic === "large-anthropic" && calls.length > 2) usageTokens = 102;
					const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: now, usage: isPrefix ? usage : { ...usage, cacheRead: usageTokens - 12, totalTokens: usageTokens } };
					stream.push({ type: "done", reason: stopReason, message }); stream.end();
				} catch (error) {
					stream.push({ type: "error", reason: "error", error: { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", errorMessage: String(error), timestamp: now, usage } }); stream.end();
				}
			})();
			return stream;
		},
	});
	const model = runtime.getModel("fixture", "model")!;
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: !!automatic, keepRecentTokens: 1, reserveTokens: automatic ? reserveTokens : 2000 }, cacheWarming: "off", retry: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => { pi.on("context", (event: any) => {
			if (!rewriteUser && !filterInternal) return;
			const messages = filterInternal ? event.messages.filter((message: any) => !internal(message)) : event.messages;
			const lastUser = rewriteUser ? messages.findLastIndex((message: any) => message.role === "user") : -1;
			return { messages: messages.map((message: any, index: number) => index === lastUser ? { ...message, content: "Rewritten user text." } : message) };
		});
		pi.on("session_before_compact", (event: any) => {
			if (!filterInternal) return;
			event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter((message: any) => !internal(message));
			event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter((message: any) => !internal(message));
		}); if (withUsageGuard) usageGuard(pi, { configFile, store: createLimitStore(), now: () => now }); cacheCompaction(pi, { configFile, now: () => now, settingsManager }); pi.on("context_with_system", (event: any) => {
			captures.push(structuredClone(event.messages));
			if (lateTransform) {
				const last = event.messages.at(-1);
				event.messages[event.messages.length - 1] = { ...last, content: [{ type: "text", text: `${textOf(last)} transformed after capture` }] };
			}
		}); }] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), ...(automatic === "large-anthropic" ? { tools: ["tiny"] } : { noTools: "all" }), customTools: automatic === "large-anthropic" ? [{ name: "tiny", label: "tiny", description: "Local small tool result", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "Small result." }], details: undefined }) }] : [] });
	await session.bindExtensions({ mode: "tui", uiContext: { notify: (text: string) => { notices.push(text); if (process.env.PREFIX_TEST_DEBUG) console.error(text); } }, onError: (error: unknown) => errors.push(error) });
	return { session, calls, captures, errors, notices, configFile, logFile: join(agentDir, "cache-compaction.log"), settingsManager, simulateWarmer: () => { simulateWarmer = true; }, setUsage: (tokens: number) => { usageTokens = tokens; }, setLateTransform: () => { lateTransform = true; }, setRewriteUser: () => { rewriteUser = true; }, setInternalFilter: () => { filterInternal = true; }, setTime: (n: number) => { now += n; }, setResponse: (mode: string) => { responseMode = mode; }, async warm() { await session.prompt("Old task: preserve file paths and decision."); await session.prompt("Recent task: next step is run the tests."); }, async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } };
}

for (const api of ["anthropic-messages", "openai-completions", "openai-codex-responses", "openai-responses", "google-generative-ai"]) {
	test(`real SDK ${api}: same sessionId, exact non-conversation payload, captured + last assistant + instruction`, { timeout: 15000 }, async (t) => {
		const f = await fixture(api); t.after(() => f.close());
		await f.warm();
		const captured = f.captures.at(-1)!;
		const last = f.session.messages.at(-1);
		const request = f.calls.at(-1)!;
		const entry = await f.session.compact("Keep the decision.");
		assert.equal(entry.details.cachePrefix, true);
		assert.equal(f.session.sessionManager.getEntries().filter((e: any) => e.type === "compaction").at(-1).fromHook, true);
		assert.deepEqual(entry.usage, usage);
		const summary = f.calls.at(-1)!;
		assert.equal(summary.sessionId, f.session.sessionId);
		assert.notEqual(summary.cacheRetention, "none");
		const key = api.includes("responses") ? "input" : api.startsWith("google") ? "contents" : "messages";
		const { [key]: oldConversation, ...oldFields } = request.payload;
		const { [key]: conversation, ...fields } = summary.payload;
		assert.ok(oldConversation.length);
		assert.deepEqual(fields, oldFields);
		assert.deepEqual(conversation.slice(0, -1), ai.normalizeContext({ messages: sdk.convertToLlm([...captured, last]) }).messages);
		assert.match(textOf(conversation.at(-1)), /Keep the decision/);
		assert.match(textOf(conversation.at(-1)), /Keep your reasoning brief/);
		assert.equal(f.calls.length, 3);
		assert.deepEqual(f.errors, []);
	});
}
for (const condition of ["disabled", "cold", "model-change", "empty", "tool", "error", "length", "branch-edit", "unsupported", "unrequested-prefix", "no-capture"]) {
	test(`real SDK fallback ${condition} yields Pi's default compaction`, { timeout: 15000 }, async (t) => {
		const f = await fixture(condition === "unsupported" ? "mistral-conversations" : "anthropic-messages", condition !== "disabled"); t.after(() => f.close());
		await f.warm();
		if (condition === "cold") f.setTime(61000);
		if (condition === "model-change") await f.session.extensionRunner.emit({ type: "model_select", model: f.session.model, previousModel: f.session.model, source: "set" });
		if (["empty", "tool", "error", "length"].includes(condition)) f.setResponse(condition);
		if (condition === "branch-edit") {
			const user = f.session.sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user");
			f.session.sessionManager.appendContextEdit(user.id, { ...user.message, content: "edited old task" }); f.session.refreshContext();
		}
		if (condition === "unrequested-prefix") { f.session.sessionManager.appendMessage({ role: "user", content: "unsent prefix", timestamp: Date.now() }); f.session.sessionManager.appendMessage({ ...f.session.messages.at(-1), timestamp: Date.now() + 1 }); f.session.refreshContext(); }
		if (condition === "no-capture") await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		const entry = await f.session.compact();
		assert.notEqual(f.session.sessionManager.getEntries().filter((e: any) => e.type === "compaction").at(-1).fromHook, true);
		assert.notEqual(entry.details?.cachePrefix, true);
		assert.ok(f.calls.some((call) => call.cacheRetention === "none"), "the native summarization path ran");
		assert.deepEqual(f.errors, []);
	});
}

test("real SDK appended assistant/tool results extend the captured request exactly", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close()); await f.warm();
	const captured = f.captures.at(-1)!;
	const final = f.session.messages.at(-1);
	const assistant = { ...final, content: [{ type: "toolCall", id: "extra-read", name: "read", arguments: { path: "file.ts" } }], stopReason: "toolUse", timestamp: final.timestamp + 1 };
	const result = { role: "toolResult", toolCallId: "extra-read", toolName: "read", content: [{ type: "text", text: "full tool result" }], isError: false, timestamp: final.timestamp + 2 };
	f.session.sessionManager.appendMessage(assistant); f.session.sessionManager.appendMessage(result); f.session.refreshContext();
	const entry = await f.session.compact();
	assert.equal(entry.details.cachePrefix, true);
	assert.deepEqual(f.calls.at(-1)!.context.messages.slice(0, -1), ai.normalizeContext({ messages: sdk.convertToLlm([...captured, final, assistant, result]) }).messages);
});
test("real SDK provider-prefix validation rejects later context mutation before sending", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close()); f.setLateTransform(); await f.warm();
	const entry = await f.session.compact();
	assert.notEqual(entry.details.cachePrefix, true);
	assert.ok(!f.calls.some((call) => textOf(call.context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST")), "mismatched full-context request was not sent");
	assert.ok(f.calls.some((call) => call.cacheRetention === "none"));
	assert.equal(JSON.parse(readFileSync(f.logFile, "utf8")).fallbackReason, "prefix-changed");
});
test("real SDK repeated hook compactions carry cumulative files in details and summary XML", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close()); await f.session.prompt("Old file work.");
	const final = f.session.messages.at(-1);
	const assistant = { ...final, content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "read-old.ts" } }, { type: "toolCall", id: "e", name: "edit", arguments: { path: "edit-old.ts" } }], stopReason: "toolUse", timestamp: final.timestamp + 1 };
	f.session.sessionManager.appendMessage(assistant);
	for (const id of ["r", "e"]) f.session.sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: id === "r" ? "read" : "edit", content: [{ type: "text", text: "done" }], isError: false, timestamp: final.timestamp + 2 });
	f.session.refreshContext(); await f.session.prompt("New user work.");
	const first = await f.session.compact();
	assert.deepEqual(first.details.readFiles, ["read-old.ts"]); assert.deepEqual(first.details.modifiedFiles, ["edit-old.ts"]);
	await f.session.prompt("Work after the first summary.");
	const second = await f.session.compact();
	assert.equal(second.details.cachePrefix, true);
	assert.deepEqual(second.details.readFiles, ["read-old.ts"]); assert.deepEqual(second.details.modifiedFiles, ["edit-old.ts"]);
	assert.match(second.summary, /<read-files>\nread-old.ts\n<\/read-files>/); assert.match(second.summary, /<modified-files>\nedit-old.ts\n<\/modified-files>/);
	const summaryRequest = f.calls.at(-1)!.context.messages;
	assert.match(textOf(summaryRequest.at(-1)), /summary already at the start/);
	assert.ok(summaryRequest.slice(0, -1).some((m: any) => textOf(m).includes("Prefix checkpoint.")), "previous summary is in the cached transcript");
	assert.doesNotMatch(textOf(summaryRequest.at(-1)), /Prefix checkpoint\./);
});

test("real SDK overflow and abort hook gates return undefined, never cancel", { timeout: 15000 }, async (t) => {
	for (const reason of ["overflow", "manual"]) {
		const f = await fixture(); t.after(() => f.close()); await f.warm();
		const controller = new AbortController(); if (reason === "manual") controller.abort();
		const { prepareCompaction } = await import(pathToFileURL(join(agentRoot, "dist/core/compaction/compaction.js")).href);
		const preparation = prepareCompaction(f.session.sessionManager.getBranch(), f.settingsManager.getCompactionSettings(f.session.model));
		const result = await f.session.extensionRunner.emit({ type: "session_before_compact", preparation, branchEntries: f.session.sessionManager.getBranch(), reason, willRetry: reason === "overflow", signal: controller.signal });
		assert.equal(result?.compaction, undefined); assert.notEqual(result?.cancel, true); assert.equal(f.calls.length, 2);
	}
});
for (const mode of ["after", "codex"] as const) test(`actual enabled ${mode} threshold compaction reuses prefix above window minus reserve`, { timeout: 15000 }, async (t) => {
	const f = await fixture(mode === "codex" ? "openai-codex-responses" : "anthropic-messages", true, mode); t.after(() => f.close());
	await f.session.prompt("Old task."); f.setUsage(184001); await f.session.prompt("Threshold task: " + "abcd ".repeat(2400));
	const entry = f.session.sessionManager.getEntries().filter((e: any) => e.type === "compaction").at(-1);
	assert.ok(entry, "automatic threshold actually ran"); assert.equal(entry.details.cachePrefix, true);
	assert.ok(entry.tokensBefore > 200000 - 16384);
	const request = f.calls.find((call) => textOf(call.context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST"))!;
	assert.ok(request);
	if (mode === "codex") assert.equal(request.payload.max_output_tokens, undefined);
});
for (const reserve of [16384, 32768]) test(`automatic updated 10k summary uses prefix only with sufficient reserve (${reserve})`, { timeout: 15000 }, async (t) => {
	const f = await fixture("anthropic-messages", true, "after", reserve); t.after(() => f.close());
	await f.session.prompt("Original task.");
	const kept = f.session.sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user").id;
	const previous = "Existing summary " + "abcd".repeat(10000);
	f.session.sessionManager.appendCompaction(previous, kept, 100000); f.session.refreshContext();
	await f.session.prompt("Earlier work after summary."); f.setUsage(200000 - reserve + 1000); await f.session.prompt("New retained work.");
	const entry = f.session.sessionManager.getEntries().filter((e: any) => e.type === "compaction").at(-1);
	assert.notEqual(entry.summary, previous);
	if (reserve === 16384) { assert.notEqual(entry.details?.cachePrefix, true); assert.ok(f.notices.includes("Compaction: default (context-window)")); }
	else {
		assert.equal(entry.details.cachePrefix, true);
		const request = f.calls.find((call) => textOf(call.context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST"))!;
		assert.ok(request.context.messages.slice(0, -1).some((message: any) => textOf(message).includes(previous)), "existing summary is already in the prefix");
		assert.ok(!textOf(request.context.messages.at(-1)).includes(previous));
		assert.ok(request.payload.max_tokens > 18000, "full available room is sent, not the floor");
	}
});
for (const inputKind of ["bash", "custom", "excluded-bash"]) test(`actual enabled pre-prompt threshold retains unsent ${inputKind} outside summary`, { timeout: 15000 }, async (t) => {
	const f = await fixture("anthropic-messages", true, "pre"); t.after(() => f.close());
	await f.session.prompt("Old task."); f.setUsage(184001); f.setResponse("aborted"); await f.session.prompt("Interrupted task.");
	assert.ok(!f.session.sessionManager.getEntries().some((e: any) => e.type === "compaction"), "aborted turn skips after-turn compaction");
	const input = "unsent-new-input-" + "x".repeat(740000);
	if (inputKind === "custom") await f.session.sendCustomMessage({ customType: "fixture-report", content: input, display: true }, { triggerTurn: false });
	else f.session.recordBashResult("printf synthetic", { output: input, exitCode: 0, cancelled: false, truncated: false }, { excludeFromContext: inputKind === "excluded-bash" });
	const keptId = f.session.sessionManager.getLeafId();
	f.setResponse("text"); f.setUsage(102);
	await f.session.prompt("Continue the retained input.");
	const entry = f.session.sessionManager.getEntries().filter((e: any) => e.type === "compaction").at(-1);
	assert.ok(entry); assert.equal(entry.details.cachePrefix, true);
	if (inputKind !== "excluded-bash") assert.equal(entry.firstKeptEntryId, keptId);
	const request = f.calls.find((call) => textOf(call.context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST"))!;
	assert.ok(request); assert.ok(!JSON.stringify(request.context).includes("unsent-new-input-"));
	assert.equal(f.calls.at(-1)!.context.messages.some((message: any) => textOf(message).includes(input)), inputKind !== "excluded-bash");
});
test("excluded bash in the captured transcript cannot change the provider prefix", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close()); await f.session.prompt("Old task.");
	f.session.recordBashResult("printf excluded", { output: "excluded-private-output", exitCode: 0, cancelled: false, truncated: false }, { excludeFromContext: true });
	await f.session.prompt("Retained task."); const entry = await f.session.compact();
	assert.equal(entry.details.cachePrefix, true); assert.ok(!JSON.stringify(f.calls.at(-1)!.context).includes("excluded-private-output"));
});
for (const api of ["anthropic-messages", "openai-responses", "openai-codex-responses"]) test(`${api} real warmer shape cannot consume pending capture and refreshes idle time`, { timeout: 15000 }, async (t) => {
	const f = await fixture(api); t.after(() => f.close()); f.simulateWarmer(); await f.warm();
	f.setTime(59000);
	const payload = f.calls.at(-1)!.payload;
	const warmer = api === "openai-codex-responses" ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "max_tokens")) : api === "openai-responses" ? { ...payload, max_output_tokens: 16 } : { ...payload, max_tokens: 2049 };
	await f.session.extensionRunner.emit({ type: "before_provider_request", payload: warmer }); f.setTime(5000);
	// An exact retry has no new pending context and must leave the real capture usable.
	await f.session.extensionRunner.emit({ type: "before_provider_request", payload });
	const entry = await f.session.compact(); assert.equal(entry.details.cachePrefix, true);
	assert.equal(f.calls.at(-1)!.payload.max_tokens, 2000);
	assert.equal(f.calls.at(-1)!.payload.max_output_tokens, undefined, "warmer cap was not captured");
});
for (const stopReason of ["aborted", "error"]) for (const suffix of ["visible", "unsent"]) test(`first kept ${stopReason} assistant identifies ${suffix} retained input`, { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close()); await f.warm();
	const final = f.session.messages.at(-1);
	const keptId = f.session.sessionManager.appendMessage({ ...final, content: [{ type: "text", text: "invisible-kept-content" }], stopReason, timestamp: final.timestamp + 1 });
	f.session.sessionManager.appendMessage(suffix === "visible" ? { ...final, content: [{ type: "text", text: "visible-kept-content" }], timestamp: final.timestamp + 2 } : { role: "user", content: "unsent-retained-input", timestamp: final.timestamp + 2 }); f.session.refreshContext();
	const { prepareCompaction } = await import(pathToFileURL(join(agentRoot, "dist/core/compaction/compaction.js")).href);
	const preparation = { ...prepareCompaction(f.session.sessionManager.getBranch(), f.settingsManager.getCompactionSettings(f.session.model)), firstKeptEntryId: keptId, messagesToSummarize: f.session.sessionManager.buildSessionProjection().messages.slice(1, -2), isSplitTurn: false, turnPrefixMessages: [] };
	const result = await f.session.extensionRunner.emit({ type: "session_before_compact", preparation, branchEntries: f.session.sessionManager.getBranch(), reason: "manual", willRetry: false, signal: new AbortController().signal });
	assert.equal(result.compaction.details.cachePrefix, true);
	const instruction = textOf(f.calls.at(-1)!.context.messages.at(-1)); assert.doesNotMatch(instruction, /invisible-kept-content/);
	assert.match(instruction, suffix === "visible" ? /visible-kept-content/ : /unsent user input/);
});
test("skew margin covers only the unanchored tail, including the instruction", () => {
	const messages: any[] = [{ role: "assistant", content: [], timestamp: 1, stopReason: "stop", usage: { ...usage, totalTokens: 84000 } }, { role: "assistant", content: [{ type: "text", text: "1234567890 ".repeat(728) }], timestamp: 2, stopReason: "stop", usage: { ...usage, input: 0, output: 0, cacheRead: 0, totalTokens: 0 } }, { role: "user", content: "x".repeat(2800), timestamp: 3 }];
	const estimate = estimateRequestContext(messages); assert.equal(estimate.tailTokens, 2702); assert.equal(estimate.tokens, 86702);
	assert.ok(100000 - estimate.tokens - 4096 >= 8000);
	assert.ok(100000 - estimate.tokens - contextSafetyTokens(estimate.tailTokens) < 8000);
	assert.equal(estimateRequestContext(messages.slice(1)).tailTokens, 2702, "without usage, all input is unanchored");
});
test("dense unanchored tail falls back despite fitting the old fixed margin", { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close()); f.setUsage(84000); await f.warm();
	const last = f.session.messages.at(-1);
	f.session.sessionManager.appendMessage({ ...last, content: [{ type: "text", text: "1234567890 ".repeat(728) }], timestamp: last.timestamp + 1, usage: { ...usage, input: 0, output: 0, cacheRead: 0, totalTokens: 0 } }); f.session.refreshContext();
	const entry = await f.session.compact();
	assert.notEqual(entry.details?.cachePrefix, true); assert.ok(f.notices.includes("Compaction: default (context-window)"));
	assert.ok(!f.calls.some((call) => textOf(call.context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST")), "no oversized prefix request was sent");
});
for (const mode of ["no-pending", "invalid-context", "invalid-payload"]) test(`uncaptured new ${mode} request invalidates the old capture`, { timeout: 15000 }, async (t) => {
	const f = await fixture(); t.after(() => f.close()); await f.warm();
	if (mode !== "no-pending") await f.session.extensionRunner.emit({ type: "context_with_system", messages: mode === "invalid-context" ? [] : f.session.sessionManager.buildSessionProjection().messages });
	const payload = mode === "invalid-payload" ? { model: "uncaptured" } : { ...f.calls.at(-1)!.payload, messages: [...f.calls.at(-1)!.payload.messages, { role: "user", content: "new real request" }] };
	await f.session.extensionRunner.emit({ type: "before_provider_request", payload });
	const entry = await f.session.compact(); assert.notEqual(entry.details?.cachePrefix, true);
	const expected = mode === "invalid-context" ? "capture-no-system" : mode === "invalid-payload" ? "capture-payload" : "capture-no-context";
	assert.equal(JSON.parse(readFileSync(f.logFile, "utf8")).fallbackReason, expected);
});
test("zero model output limit means uncapped, never a zero-token summary request", { timeout: 15000 }, async (t) => {
	const f = await fixture("anthropic-messages", true, undefined, 16384, 0); t.after(() => f.close()); await f.warm();
	const entry = await f.session.compact(); assert.equal(entry.details.cachePrefix, true);
	assert.ok(f.calls.at(-1)!.payload.max_tokens > 8000);
});
test("usage-anchored estimator matches Pi's own compaction helper", async () => {
	const { estimateContextTokens } = await import(pathToFileURL(join(agentRoot, "dist/core/compaction/compaction.js")).href);
	const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "toolCall", name: "read", arguments: { path: "a" } }], timestamp: 10, usage: { ...usage, totalTokens: 9000 }, stopReason: "stop" };
	const prefix = [{ role: "system", content: [{ type: "text", text: "system" }], sections: { one: "section", removed: null }, toolsAdded: [{ name: "read", parameters: { type: "object" } }], toolsRemoved: [{ name: "old" }], timestamp: 0 }, { role: "user", content: [{ type: "image", data: "synthetic", mimeType: "image/png" }, { type: "text", text: "old" }], timestamp: 1 }];
	for (const stopReason of ["stop", "aborted", "error"]) for (const time of [5, 15]) {
		const messages: any[] = [...prefix, { ...assistant, stopReason }, { role: "toolResult", content: [{ type: "text", text: "tail" }], timestamp: time }, { role: "user", content: "instruction", timestamp: 20 }];
		assert.equal(estimateRequestTokens(messages), estimateContextTokens(messages).tokens);
		assert.equal(estimateRequestTokens([...messages, { ...assistant, timestamp: 25 }]), estimateContextTokens([...messages, { ...assistant, timestamp: 25 }]).tokens);
	}
});
test("real SDK mirrors exact system folding and local-only compaction omissions without resurrecting context edits", async (t) => {
	const f = await fixture("openai-codex-responses"); t.after(() => f.close()); f.setInternalFilter();
	await f.session.sendCustomMessage({ customType: "remote-pi:relay-state", content: "local-only-startup", display: false }, { triggerTurn: false });
	await f.session.prompt("Historical task before prompt changes.");
	const sm = f.session.sessionManager;
	const errorIds: string[] = [];
	for (let index = 0; index < 4; index++) {
		sm.appendMessage({ role: "system", content: "", sections: { changing: index === 0 ? "x".repeat(60000) : `updated-section-${index}` }, timestamp: 10 + index });
		if (index % 2 === 0) {
			const errorId = sm.appendMessage({ ...f.session.messages.at(-1), stopReason: "error", content: [{ type: "text", text: `deleted-assistant-${index}` }], timestamp: 20 + index });
			errorIds.push(errorId); sm.appendContextEdit(errorId, null);
		}
	}
	await f.session.sendCustomMessage({ customType: "remote-pi:received-image", content: "local-only-image", display: true }, { triggerTurn: false });
	await f.session.prompt("Later historical work after the omitted preview.");
	await f.session.sendCustomMessage({ customType: "subagent-report", content: "Visible child report.", display: true }, { triggerTurn: false });
	await f.session.prompt("Retained recent request.");
	const canonical = sm.buildSessionProjection();
	assert.ok(canonical.messages.filter((message: any) => message.role === "system").length >= 5);
	for (const id of errorIds) assert.ok(!canonical.entries.some((entry: any) => entry.sourceEntry.id === id && entry.messages.length));
	const captured = f.calls.at(-1)!;
	assert.equal(f.captures.at(-1)!.filter((message: any) => message.role === "system").length, 1);
	assert.deepEqual(f.captures.at(-1)![0], ai.getCurrentSystemMessage(canonical.messages));
	const entry = await f.session.compact();
	assert.equal(entry.details?.cachePrefix, true);
	const summary = f.calls.at(-1)!;
	assert.deepEqual(summary.payload.input.slice(0, captured.payload.input.length), captured.payload.input);
	assert.doesNotMatch(JSON.stringify(summary.context), /local-only-|deleted-assistant-/);
	assert.match(JSON.stringify(summary.context), /Visible child report/);
	assert.deepEqual(f.errors, []);
});

// The control proves the fold itself succeeds here, so the rewrite alone causes the fallback.
for (const rewrite of [false, true]) test(`a context handler ${rewrite ? "rewriting user text remains rejected" : "that only prunes still shares the prefix"} after exact system folding`, async (t) => {
	const f = await fixture(); t.after(() => f.close()); await f.warm();
	f.session.sessionManager.appendMessage({ role: "system", content: "Additional prompt state.", timestamp: 17 });
	if (rewrite) f.setRewriteUser();
	else {
		f.setInternalFilter();
		await f.session.sendCustomMessage({ customType: "remote-pi:relay-state", content: "local-only-state", display: false }, { triggerTurn: false });
	}
	await f.session.prompt("Original retained user text.");
	assert.equal(f.calls.at(-1)!.context.messages.some((message: any) => textOf(message) === "Rewritten user text."), rewrite);
	assert.equal(f.captures.at(-1)!.filter((message: any) => message.role === "system").length, 1);
	assert.ok(f.session.sessionManager.buildSessionProjection().messages.filter((message: any) => message.role === "system").length > 1);
	const entry = await f.session.compact();
	assert.equal(entry.details?.cachePrefix === true, !rewrite);
	assert.equal(JSON.parse(readFileSync(f.logFile, "utf8")).fallbackReason, rewrite ? "capture-projection" : null);
	assert.equal(f.calls.some((call) => textOf(call.context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST")), !rewrite);
	assert.deepEqual(f.errors, []);
});

for (const boundary of ["visible", "lapsed-warning"]) test(`real Usage Guard omissions before and after the ${boundary} kept boundary still share the provider prefix`, async (t) => {
	const f = await fixture("anthropic-messages", true, undefined, 16384, undefined, true); t.after(() => f.close());
	const warn = async (text: string) => { await f.session.sendCustomMessage({ customType: GUARD_CUSTOM_TYPE, content: text, display: false, details: { key: "fixture|five_hour|95|1", reason: "band" } }, { triggerTurn: false }); return f.session.sessionManager.getLeafId(); };
	await warn("lapsed-warning-before"); await f.session.prompt("Old work before the retained boundary.");
	const keptId = f.session.sessionManager.appendMessage({ role: "user", content: "Visible retained boundary.", timestamp: Date.now() });
	const warningId = await warn("lapsed-warning-after");
	await f.session.prompt("Next visible retained request.");
	const captured = f.calls.at(-1)!;
	assert.doesNotMatch(JSON.stringify(captured.context), /lapsed-warning-/);
	assert.ok(f.session.sessionManager.buildSessionProjection().messages.some((message: any) => textOf(message) === "lapsed-warning-before"));
	const { prepareCompaction } = await import(pathToFileURL(join(agentRoot, "dist/core/compaction/compaction.js")).href);
	const canonical = f.session.sessionManager.buildSessionProjection().messages;
	const firstKeptEntryId = boundary === "visible" ? keptId : warningId;
	const keptIndex = canonical.findIndex((message: any) => textOf(message) === (boundary === "visible" ? "Visible retained boundary." : "lapsed-warning-after"));
	const preparation = { ...prepareCompaction(f.session.sessionManager.getBranch(), f.settingsManager.getCompactionSettings(f.session.model)), firstKeptEntryId, isSplitTurn: false, turnPrefixMessages: [], messagesToSummarize: canonical.slice(0, keptIndex).filter((message: any) => message.role !== "system") };
	const result = await f.session.extensionRunner.emit({ type: "session_before_compact", preparation, branchEntries: f.session.sessionManager.getBranch(), reason: "manual", willRetry: false, signal: new AbortController().signal });
	assert.equal(result?.compaction?.details?.cachePrefix, true);
	const summary = f.calls.at(-1)!;
	assert.deepEqual(summary.payload.messages.slice(0, captured.payload.messages.length), captured.payload.messages);
	assert.doesNotMatch(JSON.stringify(summary.context), /lapsed-warning-/);
	assert.match(textOf(summary.context.messages.at(-1)), boundary === "visible" ? /Visible retained boundary/ : /Next visible retained request/);
	assert.deepEqual(f.errors, []);
});

test("first large Anthropic threshold compaction preserves startup custom messages before the initial system prompt", { timeout: 15000 }, async (t) => {
	const f = await fixture("anthropic-messages", true, "large-anthropic", 24576); t.after(() => f.close());
	await f.session.sendCustomMessage({ customType: "startup-state", content: "Startup metadata before any request.", display: false }, { triggerTurn: false });
	await f.session.prompt("Old large-context work.");
	f.setUsage(476261); await f.session.prompt("Retained tool-use work.");
	assert.equal(f.captures[0][0].role, "custom", "the SDK does not require a leading system message");
	assert.ok(f.captures[0].some((message: any) => message.role === "system"));
	const entry = f.session.sessionManager.getEntries().find((entry: any) => entry.type === "compaction");
	assert.ok(entry); assert.equal(entry.details?.cachePrefix, true);
	assert.ok(entry.tokensBefore >= 476261);
	const summary = f.calls.find((call) => textOf(call.context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST"));
	assert.ok(summary); assert.ok(summary.context.messages.some((message: any) => message.role === "toolResult" && textOf(message) === "Small result."));
	const decision = JSON.parse(readFileSync(f.logFile, "utf8"));
	assert.equal(decision.path, "prefix-sharing"); assert.ok(decision.available > decision.floor);
	assert.deepEqual(f.errors, []);
});

test("every decision is durable, unthrottled and content-free, including failed prefix responses", async (t) => {
	const f = await fixture(); t.after(() => f.close()); await f.warm();
	await f.session.compact("private-focus-marker");
	await f.session.prompt("private-request-marker"); f.setResponse("length");
	await f.session.compact();
	const lines = readFileSync(f.logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.equal(statSync(f.logFile).mode & 0o777, 0o600);
	for (const line of lines) {
		assert.ok(Number.isFinite(Date.parse(line.time)));
		assert.equal(line.sessionId, f.session.sessionId);
		assert.equal(line.provider, "fixture"); assert.equal(line.model, "model"); assert.equal(line.reason, "manual");
		for (const key of ["tokensBefore", "estimate", "available", "floor", "tailTokens"]) assert.equal(typeof line[key], "number", key);
		assert.deepEqual(line.usage, { input: 10, cacheRead: 90, cacheWrite: 0, output: 2 });
	}
	assert.equal(lines[0].path, "prefix-sharing"); assert.equal(lines[0].fallbackReason, null); assert.equal(lines[0].stopReason, "stop");
	assert.equal(lines[1].path, "default"); assert.equal(lines[1].fallbackReason, "length"); assert.equal(lines[1].stopReason, "length");
	assert.doesNotMatch(readFileSync(f.logFile, "utf8"), /private-|checkpoint|headers|payload|summary|Fixture reply/);
});
test("early default decisions record unknown estimates and logging cannot break compaction", async (t) => {
	const f = await fixture("anthropic-messages", false); t.after(() => f.close()); await f.warm();
	await f.session.compact();
	const line = JSON.parse(readFileSync(f.logFile, "utf8"));
	assert.equal(line.fallbackReason, "disabled"); assert.equal(line.path, "default"); assert.equal(line.estimate, null); assert.equal(line.available, null); assert.equal(line.tailTokens, null); assert.equal(line.floor, 8000);
	rmSync(f.logFile); mkdirSync(f.logFile);
	await f.session.prompt("Next work");
	await assert.doesNotReject(() => f.session.compact());
	assert.deepEqual(f.errors, []);
});
after(() => { globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
