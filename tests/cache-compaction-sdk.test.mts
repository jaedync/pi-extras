import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
import cacheCompaction from "../extensions/cache-compaction.ts";
import { estimateRequestTokens } from "../lib/cache-compaction/estimate.ts";

const scratch = mkdtempSync(join(tmpdir(), "prefix-sdk-"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Prefix fixture must never reach a real provider"); };
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const usage = { input: 10, output: 2, cacheRead: 90, cacheWrite: 0, totalTokens: 102, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const textOf = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

async function fixture(api = "anthropic-messages", enabled = true, automatic?: "after" | "pre" | "codex", reserveTokens = 16384) {
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	mkdirSync(agentDir, { recursive: true });
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ cacheCompaction: { enabled, idleSeconds: { fixture: 60 } } }));
	let now = 1_800_000_000_000;
	let responseMode = "text";
	let lateTransform = false;
	let usageTokens = 102;
	let simulateWarmer = false;
	const notices: string[] = [];
	const calls: Array<{ context: any; payload: any; sessionId: string; cacheRetention?: string }> = [];
	const captures: any[][] = [];
	const errors: unknown[] = [];
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const key = api.includes("responses") ? "input" : api.startsWith("google") ? "contents" : "messages";
	runtime.registerProvider("fixture", { api, apiKey: "synthetic-not-a-credential", baseUrl: "http://127.0.0.1:1", models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: automatic ? 200000 : 100000, maxTokens: automatic ? 32000 : 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
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
					const content = isPrefix && responseMode === "empty" ? [] : isPrefix && responseMode === "tool" ? [{ type: "toolCall", id: "not-executed", name: "read", arguments: {} }] : [{ type: "text", text: isPrefix ? "## Goal\nPrefix checkpoint." : "Fixture reply." }];
					const stopReason = !isPrefix && responseMode === "aborted" ? "aborted" : isPrefix && responseMode === "error" ? "error" : isPrefix && responseMode === "length" ? "length" : "stop";
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
		extensionFactories: [(pi: any) => { cacheCompaction(pi, { configFile, now: () => now, settingsManager }); pi.on("context_with_system", (event: any) => {
			captures.push(structuredClone(event.messages));
			if (lateTransform) {
				const last = event.messages.at(-1);
				event.messages[event.messages.length - 1] = { ...last, content: [{ type: "text", text: `${textOf(last)} transformed after capture` }] };
			}
		}); }] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "all" });
	await session.bindExtensions({ mode: "tui", uiContext: { notify: (text: string) => { notices.push(text); if (process.env.PREFIX_TEST_DEBUG) console.error(text); } }, onError: (error: unknown) => errors.push(error) });
	return { session, calls, captures, errors, notices, configFile, settingsManager, simulateWarmer: () => { simulateWarmer = true; }, setUsage: (tokens: number) => { usageTokens = tokens; }, setLateTransform: () => { lateTransform = true; }, setTime: (n: number) => { now += n; }, setResponse: (mode: string) => { responseMode = mode; }, async warm() { await session.prompt("Old task: preserve file paths and decision."); await session.prompt("Recent task: next step is run the tests."); }, async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } };
}

for (const api of ["anthropic-messages", "openai-codex-responses", "openai-responses", "google-generative-ai"]) {
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
		const f = await fixture(condition === "unsupported" ? "openai-completions" : "anthropic-messages", condition !== "disabled"); t.after(() => f.close());
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
after(() => { globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
