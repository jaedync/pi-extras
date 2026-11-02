import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";
import cacheCompaction from "../extensions/cache-compaction.ts";

const scratch = mkdtempSync(join(tmpdir(), "overflow-sdk-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Overflow fixture must never reach a real provider"); };
after(() => { globalThis.fetch = originalFetch; });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href);

const WINDOW = 100_000;
const MAX_TOKENS = 32_768;
// A tokenizer that counts 1.4 times Pi's chars/4 estimate, as the local model in the stalled session did.
const TOKENS_PER_CHAR = 0.35;
const blockChars = (block: any) => block.type === "text" ? block.text.length : block.type === "thinking" ? block.thinking.length : block.type === "toolCall" ? block.name.length + JSON.stringify(block.arguments ?? {}).length : 0;
const messageChars = (message: any) => typeof message.content === "string" ? message.content.length : (message.content ?? []).reduce((sum: number, block: any) => sum + blockChars(block), 0);
const contextChars = (context: any) => (context.systemPrompt?.length ?? 0) + context.messages.reduce((sum: number, message: any) => sum + messageChars(message), 0);
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture() {
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ cacheCompaction: { enabled: true } }));
	const requests: Array<{ summary: boolean; tokens: number; maxTokens: number; rejected: boolean }> = [];
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("engine", { api: "openai-completions", apiKey: "synthetic-not-a-credential", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "local", name: "local", reasoning: false, input: ["text"], contextWindow: WINDOW, maxTokens: MAX_TOKENS, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, context: any, options: any) {
			const stream = new ai.AssistantMessageEventStream();
			const chars = contextChars(context);
			const tokens = Math.ceil(chars * TOKENS_PER_CHAR);
			// pi-ai's clamp: the window minus its own chars/3.5 estimate and a 4096-token margin.
			const maxTokens = Math.min(options?.maxTokens ?? model.maxTokens, Math.max(1, WINDOW - Math.ceil(chars / 3.5) - 4096));
			const summary = /summariz/i.test(context.systemPrompt ?? "") || context.messages.some((m: any) => m.role === "system" && /summariz/i.test(messageChars(m) ? JSON.stringify(m.content) : ""));
			const rejected = tokens + maxTokens > WINDOW;
			requests.push({ summary, tokens, maxTokens, rejected });
			const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
			void (async () => {
				await options?.onPayload?.({ model: model.id, messages: structuredClone(context.messages), max_tokens: maxTokens }, model);
				if (rejected) {
					const errorMessage = `400: {"message":"The prompt (${tokens} tokens) plus max_tokens (${maxTokens}) exceeds the context window of ${WINDOW} tokens.","type":"invalid_request_error","param":"max_tokens","code":null}`;
					stream.push({ type: "error", reason: "error", error: { ...base, content: [], stopReason: "error", errorMessage, usage: zero } });
				} else {
					const usage = { ...zero, cacheRead: tokens, output: 8, totalTokens: tokens + 8 };
					stream.push({ type: "done", reason: "stop", message: { ...base, content: [{ type: "text", text: summary ? `## Goal\nSummary ${requests.length}.` : "Engine reply." }], stopReason: "stop", usage } });
				}
				stream.end();
			})();
			return stream;
		},
	});
	const model = runtime.getModel("engine", "local")!;
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 2000, reserveTokens: 16384 }, cacheWarming: "off", retry: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => cacheCompaction(pi, { configFile, settingsManager })] });
	await loader.reload();
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "all" });
	const failures: string[] = [];
	session.subscribe((event: any) => { if (event.type === "compaction_end" && event.errorMessage) failures.push(event.errorMessage); });
	await session.bindExtensions({ mode: "print", onError: () => {} });
	return { session, requests, failures, logFile: join(agentDir, "cache-compaction.log"), close() { session.dispose(); } };
}

/** 29 earlier turns of about 2,000 estimated tokens each, every reply with the usage this tokenizer reports. */
function seed(session: any) {
	const system = session.sessionManager.buildSessionProjection().messages.filter((m: any) => m.role === "system").reduce((sum: number, m: any) => sum + messageChars(m), 0) + (session.systemPrompt?.length ?? 0);
	let chars = system;
	let at = Date.now() - 1_000_000;
	for (let turn = 0; turn < 29; turn++) {
		const text = `Turn ${turn}: ${"lorem ipsum dolor ".repeat(444)}`;
		session.sessionManager.appendMessage({ role: "user", content: text, timestamp: at++ });
		chars += text.length;
		const tokens = Math.ceil(chars * TOKENS_PER_CHAR);
		session.sessionManager.appendMessage({ role: "assistant", api: "openai-completions", provider: "engine", model: "local", content: [{ type: "text", text: "Engine reply." }], stopReason: "stop", timestamp: at++, usage: { ...zero, cacheRead: tokens, output: 8, totalTokens: tokens + 8 } });
		chars += "Engine reply.".length;
	}
	session.refreshContext();
}

test("an overflow on a tokenizer that Pi underestimates compacts with summaries that fit, and the turn continues", { timeout: 30000 }, async (t) => {
	const f = fixture(); const { session, requests, failures, logFile, close } = await f; t.after(close);
	seed(session);
	await session.prompt("Continue the work.");
	const compactions = session.sessionManager.getEntries().filter((entry: any) => entry.type === "compaction");
	const last = session.messages.at(-1);
	assert.deepEqual(failures, [], "compaction must not fail");
	assert.equal(compactions.length, 1, "the overflow produced one compaction");
	assert.equal(last.role, "assistant");
	assert.equal(last.stopReason, "stop", "the retried turn got a reply");
	assert.ok(requests.filter((r) => r.summary).every((r) => !r.rejected), "no summary request overflowed the window");
	assert.ok(requests.filter((r) => r.summary).length >= 2, "the history went out in more than one summary request");
	const decision = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n").at(-1)!);
	assert.equal(decision.path, "bounded");
	assert.equal(decision.reason, "overflow");
	assert.equal(decision.fallbackReason, "overflow", "the main turn was captured, as in the stalled session");
	await session.prompt("Next step.");
	assert.equal(session.messages.at(-1).stopReason, "stop", "the session keeps working after the compaction");
	assert.deepEqual(failures, []);
});
