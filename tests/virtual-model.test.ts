import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLimitStore } from "../lib/limit-store.ts";
import { routedModel } from "../lib/routed-model.ts";
import { saveGuardConfig } from "../extensions/usage-guard.ts";
import usageGuard from "../extensions/usage-guard.ts";
import cacheCompaction from "../extensions/cache-compaction.ts";
import recovery from "../extensions/rate-limit-recovery.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const VIRTUAL = { provider: "router", id: "auto", api: "pi-virtual" };
const SONNET = { provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200_000, maxTokens: 8000 };
const reply = (provider: string, model: string, stopReason = "stop") => ({ type: "message", id: `${model}-${stopReason}`, message: { role: "assistant", provider, model, stopReason, content: [] } });
const registry = { find: (provider: string, id: string) => (provider === SONNET.provider && id === SONNET.id ? SONNET : undefined) };

test("the routed model is the latest successful response's, and the selection without one", () => {
	const branch = [reply("anthropic", "claude-sonnet-5"), reply("openai", "gpt-6", "error")];
	assert.equal(routedModel({ model: VIRTUAL, sessionManager: { getBranch: () => branch }, modelRegistry: registry }), SONNET);
	assert.equal(routedModel({ model: VIRTUAL, sessionManager: { getBranch: () => [] }, modelRegistry: registry }), VIRTUAL);
	assert.equal(routedModel({ model: SONNET, sessionManager: { getBranch: () => { throw new Error("not read for a physical model"); } } }), SONNET);
	// A model the registry no longer has falls back to the selection, as in Pi.
	assert.equal(routedModel({ model: VIRTUAL, sessionManager: { getBranch: () => [reply("gone", "old")] }, modelRegistry: registry }), VIRTUAL);
});

test("usage warnings follow the routed model under a virtual selection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "virtual-guard-"));
	try {
		const configFile = join(dir, "pi-extras.json");
		saveGuardConfig({ enabled: true }, configFile);
		const store = createLimitStore();
		store.set("anthropic", { entries: [{ label: "5h", key: "five_hour", usedPct: 96, resetMs: NOW + 3_600_000 }], atMs: NOW, source: "poll" });
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = { on: (name: string, handler: never) => handlers.set(name, handler), sendMessage() {}, appendEntry() {}, registerTool() {}, registerCommand() {} };
		usageGuard(pi as never, { store, configFile, now: () => NOW, dollars: { collect: async () => ({ inputs: { now: NOW, timeZone: "UTC" }, notes: [] }), observe: () => ({}) } as never });
		const ctx = {
			model: VIRTUAL, modelRegistry: registry, isIdle: () => true, ui: { notify() {} },
			sessionManager: { getEntries: () => [], getBranch: () => [reply("anthropic", "claude-sonnet-5")] },
		};
		const result = await handlers.get("context")!({ messages: [] }, ctx) as { messages: Array<{ content: string }> };
		assert.equal(result.messages.length, 1);
		assert.match(result.messages[0].content, /anthropic 5h is at 96%/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cache compaction captures and compares the routed model under a virtual selection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "virtual-compact-"));
	try {
		const handlers = new Map<string, Function>();
		const messages = [{ role: "system", content: "prompt", timestamp: 0 }, { role: "user", content: "task", timestamp: 1 }];
		const ctx = {
			model: VIRTUAL, modelRegistry: registry, mode: "print",
			sessionManager: { getSessionId: () => "fixture", getBranch: () => [reply("anthropic", "claude-sonnet-5")], buildSessionProjection: () => ({ messages }) },
		};
		cacheCompaction({ on: (name: string, handler: Function) => handlers.set(name, handler), events: { emit() {} } } as never, { configFile: join(dir, "pi-extras.json"), now: () => NOW });
		await handlers.get("context_with_system")!({ messages }, ctx);
		await handlers.get("before_provider_request")!({ payload: { messages } }, ctx);
		await handlers.get("session_before_compact")!({ preparation: { tokensBefore: 12 }, reason: "overflow", signal: new AbortController().signal }, ctx);
		// Every identity and API check passed; only the overflow keeps Pi's default compaction.
		assert.equal(JSON.parse(readFileSync(join(dir, "cache-compaction.log"), "utf8")).fallbackReason, "overflow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const branch of [[reply("anthropic", "claude-sonnet-5")], []]) test(`rate-limit recovery waits for a limit on the routed model of a virtual selection (${branch.length} earlier replies)`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "virtual-recovery-"));
	const file = join(dir, "pi-extras.json");
	writeFileSync(file, JSON.stringify({ rateLimitRecovery: { autoWait: true } }));
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let now = NOW;
	let waited = 0;
	const controller = new AbortController();
	const provider = (id: string) => ({ id, name: id, stream() {}, streamSimple() {} });
	const providers = new Map(["anthropic"].map((id) => [id, provider(id)]));
	const ctx = {
		mode: "tui", hasUI: true, signal: controller.signal, model: VIRTUAL,
		modelRegistry: { ...registry, getProvider: (id: string) => providers.get(id), getRegisteredNativeProvider: (id: string) => providers.get(id), getRegisteredProviderConfig: () => undefined, registerProvider() {}, unregisterProvider() {} },
		sessionManager: { getBranch: () => branch },
		abort() { controller.abort(); },
		ui: { notify() {}, setWidget() {}, onTerminalInput: () => () => {} },
	};
	const pi = { on: (name: string, handler: never) => handlers.set(name, handler), appendEntry() {}, registerCommand() {} };
	recovery(pi as never, { configFile: file, env: {}, now: () => now, wait: async (ms: number) => { waited++; now += ms; return true; } });
	try {
		const failure = { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-5", timestamp: NOW, content: [], stopReason: "error", errorMessage: JSON.stringify({ error: { type: "rate_limit_error", retry_after: 10 } }) };
		await handlers.get("message_end")!({ message: failure }, ctx);
		const result = await handlers.get("turn_end")!({ message: failure, messageEntryId: "failure", entries: [], context: { canContinue: true } }, ctx) as { entries: unknown[] } | undefined;
		assert.equal(waited, 1);
		assert.ok(result?.entries.length);
	} finally {
		handlers.get("session_shutdown")?.({}, ctx);
		rmSync(dir, { recursive: true, force: true });
	}
});
