/** Real pi-ai openai-completions payloads and SSE transport against a loopback chat-completions fixture. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
import cacheCompaction from "../extensions/cache-compaction.ts";
import { estimateRequestContext, contextSafetyTokens } from "../lib/cache-compaction/estimate.ts";

const scratch = mkdtempSync(join(tmpdir(), "compaction-completions-"));
const originalFetch = globalThis.fetch;
const allowed = new Set<string>();
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.ok(allowed.has(url.origin), "Only the local fixture may receive requests");
	return originalFetch(input, init);
};
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
// The compat a strict local engine uses in Pi's models.json.
const ENGINE_COMPAT = { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: "max_tokens", thinkingFormat: "openai" };
const isSummary = (body: any) => JSON.stringify(body.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST");

interface Reply { readonly reasoning?: string; readonly text?: string; readonly toolCall?: { id: string; name: string; arguments: string }; readonly prompt: number; readonly cached?: number }
function reply(res: ServerResponse, model: string, r: Reply): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	chunk({ role: "assistant" });
	if (r.reasoning) chunk({ reasoning_content: r.reasoning });
	if (r.text) chunk({ content: r.text });
	if (r.toolCall) chunk({ tool_calls: [{ index: 0, id: r.toolCall.id, type: "function", function: { name: r.toolCall.name, arguments: r.toolCall.arguments } }] });
	chunk({}, r.toolCall ? "tool_calls" : "stop");
	res.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: r.prompt, completion_tokens: 4, total_tokens: r.prompt + 4, prompt_tokens_details: { cached_tokens: r.cached ?? 0 } } })}\n\n`);
	res.end("data: [DONE]\n\n");
}
async function serve(t: any, respond: (body: any, index: number) => Reply) {
	const requests: any[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => { const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body); reply(res, body.model, respond(body, requests.length - 1)); });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`; allowed.add(origin);
	t.after(async () => { allowed.delete(origin); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	return { requests, baseUrl: origin + "/v1" };
}
async function startSession(t: any, baseUrl: string, contextWindow: number, settings: object, notices: string[] = []) {
	let executions = 0;
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	const configFile = join(agentDir, "pi-extras.json"); writeFileSync(configFile, "{}");
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("engine", { api: "openai-completions", baseUrl, apiKey: "synthetic-not-a-credential", models: [{ id: "engine-fixture", name: "fixture", reasoning: true, compat: ENGINE_COMPAT, input: ["text"], contextWindow, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
	const model = runtime.getModel("engine", "engine-fixture")!;
	const settingsManager = sdk.SettingsManager.inMemory({ cacheWarming: "off", transport: "sse", retry: { enabled: false }, ...settings });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi: any) => {
		pi.registerTool({ name: "fixture_read", label: "Read", description: "Synthetic read", parameters: { type: "object", properties: { path: { type: "string" } } }, execute: async () => { executions++; return { content: [{ type: "text", text: "synthetic file body" }], details: undefined }; } });
		cacheCompaction(pi, { configFile, settingsManager });
	}] });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	const created = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "high", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "builtin" });
	t.after(async () => { await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); created.session.dispose(); });
	await created.session.bindExtensions({ mode: "tui", uiContext: { notify: (text: string) => notices.push(text) } });
	created.session.setActiveToolsByName(["fixture_read"]);
	return { session: created.session, runtime, executed: () => executions };
}

test("real HTTP openai-completions replays the exact chat prefix with tools, reasoning and tool results", { timeout: 15000 }, async (t) => {
	const { requests, baseUrl } = await serve(t, (body, index) => isSummary(body) ? { reasoning: "Extract briefly.", text: "## Goal\nSynthetic checkpoint.", prompt: 900, cached: 850 }
		: index === 0 ? { reasoning: "Read the file first.", toolCall: { id: "call_fixture_1", name: "fixture_read", arguments: "{\"path\":\"notes.txt\"}" }, prompt: 300 }
		: { reasoning: "Answer now.", text: "Done.", prompt: 400 });
	const { session } = await startSession(t, baseUrl, 100000, { compaction: { enabled: false, keepRecentTokens: 1 } });
	await session.prompt("Old task: read notes.txt."); await session.prompt("Retained task: report the result.");
	const entry = await session.compact();
	assert.equal(entry.details.cachePrefix, true);
	assert.equal(requests.length, 4);
	const original = requests[2]; const summary = requests[3];
	const { messages: before, ...originalFields } = original; const { messages: conversation, ...summaryFields } = summary;
	assert.deepEqual(summaryFields, originalFields, "system tools, effort, stream options and cap are the last turn's");
	assert.equal(summary.reasoning_effort, "high"); assert.deepEqual(summary.stream_options, { include_usage: true });
	assert.equal(summary.max_tokens, 32768); assert.equal("tool_choice" in summary, false); assert.ok(summary.tools.length);
	assert.deepEqual(conversation.slice(0, before.length), before, "every earlier message is byte-identical");
	assert.equal(conversation.length, before.length + 2, "the last answer plus one instruction");
	assert.deepEqual(conversation.at(-2), { role: "assistant", content: "Done.", reasoning_content: "Answer now." });
	assert.equal(conversation.at(-1).role, "user"); assert.match(JSON.stringify(conversation.at(-1)), /Do not call tools/);
	assert.ok(before.some((m: any) => m.role === "tool" && m.tool_call_id === "call_fixture_1"));
	assert.ok(before.some((m: any) => m.role === "assistant" && m.tool_calls?.[0]?.function.name === "fixture_read" && m.reasoning_content === "Read the file first."));
	assert.equal(entry.usage.cacheRead, 850); assert.equal(entry.usage.input, 50);
	assert.match(entry.summary, /Synthetic checkpoint/);
});

test("real HTTP openai-completions summary tool call falls back without running the tool", { timeout: 15000 }, async (t) => {
	const { requests, baseUrl } = await serve(t, (body) => isSummary(body) ? { toolCall: { id: "call_summary", name: "fixture_read", arguments: "{}" }, prompt: 500 } : { text: "## Goal\nDefault path.", prompt: 200 });
	const notices: string[] = [];
	const { session, executed } = await startSession(t, baseUrl, 100000, { compaction: { enabled: false, keepRecentTokens: 1 } }, notices);
	await session.prompt("Old task."); await session.prompt("Retained task.");
	const entry = await session.compact();
	assert.notEqual(entry.details?.cachePrefix, true);
	assert.ok(notices.includes("Compaction: default (unusable-summary)"));
	assert.equal(executed(), 0);
	// Two turns, the refused summary, then Pi's own summary requests (history and split-turn prefix).
	assert.deepEqual(requests.map(isSummary), [false, false, true, ...requests.slice(3).map(() => false)]);
	assert.ok(requests.length > 3);
});

// Example: a 258,048-token window with compaction.reserveTokens 24,576 triggers at 233,472 tokens.
for (const room of ["enough", "too-small"]) test(`real HTTP openai-completions automatic compaction at a 258,048 window and 24,576 reserve (${room})`, { timeout: 15000 }, async (t) => {
	let summaryEstimate = 0; let summaryMargin = 0;
	const { requests, baseUrl } = await serve(t, (body, index) => isSummary(body) ? { text: "## Goal\nSynthetic checkpoint.", prompt: 8, cached: 0 } : { text: "Done.", prompt: index === 0 ? 200000 : room === "enough" ? 234000 : 246500 });
	const notices: string[] = [];
	const { session, runtime } = await startSession(t, baseUrl, 258048, { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 24576 } }, notices);
	const estimator = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/utils/estimate.js")).href);
	const stream = runtime.stream.bind(runtime);
	runtime.stream = (m: any, context: any, opts: any) => { if (JSON.stringify(context).includes("COMPACTION CHECKPOINT REQUEST")) { summaryEstimate = estimator.estimateContextTokens(ai.normalizeContext(context)).tokens; summaryMargin = contextSafetyTokens(estimateRequestContext(context.messages).tailTokens); } return stream(m, context, opts); };
	await session.prompt("Earlier discarded task."); await session.prompt("Retained synthetic log: " + "abcd ".repeat(2400));
	const entry = session.sessionManager.getEntries().filter((e: any) => e.type === "compaction").at(-1); assert.ok(entry); assert.ok(entry.tokensBefore > 258048 - 24576);
	if (room === "enough") {
		assert.equal(entry.details.cachePrefix, true); assert.ok(notices.includes("Compaction: prefix-sharing"));
		const cap = requests.at(-1).max_tokens;
		assert.equal(cap, Math.min(32768, 258048 - summaryEstimate - summaryMargin)); assert.ok(summaryEstimate + cap <= 258048);
		assert.ok(cap >= 8000, "the first summary floor fits at this trigger");
		assert.ok(cap < requests[1].max_tokens, "the captured cap would overrun the window");
	} else {
		assert.notEqual(entry.details?.cachePrefix, true); assert.ok(notices.includes("Compaction: default (context-window)"));
		assert.equal(summaryEstimate, 0, "no prefix request below the summary floor");
	}
});
after(() => { globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
