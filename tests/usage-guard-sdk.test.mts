import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "usage-sdk-"));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Usage fixture must never reach a real provider"); };
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href);
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const { default: usageGuard, GUARD_CUSTOM_TYPE } = await import("../extensions/usage-guard.ts");
const { createLimitStore } = await import("../lib/limit-store.ts");
const NOW = 1_800_000_000_000;
const RESET = NOW + 3_600_000;
const CLAUDE = "claude-sonnet-5-5";
const CODEX = "gpt-6.1-sol";
const FABLE = "claude-fable-5-1";

async function fixture(historical = false, pauseFirst = false) {
	let releaseFirst = () => {};
	let started!: () => void;
	const firstStarted = new Promise<void>((resolve) => { started = resolve; });
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ usageGuard: { enabled: true, bands: [95, 98] } }));
	const store = createLimitStore();
	const calls: Array<{ provider: string; messages: any[] }> = [];
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	for (const [provider, ids] of [["anthropic", [CLAUDE, FABLE]], ["openai-codex", [CODEX]]] as const) {
		runtime.registerProvider(provider, {
			api: "openai-completions", apiKey: "synthetic-not-a-credential", baseUrl: "http://127.0.0.1:1",
			models: ids.map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
			streamSimple(model: any, context: any) {
				calls.push({ provider: model.provider, messages: [...context.messages] });
				const stream = new ai.AssistantMessageEventStream();
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "Fixture reply." }], stopReason: "stop", timestamp: NOW,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				const finish = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(); };
				if (pauseFirst && calls.length === 1) releaseFirst = finish;
				else finish();
				started();
				return stream;
			},
		});
	}
	const model = (provider: string, id: string) => runtime.getModel(provider, id)!;
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: any) => usageGuard(pi, { store, configFile, now: () => NOW })] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const sessionManager = sdk.SessionManager.inMemory(scratch);
	if (historical) sessionManager.appendCustomMessageEntry(GUARD_CUSTOM_TYPE, "Usage warning: old Claude warning", true, { key: `anthropic|five_hour|95|${RESET}`, reason: "band" });
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: model("anthropic", CLAUDE), settingsManager, resourceLoader: loader, sessionManager, noTools: "all" });
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
	return { session, model, store, calls, errors, firstStarted, release: () => releaseFirst(), async close() {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	} };
}

function poll(f: Awaited<ReturnType<typeof fixture>>, fableOnly = false) {
	f.store.set("anthropic", { entries: [fableOnly
		? { label: "7d-fable", key: "seven_day_fable", modelFamily: "fable", usedPct: 98, resetMs: RESET }
		: { label: "5h", key: "five_hour", usedPct: 98, resetMs: RESET }], atMs: NOW, source: "poll" });
	f.store.set("openai-codex", { entries: [{ label: "7d", key: "primary", usedPct: 21, resetMs: RESET }], atMs: NOW, source: "poll" });
}
const textOf = (message: any): string => typeof message.content === "string" ? message.content : message.content.map((block: any) => block.type === "text" ? block.text : "").join("\n");
const warnings = (messages: any[]) => messages.filter((message) => /^Usage (notice|warning):/.test(textOf(message)));

test("an idle Claude warning cannot follow a user model switch to Codex, and no extra calls start", { timeout: 10_000 }, async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	poll(f);
	assert.equal(f.calls.length, 0);
	assert.equal(f.session.sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === GUARD_CUSTOM_TYPE).length, 0);
	await f.session.setModel(f.model("openai-codex", CODEX));
	await f.session.prompt("Use Codex.");
	assert.equal(f.calls.length, 1);
	assert.deepEqual(warnings(f.calls[0].messages), []);
	await f.session.setModel(f.model("anthropic", CLAUDE));
	await f.session.prompt("Use Claude.");
	assert.equal(f.calls.length, 2);
	assert.equal(warnings(f.calls[1].messages).length, 1);
	assert.match(textOf(warnings(f.calls[1].messages)[0]), /anthropic 5h is at 98%/);
	await f.session.prompt("Another turn.");
	assert.equal(f.calls.length, 3);
	assert.equal(warnings(f.calls[2].messages).length, 1, "no duplicate warning for the same reset cycle");
	assert.deepEqual(f.errors, []);
});

test("old queued-warning history remains on disk but does not instruct another provider", { timeout: 10_000 }, async (t) => {
	const f = await fixture(true);
	t.after(() => f.close());
	await f.session.setModel(f.model("openai-codex", CODEX));
	await f.session.prompt("Use Codex.");
	assert.deepEqual(warnings(f.calls[0].messages), []);
	assert.equal(f.session.sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message" && entry.customType === GUARD_CUSTOM_TYPE).length, 1);
	assert.deepEqual(f.errors, []);
});

test("switching model families before a prompt rechecks a model-scoped window", { timeout: 10_000 }, async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	await f.session.setModel(f.model("anthropic", FABLE));
	poll(f, true);
	await f.session.setModel(f.model("anthropic", CLAUDE));
	await f.session.prompt("Use Sonnet.");
	assert.deepEqual(warnings(f.calls[0].messages), []);
	await f.session.setModel(f.model("anthropic", FABLE));
	await f.session.prompt("Use Fable.");
	assert.equal(warnings(f.calls[1].messages).length, 1);
	assert.deepEqual(f.errors, []);
});

test("an idle automated wake sees the active provider's warning on its first request", { timeout: 10_000 }, async (t) => {
	const f = await fixture();
	t.after(() => f.close());
	poll(f);
	await f.session.sendCustomMessage({ customType: "synthetic-job", content: "Job completed.", display: true }, { triggerTurn: true });
	assert.equal(f.calls.length, 1);
	assert.equal(warnings(f.calls[0].messages).length, 1, "a job wake bypasses before_agent_start");
	assert.deepEqual(f.errors, []);
});

test("a queued follow-up sees an idle crossing without another before_agent_start", { timeout: 10_000 }, async (t) => {
	const f = await fixture(false, true);
	t.after(async () => { f.release(); await f.close(); });
	const running = f.session.prompt("First request.");
	await f.firstStarted;
	assert.deepEqual(warnings(f.calls[0].messages), []);
	await f.session.followUp("Queued follow-up.");
	poll(f);
	f.release();
	await running;
	assert.equal(f.calls.length, 2);
	assert.equal(warnings(f.calls[1].messages).length, 1);
	assert.deepEqual(f.errors, []);
});

after(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
	rmSync(scratch, { recursive: true, force: true });
});
