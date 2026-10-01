/** The actual child launcher, with real SDK hooks and a local synthetic provider. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "cache-child-sdk-"));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Child fixture must not contact a provider"); };
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const { createLauncher } = await import("../lib/subagents/child.ts");
const textOf = (m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

for (const age of [0, 239000, 240000]) test(`child threshold compaction captures its own request and uses the shared 240s idle default on Codex (${age}ms)`, { timeout: 15000 }, async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 24576, keepRecentTokens: 1 }, retry: { enabled: false }, cacheWarming: "off" }));
	writeFileSync(join(agentDir, "pi-extras.json"), JSON.stringify({ cacheCompaction: { enabled: true } }));
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	let now = 1800000000000;
	const originalNow = Date.now;
	Date.now = () => now;
	const calls: any[] = [], errors: unknown[] = [];
	const usage = { input: 10, output: 2, cacheRead: 90, cacheWrite: 0, totalTokens: 102, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	runtime.registerProvider("openai-codex", { api: "openai-codex-responses", apiKey: "synthetic", baseUrl: "http://127.0.0.1:1", models: [{ id: "child-fixture", name: "child fixture", reasoning: false, input: ["text"], contextWindow: 272000, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model: any, context: any, options: any) {
			const stream = new ai.AssistantMessageEventStream();
			void (async () => {
				const generated = { input: structuredClone(context.messages), tools: [], model: model.id, prompt_cache_key: options.sessionId };
				const payload = await options.onPayload?.(generated, model) ?? generated;
				const prefix = textOf(context.messages.at(-1)).includes("COMPACTION CHECKPOINT REQUEST");
				calls.push({ payload, sessionId: options.sessionId, prefix, cacheRetention: options.cacheRetention });
				const high = calls.length === 2;
				if (high) now += age;
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: now, content: [{ type: "text", text: prefix ? "## Goal\nChild checkpoint." : "Child reply." }], stopReason: "stop", usage: high ? { ...usage, cacheRead: 247988, totalTokens: 248000 } : usage };
				stream.push({ type: "done", reason: "stop", message }); stream.end();
			})().catch((error) => stream.end(error));
			return stream;
		},
	});
	let session: any;
	const launcher = createLauncher({ sdk: { ...sdk, createAgentSession: async (options: any) => { const result = await sdk.createAgentSession(options); session = result.session; return result; } } as never, agentDir, cwd: scratch, sessionDir: null, modelRuntime: async () => runtime, toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "Child fixture instructions.", onExtensionError: (error) => errors.push(error) });
	const record = { name: "child", parent: "main", depth: 1, task: "fixture", model: "openai-codex/child-fixture", thinking: "off", readOnly: false, fork: false, blocking: false, state: "starting", createdAt: now, activity: null, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, runs: 1 };
	const child = await launcher.launch(record as never, { update() {} });
	try {
		assert.equal(session.extensionRunner.hasHandlers("session_before_compact"), true);
		await child.prompt("Old child work."); await child.prompt("Child threshold work.");
		const entry = session.sessionManager.getEntries().findLast((e: any) => e.type === "compaction");
		assert.ok(entry, "Pi's actual threshold hook ran in the child");
		assert.equal(entry.tokensBefore, 248000);
		assert.equal(entry.details?.cachePrefix === true, age < 240000);
		const line = readFileSync(join(agentDir, "cache-compaction.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
		assert.equal(line.sessionId, session.sessionId); assert.equal(line.reason, "threshold");
		assert.equal(line.fallbackReason, age < 240000 ? null : "cold-cache");
		if (age < 240000) {
			const summary = calls.find((call) => call.prefix); assert.ok(summary);
			assert.equal(summary.sessionId, session.sessionId);
			assert.deepEqual(summary.payload.input.slice(0, calls[1].payload.input.length), calls[1].payload.input);
			assert.notEqual(summary.cacheRetention, "none");
		}
		assert.deepEqual(errors, []);
	} finally { await child.dispose(); Date.now = originalNow; }
});
after(() => { globalThis.fetch = originalFetch; rmSync(scratch, { recursive: true, force: true }); });
