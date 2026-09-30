/** Real pi-ai payload builders and transports, confined to loopback with synthetic credentials. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
import cacheCompaction from "../extensions/cache-compaction.ts";

const scratch = mkdtempSync(join(tmpdir(), "compaction-http-"));
const originalFetch = globalThis.fetch;
const allowed = new Set<string>();
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.ok(allowed.has(url.origin), "Only the local fixture may receive requests");
	return originalFetch(input, init);
};
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const sse = (res: ServerResponse, type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
function success(res: ServerResponse, api: string, model: string): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (api === "anthropic-messages") {
		sse(res, "message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 8, output_tokens: 0 } } });
		sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "Local checkpoint." } });
		sse(res, "content_block_stop", { index: 0 });
		sse(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
		sse(res, "message_stop", {});
	} else {
		const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Local checkpoint.", annotations: [] }] };
		sse(res, "response.created", { response: { id: "resp_fixture", status: "in_progress" } });
		sse(res, "response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
		sse(res, "response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "Local checkpoint." });
		sse(res, "response.output_item.done", { output_index: 0, item });
		sse(res, "response.completed", { response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } });
	}
	res.end();
}

for (const mode of ["anthropic-adaptive", "anthropic-managed", "responses"]) test(`real HTTP ${mode} keeps native fields, session routing and request options`, { timeout: 15000 }, async (t) => {
	const api = mode === "responses" ? "openai-responses" : "anthropic-messages";
	const key = mode === "responses" ? "input" : "messages";
	const requests: { body: any; routing?: string }[] = [];
	const errors: unknown[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString());
				requests.push({ body, routing: req.headers["x-compaction-route"] as string });
				// A single provider retry proves complete() didn't silently use default zero retries.
				if (requests.length === 3) { res.writeHead(500, { "content-type": "application/json", "retry-after-ms": "1" }); res.end(JSON.stringify({ error: { type: "api_error", message: "Synthetic retry" } })); }
				else success(res, api, body.model);
			} catch (error) { errors.push(error); res.writeHead(500).end(); }
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`; allowed.add(origin);
	t.after(async () => { allowed.delete(origin); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	const configFile = join(agentDir, "pi-extras.json"); writeFileSync(configFile, "{}");
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("fixture", { api, baseUrl: origin + "/v1", apiKey: "synthetic-not-a-credential", models: [{ id: mode === "responses" ? "gpt-fixture" : "claude-fixture", name: "fixture", reasoning: true, thinkingLevelMap: mode === "anthropic-managed" ? { high: "xhigh" } : undefined, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: mode === "responses" ? { supportsReasoning: true } : { forceAdaptiveThinking: true, supportsMidConvoEffort: mode === "anthropic-managed" } }] });
	const model = runtime.getModel("fixture", mode === "responses" ? "gpt-fixture" : "claude-fixture")!;
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off", httpIdleTimeoutMs: 43000, websocketConnectTimeoutMs: 17000, retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 5000, timeoutMs: 42000 } } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi: any) => {
		pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Synthetic declaration", parameters: { type: "object", properties: { path: { type: "string" } } }, execute: async () => ({ content: [], details: undefined }) });
		pi.on("before_provider_headers", (event: any) => { event.headers["x-compaction-route"] = "synthetic-route"; event.headers["x-session-secret"] = "synthetic-must-not-be-captured"; });
		cacheCompaction(pi, { configFile, settingsManager });
	}] });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "high", settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "builtin" });
	t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
	await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
	session.setActiveToolsByName(["fixture_tool"]);
	await session.prompt("Old task."); await session.prompt("Retained task.");
	const complete = runtime.complete.bind(runtime); let options: any;
	runtime.complete = (m: any, context: any, opts: any) => { options = opts; return complete(m, context, opts); };
	const entry = await session.compact();
	assert.equal(entry.details.cachePrefix, true);
	assert.equal(requests.length, 4, "one prefix attempt plus one configured retry, no native fallback");
	const original = requests[1]!.body; const summary = requests[3]!.body;
	const { [key]: before, ...originalFields } = original; const { [key]: conversation, ...summaryFields } = summary;
	assert.deepEqual(summaryFields, originalFields, "only the conversation array changes");
	assert.ok(conversation.length > before.length);
	assert.ok(summary.tools.length); assert.equal(options.sessionId, session.sessionId);
	assert.equal(options.timeoutMs, 42000); assert.equal(options.maxRetries, 1); assert.equal(options.maxRetryDelayMs, 5000); assert.equal(options.websocketConnectTimeoutMs, 17000);
	assert.equal(options.headers["x-compaction-route"], "synthetic-route"); assert.equal(options.headers["x-session-secret"], undefined);
	assert.equal(requests[3]!.routing, "synthetic-route");
	if (api === "anthropic-messages") {
		assert.ok(summary.system[0].cache_control); assert.ok(summary.tools.at(-1).cache_control);
		assert.equal(summary.thinking.type, "adaptive"); assert.equal(summary.max_tokens, 4096);
		assert.equal(summary.output_config.effort, original.output_config.effort);
		if (mode === "anthropic-managed") { assert.equal(before.at(-1).output_config.effort, "xhigh"); assert.equal(options.effort, "xhigh"); assert.equal(conversation.at(-1).output_config.effort, "xhigh"); }
	} else {
		assert.ok(summary.reasoning.effort); assert.equal(summary.max_output_tokens, 4096);
		assert.equal(summary.prompt_cache_key, session.sessionId); assert.equal(summary.store, false);
	}
	assert.deepEqual(errors, []);
});
after(() => { globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
