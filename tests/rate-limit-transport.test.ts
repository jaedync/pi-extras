import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
type Provider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;
import { createQuotaTransportGuard } from "../lib/rate-limit-recovery/transport.ts";
import { parseRateLimit } from "../lib/rate-limit-recovery/core.ts";
import { agentRoot } from "./support/pi-runtime.mjs";

const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", retry_after: 9905, message: "synthetic rejection" } });
const model = { provider: "fixture", api: "anthropic-messages", id: "claude-fixture" };
const context = { messages: [] };
const quota = () => new Response(body, { status: 429, headers: { "content-type": "application/json", "retry-after": "9905" } });

function fixture(shared?: { native?: any; config?: any; base: any }) {
	const calls: any[] = [];
	const base = {
		id: "fixture", name: "Fixture", auth: {}, custom: { retained: true },
		getModels() { assert.equal(this, base); return [model]; },
		stream(m: unknown, c: unknown, options: any) { calls.push({ receiver: this, model: m, context: c, options }); return options.fetch("https://fixture.invalid", { signal: options.signal }); },
		streamSimple(m: unknown, c: unknown, options: any) { calls.push({ receiver: this, model: m, context: c, options }); return options.fetch("https://fixture.invalid", { signal: options.signal }); },
	};
	const state = shared ?? { base, native: base as any, config: undefined as any };
	const registry = {
		getProvider() { return state.native ?? (state.config ? { ...state.base, ...state.config } : state.base); },
		getError(): string | undefined { return undefined; },
		getRegisteredNativeProvider() { return state.native; },
		getRegisteredProviderConfig() { return state.config; },
		registerProvider(providerOrId: any, config?: any) {
			if (typeof providerOrId === "string") { state.native = undefined; state.config = { ...state.config, ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) }; }
			else { state.native = providerOrId; state.config = undefined; }
		},
		unregisterProvider() { state.native = undefined; state.config = undefined; },
	};
	return { base: state.base, calls, state, registry, ctx: { modelRegistry: registry, model } as never };
}

async function request(f: ReturnType<typeof fixture>, response: Response, method: "stream" | "streamSimple" = "streamSimple", options: Record<string, unknown> = {}) {
	const guarded = f.registry.getProvider();
	return guarded[method](model, context, { ...options, fetch: async () => response }) as Promise<Response>;
}

async function modelsFileRuntime(sdk: any, ai: any, modelsPath: string, credentials = new ai.InMemoryCredentialStore()) {
	// modelsPath otherwise selects a sibling FileModelsStore. Pi's unawaitable
	// registration refreshes can create its cache/lock during fixture cleanup.
	// Keep real models.json reloads, but give the unrelated catalog cache no disk IO.
	return sdk.ModelRuntime.create({ credentials, modelsPath, modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
}

async function builtinPair() {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify("opencode-go", async () => ({ type: "api_key", key: "synthetic-not-a-credential" }));
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const registry = new sdk.ModelRegistry(runtime); const catalog = registry.getAll();
	const a = catalog.find((m: any) => m.provider === "opencode-go" && m.api === "anthropic-messages");
	const b = catalog.find((m: any) => m.provider === "opencode-go" && m.api === "openai-completions"); assert.ok(a && b);
	return { sdk, runtime, registry, catalog, a, b, ctx: (selected: any, retarget = false) => ({ modelRegistry: registry, model: selected, retarget } as never) };
}

async function builtinRequest(f: Awaited<ReturnType<typeof builtinPair>>, selected: any) {
	let attempts = 0;
	const result = await f.registry.streamSimple(selected, context, { apiKey: "synthetic-not-a-credential", maxRetries: 1,
		fetch: async () => { attempts++; return new Response(body, { status: 429, headers: { "content-type": "application/json" } }); },
	}).result();
	assert.equal(result.stopReason, "error"); return attempts;
}

function deferred() {
	let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function sdkSession(sdk: any, runtime: any, dir: string, selected: any, guard: ReturnType<typeof createQuotaTransportGuard>, onContext: () => Promise<void> | void) {
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 1 } } });
	const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "quota-transport-fixture", factory: (pi: any) => pi.on("context", async (_event: any, ctx: any) => { try { guard.ensure({ ...ctx, retarget: true }); } catch (error) { ctx.abort(); throw error; } await onContext(); }) }],
	});
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: selected, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(dir), noTools: "all" });
	const errors: unknown[] = []; await session.bindExtensions({ mode: "print", uiContext: { notify() {}, setWidget() {} }, onError: (error: unknown) => errors.push(error) });
	return { session, errors };
}

test("recognized JSON quota preserves status/body and opts out of hidden retries", async () => {
	const f = fixture(); const guard = createQuotaTransportGuard();
	guard.ensure(f.ctx);
	try {
		const input = quota(); const result = await request(f, input);
		assert.equal(result.status, 429);
		assert.equal(result.headers.get("x-should-retry"), "false");
		assert.equal(result.headers.get("retry-after"), "9905");
		assert.equal(input.headers.get("x-should-retry"), null);
		assert.equal(await result.text(), body);
	} finally { guard.dispose(); }
});

for (const response of [
	() => new Response(body, { status: 500 }),
	() => new Response("not JSON", { status: 429 }),
	() => new Response(`Provider prose: ${body}`, { status: 429 }),
	() => new Response(`[${body}]`, { status: 429 }),
	() => new Response(JSON.stringify({ error: { type: "insufficient_quota" } }), { status: 429 }),
	() => new Response("x".repeat(32_769), { status: 429 }),
	() => new Response("success", { status: 200 }),
]) test("ordinary, malformed and oversized responses pass through without consuming their body", async () => {
	const f = fixture(); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	try { const input = response(); assert.equal(await request(f, input), input); assert.equal(input.bodyUsed, false); }
	finally { guard.dispose(); }
});

for (const method of ["stream", "streamSimple"] as const) test(`${method} retains original receiver, options, custom fetch and provider capabilities`, async () => {
	const f = fixture(); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	try {
		const signal = new AbortController().signal; const input = quota(); let fetched = 0;
		const options = { signal, maxRetries: 2, headers: { "fixture-only": "synthetic" }, fetch: async () => { fetched++; return input; } };
		await f.registry.getProvider()[method](model, context, options);
		assert.equal(fetched, 1); assert.equal(f.calls[0].receiver, f.base);
		assert.equal(f.calls[0].model, model); assert.equal(f.calls[0].context, context);
		assert.equal(f.calls[0].options.signal, signal); assert.equal(f.calls[0].options.headers, options.headers);
		assert.equal(f.calls[0].options.maxRetries, 2); assert.equal(options.fetch === f.calls[0].options.fetch, false);
		assert.equal(f.registry.getProvider().custom, f.base.custom);
		assert.deepEqual(f.registry.getProvider().getModels(), [model]);
	} finally { guard.dispose(); }
});

test("unsupported APIs receive the exact original options without an injected fetch", async () => {
	const f = fixture(); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	const unsupported = { ...model, api: "google-generative-ai" };
	const options = { maxRetries: 2, fetch: async () => new Response("normal") };
	await f.registry.getProvider().streamSimple(unsupported, context, options);
	assert.equal(f.calls[0].options, options);
	guard.dispose();
});

test("ensuring an unsupported API does not change registration kind or fields", () => {
	const f = fixture(); const original = { headers: { retained: "yes" } };
	f.registry.registerProvider("fixture", original); const prior = f.state.config;
	const guard = createQuotaTransportGuard();
	guard.ensure({ modelRegistry: f.registry, model: { ...model, api: "google-generative-ai" } } as never);
	assert.equal(f.state.native, undefined); assert.equal(f.state.config, prior); guard.dispose();
});

test("different registry facades share one lease and the last owner restores the native registration", () => {
	const f = fixture(); const native = { ...f.base, name: "Original native" }; f.registry.registerProvider(native);
	const sibling = fixture(f.state); const a = createQuotaTransportGuard(); const b = createQuotaTransportGuard();
	a.ensure(f.ctx); const wrapped = f.state.native;
	b.ensure(sibling.ctx); assert.equal(f.state.native, wrapped);
	a.ensure(f.ctx); a.dispose(); assert.equal(f.state.native, wrapped);
	b.dispose(); assert.equal(f.state.native, native); b.dispose();
});

for (const kind of ["native", "legacy"] as const) test(`${kind} registration failure after installation releases/restores the owned guard`, () => {
	const f = fixture(); const before = { name: "Original legacy", baseUrl: "https://retained.invalid" };
	if (kind === "legacy") f.registry.registerProvider("fixture", before);
	const originalRegister = f.registry.registerProvider; let fail = true;
	f.registry.registerProvider = (provider, config) => {
		originalRegister(provider, config);
		if (fail) { fail = false; throw new Error("Synthetic registry installation failure"); }
	};
	const guard = createQuotaTransportGuard(); assert.throws(() => guard.ensure(f.ctx), /Synthetic registry/);
	if (kind === "native") assert.equal(f.state.native, f.base);
	else { assert.equal(f.state.native, undefined); assert.deepEqual(f.state.config, before); }
	guard.dispose();
});

test("last owner restores a previous legacy registration, not a wrapper snapshot", () => {
	const f = fixture(); const original = { name: "Legacy endpoint", headers: { custom: "yes" } };
	f.registry.registerProvider("fixture", original);
	const guard = createQuotaTransportGuard(); guard.ensure(f.ctx); guard.dispose();
	assert.deepEqual(f.state.config, original); assert.equal(f.state.native, undefined);
});

test("dispose never clobbers foreign registrations and ensure acquires the latest provider", async () => {
	const f = fixture(); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	const foreign = { ...f.base, name: "Foreign replacement" }; f.registry.registerProvider(foreign);
	guard.dispose(); assert.equal(f.state.native, foreign);
	guard.ensure(f.ctx); assert.notEqual(f.state.native, foreign);
	await request(f, quota()); guard.dispose(); assert.equal(f.state.native, foreign);
});

test("reload-like acquire/dispose ordering cannot restore an obsolete wrapper", () => {
	const f = fixture(); const a = createQuotaTransportGuard(); const b = createQuotaTransportGuard();
	a.ensure(f.ctx); b.ensure(f.ctx); a.dispose(); b.dispose(); assert.equal(f.state.native, f.base);
	const c = createQuotaTransportGuard(); c.ensure(f.ctx); c.dispose(); assert.equal(f.state.native, f.base);
});

test("separate module evaluations share ownership rather than nesting provider wrappers", async () => {
	const url = new URL("../lib/rate-limit-recovery/transport.ts", import.meta.url).href;
	const reloaded = await import(`${url}?transport-lease-test=second-module`);
	const f = fixture(); const a = createQuotaTransportGuard(); const b = reloaded.createQuotaTransportGuard();
	a.ensure(f.ctx); const wrapper = f.state.native; b.ensure(f.ctx);
	assert.equal(f.state.native, wrapper); a.dispose(); assert.equal(f.state.native, wrapper);
	b.dispose(); assert.equal(f.state.native, f.base);
});

test("clone-read/cancellation failure passes through and reports only a safe code", async () => {
	const warnings: string[] = []; const f = fixture();
	const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) }); guard.ensure(f.ctx);
	const input = new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic-sensitive-provider-prose")); } }), { status: 429 });
	assert.equal(await request(f, input), input);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(warnings, ["clone-cancel-failed"]); guard.dispose();
});

test("native provider fields and replaced catalog methods remain live without changing original receivers", () => {
	const f = fixture(); f.base.baseUrl = "https://initial.invalid"; f.base.headers = { initial: "old" };
	const guard = createQuotaTransportGuard(); guard.ensure(f.ctx); const wrapped = f.state.native;
	const firstMethod = wrapped.getModels; assert.equal(wrapped.getModels, firstMethod);
	f.base.name = "Updated native"; f.base.baseUrl = "https://changed.invalid"; f.base.headers = { fresh: "yes" };
	const replacement = [{ ...model, id: "updated-model" }];
	f.base.getModels = function () { assert.equal(this, f.base); return replacement; };
	assert.equal(wrapped.name, f.base.name); assert.equal(wrapped.baseUrl, f.base.baseUrl); assert.equal(wrapped.headers, f.base.headers);
	assert.deepEqual(wrapped.getModels(), replacement); assert.notEqual(wrapped.getModels, firstMethod);
	assert.equal(wrapped.getModels, wrapped.getModels); guard.dispose();
});

test("unrelated provider and global parse diagnostics do not abort a covered provider", () => {
	const f = fixture(); const guard = createQuotaTransportGuard();
	f.registry.getError = () => 'Provider "other-fixture": invalid model window'; assert.doesNotThrow(() => guard.ensure(f.ctx));
	f.registry.getError = () => 'Models configuration parse diagnostic'; assert.doesNotThrow(() => guard.ensure(f.ctx)); guard.dispose();
});

test("prototype methods and nonenumerable capabilities retain their original receiver", () => {
	const f = fixture(); const key = Symbol("capability");
	const original = Object.create(f.base);
	Object.defineProperty(original, key, { value: { retained: true }, enumerable: false });
	Object.defineProperty(original, "getModels", { value() { assert.equal(this, original); return [model]; } });
	f.registry.registerProvider(original);
	const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	assert.equal(f.state.native[key], original[key]); assert.deepEqual(f.state.native.getModels(), [model]);
	guard.dispose(); assert.equal(f.state.native, original);
});

function stalledResponse() {
	return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"error\":")); } }), { status: 429 });
}

test("abort ends inspection promptly, removes its timeout and does not consume original response", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture(); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	const controller = new AbortController(); const response = stalledResponse();
	const pending = request(f, response, "streamSimple", { signal: controller.signal });
	await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort();
	assert.equal(await pending, response); assert.equal(response.bodyUsed, false);
	t.mock.timers.tick(1000); guard.dispose();
	void response.body?.cancel();
});

test("request abort also cancels inspection when fetch init supplies a different signal", async () => {
	const f = fixture(); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	const controller = new AbortController(); const independent = new AbortController();
	const response = stalledResponse();
	const original = { ...f.base, streamSimple(_m: unknown, _c: unknown, options: any) { return options.fetch("https://fixture.invalid", { signal: independent.signal }); } };
	f.registry.registerProvider(original); guard.ensure(f.ctx);
	const pending = request(f, response, "streamSimple", { signal: controller.signal });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const started = performance.now(); controller.abort(); assert.equal(await pending, response);
	assert.ok(performance.now() - started < 200); guard.dispose(); void response.body?.cancel();
});

test("a stalled 429 body inspection returns within its 500ms deadline, without awaiting tee cancellation", async () => {
	const f = fixture(); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	const response = stalledResponse(); const started = performance.now();
	assert.equal(await request(f, response), response);
	assert.ok(performance.now() - started < 1000); guard.dispose();
	void response.body?.cancel();
});

test("real public ModelRegistry facades share a runtime lease and restore configuration", async () => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowOffline: true, refreshOnCreate: false });
	const first = new sdk.ModelRegistry(runtime); const second = new sdk.ModelRegistry(runtime);
	first.registerProvider("anthropic", { apiKey: "synthetic-not-a-credential", baseUrl: "https://fixture.invalid" });
	const selected = { ...model, provider: "anthropic" };
	const prior = first.getRegisteredProviderConfig("anthropic");
	const a = createQuotaTransportGuard(); const b = createQuotaTransportGuard();
	a.ensure({ modelRegistry: first, model: selected } as never); const overlay = first.getRegisteredProviderConfig("anthropic").streamSimple;
	assert.equal(first.getRegisteredNativeProvider("anthropic"), undefined);
	b.ensure({ modelRegistry: second, model: selected } as never);
	assert.equal(second.getRegisteredProviderConfig("anthropic").streamSimple, overlay);
	a.dispose(); assert.equal(second.getRegisteredProviderConfig("anthropic").streamSimple, overlay);
	b.dispose(); assert.equal(first.getRegisteredNativeProvider("anthropic"), undefined);
	assert.deepEqual(first.getRegisteredProviderConfig("anthropic"), prior);
});

test("real legacy SDK stream keeps its overlay installed during fetch and protects quota after a partial registration", { timeout: 3000 }, async () => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowOffline: true, refreshOnCreate: false });
	const registry = new sdk.ModelRegistry(runtime);
	registry.registerProvider("anthropic", { apiKey: "synthetic-not-a-credential", baseUrl: "https://retained.invalid", headers: { initial: "old" } });
	const selected = registry.getAll().find((m: any) => m.provider === "anthropic");
	const guard = createQuotaTransportGuard(); guard.ensure({ modelRegistry: registry, model: selected } as never);
	const overlay = registry.getRegisteredProviderConfig("anthropic").streamSimple;
	registry.registerProvider("anthropic", { headers: { retained: "new" } }); let attempts = 0;
	try {
		const stream = registry.streamSimple(selected, { messages: [{ role: "user", content: "Synthetic fixture", timestamp: 0 }] }, { maxRetries: 1, fetch: async (_input: unknown, init: any) => {
			attempts++;
			assert.equal(registry.getRegisteredProviderConfig("anthropic").streamSimple, overlay);
			assert.equal(registry.getRegisteredNativeProvider("anthropic"), undefined);
			assert.equal(new Headers(init?.headers).get("retained"), "new");
			return quota();
		} });
		const result = await stream.result(); assert.equal(attempts, 1); assert.equal(result.stopReason, "error");
		assert.deepEqual(parseRateLimit(result.errorMessage), { retryAfterSeconds: 9905 });
	} finally { guard.dispose(); }
	assert.deepEqual(registry.getRegisteredProviderConfig("anthropic"), { apiKey: "synthetic-not-a-credential", baseUrl: "https://retained.invalid", headers: { retained: "new" } });
});

test("partial foreign legacy registration preserves endpoint/auth/headers while owned and after disposal", async () => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowOffline: true, refreshOnCreate: false });
	const registry = new sdk.ModelRegistry(runtime);
	registry.registerProvider("anthropic", { apiKey: "synthetic-not-a-credential", baseUrl: "https://retained.invalid", headers: { old: "old" } });
	const selected = registry.getAll().find((m: any) => m.provider === "anthropic");
	const guard = createQuotaTransportGuard(); guard.ensure({ modelRegistry: registry, model: selected } as never);
	const overlay = registry.getRegisteredProviderConfig("anthropic").streamSimple;
	registry.registerProvider("anthropic", { headers: { fresh: "new" } });
	guard.ensure({ modelRegistry: registry, model: selected } as never);
	assert.equal(registry.getRegisteredNativeProvider("anthropic"), undefined);
	assert.equal(registry.getRegisteredProviderConfig("anthropic").baseUrl, "https://retained.invalid");
	assert.equal(registry.getRegisteredProviderConfig("anthropic").streamSimple, overlay);
	assert.deepEqual((await registry.getApiKeyAndHeaders(selected)).headers, { fresh: "new" });
	guard.dispose();
	assert.deepEqual(registry.getRegisteredProviderConfig("anthropic"), { apiKey: "synthetic-not-a-credential", baseUrl: "https://retained.invalid", headers: { fresh: "new" } });
});

for (const kind of ["native", "builtin"] as const) test(`${kind} provider preserves live models-file edits/removals under a quota lease`, async () => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const dir = await mkdtemp(join(tmpdir(), "quota-models-")); const modelsPath = join(dir, "models.json");
	const guard = createQuotaTransportGuard();
	try {
		await writeFile(modelsPath, JSON.stringify({ providers: {} }));
		const runtime = await modelsFileRuntime(sdk, ai, modelsPath);
		const registry = new sdk.ModelRegistry(runtime); const original = registry.getProvider("anthropic");
		if (kind === "native") registry.registerProvider(original);
		const selected = registry.getAll().find((m: any) => m.provider === "anthropic");
		const first = { providers: { anthropic: { baseUrl: "https://old.invalid", modelOverrides: { [selected.id]: { contextWindow: 12345 } } } } };
		await writeFile(modelsPath, JSON.stringify(first)); await registry.refresh({ allowNetwork: false });
		guard.ensure({ modelRegistry: registry, model: selected } as never);
		assert.equal(registry.find("anthropic", selected.id).baseUrl, "https://old.invalid");
		await writeFile(modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: "https://new.invalid" } } }));
		await registry.refresh({ allowNetwork: false }); guard.ensure({ modelRegistry: registry, model: selected } as never);
		assert.equal(registry.find("anthropic", selected.id).baseUrl, "https://new.invalid");
		assert.equal(registry.find("anthropic", selected.id).contextWindow, selected.contextWindow);
		await writeFile(modelsPath, JSON.stringify({ providers: {} })); await registry.refresh({ allowNetwork: false });
		guard.ensure({ modelRegistry: registry, model: selected } as never);
		assert.equal(registry.find("anthropic", selected.id).baseUrl, selected.baseUrl);
		assert.equal(registry.find("anthropic", selected.id).contextWindow, selected.contextWindow);
		guard.dispose(); assert.equal(registry.getRegisteredNativeProvider("anthropic"), kind === "native" ? original : undefined);
		assert.equal(registry.getRegisteredProviderConfig("anthropic"), undefined);
	} finally { guard.dispose(); await rm(dir, { recursive: true, force: true }); }
});

for (const kind of ["native", "builtin"] as const) test(`${kind} quota disposal refresh cannot recreate a removed models directory`, { timeout: 10_000 }, async (t) => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const { ModelConfig } = await import(pathToFileURL(join(agentRoot, "dist/core/model-config.js")).href);
	const dir = await mkdtemp(join(tmpdir(), "quota-models-disposal-")); const modelsPath = join(dir, "models.json");
	const guard = createQuotaTransportGuard(); const entered = deferred(); const resume = deferred();
	const refreshes: Promise<unknown>[] = []; let hold = false;
	const load = ModelConfig.load.bind(ModelConfig);
	// Registration refreshes are fire-and-forget in Pi 0.99.2. Gate its real config
	// read so disposal's cache access deterministically lands after directory removal.
	t.mock.method(ModelConfig, "load", async (path: string) => {
		const config = await load(path);
		if (hold && path === modelsPath) { entered.resolve(); await resume.promise; }
		return config;
	});
	try {
		await writeFile(modelsPath, JSON.stringify({ providers: {} }));
		const runtime = await modelsFileRuntime(sdk, ai, modelsPath);
		const refresh = runtime.refresh.bind(runtime);
		t.mock.method(runtime, "refresh", (options: unknown) => {
			const pending = refresh(options); refreshes.push(pending); return pending;
		});
		const registry = new sdk.ModelRegistry(runtime);
		if (kind === "native") registry.registerProvider(registry.getProvider("anthropic"));
		const selected = registry.getAll().find((candidate: any) => candidate.provider === "anthropic");
		guard.ensure({ modelRegistry: registry, model: selected } as never);
		await Promise.all(refreshes);
		hold = true; guard.dispose(); await entered.promise;
		await rm(dir, { recursive: true, force: true });
		resume.resolve(); await Promise.all(refreshes);
		await assert.rejects(stat(dir), { code: "ENOENT" }, "Pi's late refresh must not recreate the removed fixture directory");
	} finally {
		hold = false; resume.resolve(); guard.dispose(); await Promise.all(refreshes);
		await rm(dir, { recursive: true, force: true });
	}
});

test("gated SDK parent API A retains foreign S and one HTTP attempt while child API B is explicitly unsupported", { timeout: 10_000 }, async () => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const completions = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js")).href);
	const dir = await mkdtemp(join(tmpdir(), "quota-gated-")); const originalFetch = globalThis.fetch;
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const registry = new sdk.ModelRegistry(runtime);
	const defaults = { name: "Synthetic", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 100 };
	const models = [{ ...defaults, id: "parent-fixture" }, { ...defaults, id: "child-fixture", api: "openai-responses" }];
	let delegated = 0;
	function originalSimple(this: any, m: any, c: any, o: any) {
		delegated++; assert.equal(this.api, "openai-completions"); assert.equal(this.streamSimple, originalSimple);
		return completions.streamSimple(m, c, o);
	}
	registry.registerProvider("openai", { api: "openai-completions", apiKey: "synthetic-not-a-credential", baseUrl: "https://fixture.invalid", models, streamSimple: originalSimple });
	const original = registry.getRegisteredProviderConfig("openai"); const paths: string[] = [];
	const parentWarnings: string[] = []; const childWarnings: string[] = [];
	const a = createQuotaTransportGuard({ onWarning: (code) => parentWarnings.push(code) }); const b = createQuotaTransportGuard({ onWarning: (code) => childWarnings.push(code) });
	const parentEntered = deferred(); const childEntered = deferred(); const continueParent = deferred();
	const parent = await sdkSession(sdk, runtime, dir, registry.find("openai", "parent-fixture"), a, async () => { parentEntered.resolve(); await continueParent.promise; });
	const child = await sdkSession(sdk, runtime, dir, registry.find("openai", "child-fixture"), b, () => childEntered.resolve());
	globalThis.fetch = async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input)); assert.equal(url.origin, "https://fixture.invalid"); paths.push(url.pathname);
		return new Response(body, { status: 429, headers: { "content-type": "application/json" } });
	};
	try {
		const parentRun = parent.session.prompt("Parent fixture."); await parentEntered.promise;
		const childRun = child.session.prompt("Child fixture."); await childEntered.promise; continueParent.resolve();
		await Promise.all([parentRun, childRun]);
		assert.equal(delegated, 1, "parent must still use the original custom stream after the child's context ensured another API");
		assert.equal(paths.filter((path) => path.endsWith("/chat/completions")).length, 1);
		assert.equal(paths.filter((path) => path.endsWith("/responses")).length, 2, "unsupported path retains the user's ordinary transport retry policy");
		assert.deepEqual(parentWarnings, []); assert.deepEqual(childWarnings, ["unsupported-mixed-api"]);
		assert.deepEqual(parent.errors, []); assert.deepEqual(child.errors, []);
		assert.equal(registry.getRegisteredProviderConfig("openai").api, "openai-completions");
		assert.equal(registry.find("openai", "parent-fixture").api, "openai-completions");
		assert.equal(registry.find("openai", "child-fixture").api, "openai-responses");
	} finally {
		continueParent.resolve(); a.dispose(); b.dispose(); parent.session.dispose(); child.session.dispose(); globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
	assert.deepEqual(registry.getRegisteredProviderConfig("openai"), original);
});

test("defaulted custom legacy models without a root API are explicitly unsupported and unchanged", async () => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const registry = new sdk.ModelRegistry(runtime); const baseline = registry.getAll().find((m: any) => m.provider === "anthropic");
	const { api: _api, ...definition } = baseline;
	registry.registerProvider("anthropic", { apiKey: "synthetic-not-a-credential", baseUrl: "https://fixture.invalid", models: [definition] });
	const selected = registry.find("anthropic", baseline.id); const original = registry.getRegisteredProviderConfig("anthropic"); const models = registry.getAll();
	const warnings: string[] = []; const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) });
	guard.ensure({ modelRegistry: registry, model: selected } as never); guard.ensure({ modelRegistry: registry, model: selected } as never);
	assert.equal(registry.getRegisteredProviderConfig("anthropic"), original); assert.deepEqual(registry.getAll(), models);
	assert.deepEqual(warnings, ["unsupported-default-model-api"]); guard.dispose();
});

test("a released in-flight overlay dispatches through the current provider, not its stale delegate", async () => {
	const f = fixture(); const old = { api: "anthropic-messages", streamSimple: () => Promise.resolve(new Response("stale")) };
	f.registry.registerProvider("fixture", old); const guard = createQuotaTransportGuard(); guard.ensure(f.ctx);
	const inFlight = f.registry.getProvider(); guard.dispose();
	function fresh(this: any) { assert.equal(this.streamSimple, fresh); return Promise.resolve(new Response("current")); }
	f.registry.registerProvider("fixture", { api: "anthropic-messages", streamSimple: fresh });
	assert.equal(await (await inFlight.streamSimple(model, context, {})).text(), "current");
});

test("failed stripped-config validation leaves registration recoverable and disposal never throws", () => {
	const f = fixture(); const original = { baseUrl: "https://retained.invalid", headers: { retained: "yes" } };
	f.registry.registerProvider("fixture", original); const warnings: string[] = [];
	const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) }); guard.ensure(f.ctx);
	const overlay = f.state.config.streamSimple; const register = f.registry.registerProvider;
	f.registry.registerProvider = (provider, config) => {
		if (typeof provider === "string" && !config.streamSimple) throw new Error("Synthetic stripped validation failure");
		register(provider, config);
	};
	assert.doesNotThrow(() => guard.dispose()); assert.equal(f.state.config.streamSimple, overlay);
	assert.equal(f.state.config.baseUrl, original.baseUrl); assert.deepEqual(warnings, ["legacy-restore-validation-failed"]);
	f.registry.registerProvider = register; guard.dispose(); assert.deepEqual(f.state.config, original);
});

for (const kind of ["legacy", "native"] as const) test(`${kind} invalid models-file fails closed before HTTP and preserves recoverable registration`, async () => {
	const sdk = await import(pathToFileURL(join(agentRoot, "dist/index.js")).href);
	const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	const dir = await mkdtemp(join(tmpdir(), "quota-invalid-models-")); const modelsPath = join(dir, "models.json"); const warnings: string[] = [];
	const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) });
	try {
		await writeFile(modelsPath, JSON.stringify({ providers: {} }));
		const credentials = new ai.InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "synthetic-not-a-credential" }));
		const runtime = await modelsFileRuntime(sdk, ai, modelsPath, credentials);
		const registry = new sdk.ModelRegistry(runtime);
		if (kind === "native") registry.registerProvider(registry.getProvider("anthropic"));
		else registry.registerProvider("anthropic", { apiKey: "synthetic-not-a-credential", baseUrl: "https://retained.invalid", headers: { retained: "yes" } });
		const original = kind === "native" ? registry.getRegisteredNativeProvider("anthropic") : registry.getRegisteredProviderConfig("anthropic");
		const selected = registry.getAll().find((m: any) => m.provider === "anthropic");
		guard.ensure({ modelRegistry: registry, model: selected } as never); const overlay = registry.getRegisteredProviderConfig("anthropic")?.streamSimple;
		await writeFile(modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: "https://fixture.invalid", models: [{ id: "unknown-fixture-model", name: "Invalid model window", contextWindow: -1 }] } } }));
		await registry.refresh({ allowNetwork: false }); assert.ok(registry.getError());
		const oldFetch = globalThis.fetch; let requests = 0;
		globalThis.fetch = async () => { requests++; throw new Error("Invalid config must not make HTTP requests"); };
		try {
			assert.throws(() => guard.ensure({ modelRegistry: registry, model: selected } as never), /models\.json/);
			const active = await sdkSession(sdk, runtime, dir, selected, guard, () => {});
			try { await active.session.prompt("Invalid-config fixture."); assert.equal(requests, 0); }
			finally { active.session.dispose(); }
		} finally { globalThis.fetch = oldFetch; }
		assert.doesNotThrow(() => guard.dispose());
		if (kind === "native") assert.equal(registry.getRegisteredNativeProvider("anthropic"), original);
		else {
			assert.equal(registry.getRegisteredProviderConfig("anthropic").streamSimple, overlay);
			assert.equal(registry.getRegisteredProviderConfig("anthropic").baseUrl, "https://retained.invalid");
		}
		assert.deepEqual(warnings, kind === "native" ? ["invalid-provider-config"] : ["invalid-provider-config", "legacy-restore-validation-failed"]);
		await writeFile(modelsPath, JSON.stringify({ providers: {} })); await registry.refresh({ allowNetwork: false }); guard.dispose();
		assert.deepEqual(kind === "native" ? registry.getRegisteredNativeProvider("anthropic") : registry.getRegisteredProviderConfig("anthropic"), original);
	} finally { guard.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("sole-owner bare builtin retargets only at request boundaries and preserves its full catalog", async () => {
	const f = await builtinPair(); const warnings: string[] = []; const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) });
	guard.ensure(f.ctx(f.a, true)); assert.equal(await builtinRequest(f, f.a), 1);
	guard.ensure(f.ctx(f.b)); assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).api, f.a.api); assert.deepEqual(warnings, []);
	guard.ensure(f.ctx(f.b, true)); assert.equal(await builtinRequest(f, f.b), 1);
	assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).api, f.b.api);
	assert.deepEqual(f.registry.getAll(), f.catalog); guard.dispose(); assert.deepEqual(f.registry.getAll(), f.catalog);
	assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider), undefined); assert.deepEqual(warnings, []);
});

test("failed sole-owner retarget stays owned and retries successfully at a later request boundary", async () => {
	const f = await builtinPair(); const warnings: string[] = []; const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) });
	guard.ensure(f.ctx(f.a, true)); const overlay = f.registry.getRegisteredProviderConfig(f.a.provider).streamSimple;
	const register = f.registry.registerProvider.bind(f.registry); const unregister = f.registry.unregisterProvider.bind(f.registry);
	let unregistrations = 0;
	f.registry.registerProvider = (id: any, config?: any) => { if (typeof id === "string" && config?.api === undefined) throw new Error("synthetic validation failure"); return register(id, config); };
	f.registry.unregisterProvider = (id: string) => { unregistrations++; return unregister(id); };
	try {
		assert.doesNotThrow(() => guard.ensure(f.ctx(f.b, true)));
		assert.equal(unregistrations, 0); assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).streamSimple, overlay);
		assert.deepEqual(warnings, ["legacy-restore-validation-failed"]);
		f.registry.registerProvider = register; guard.ensure(f.ctx(f.b, true));
		assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).api, f.b.api);
		assert.equal(await builtinRequest(f, f.b), 1); assert.deepEqual(warnings, ["legacy-restore-validation-failed"]);
	} finally { f.registry.registerProvider = register; guard.dispose(); }
	assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider), undefined); assert.deepEqual(f.registry.getAll(), f.catalog);
});

test("gated bare builtin context A remains guarded across a model-select B without a request-boundary flag", { timeout: 10_000 }, async () => {
	const f = await builtinPair(); const warnings: string[] = []; const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) });
	const entered = deferred(); const resume = deferred(); const dir = await mkdtemp(join(tmpdir(), "quota-select-gate-"));
	const active = await sdkSession(f.sdk, f.runtime, dir, f.a, guard, async () => { entered.resolve(); await resume.promise; });
	const originalFetch = globalThis.fetch; const requests: string[] = [];
	globalThis.fetch = async (input) => { requests.push(new URL(input instanceof Request ? input.url : String(input)).pathname); return new Response(body, { status: 429, headers: { "content-type": "application/json" } }); };
	try {
		const run = active.session.prompt("Gated builtin fixture."); await entered.promise;
		await active.session.setModel(f.b); guard.ensure(f.ctx(f.b));
		assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).api, f.a.api); assert.deepEqual(warnings, []);
		resume.resolve(); await run; assert.equal(requests.length, 1); assert.ok(requests[0].endsWith("/messages")); assert.deepEqual(active.errors, []);
	} finally { resume.resolve(); guard.dispose(); active.session.dispose(); globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});

test("another owner prevents bare-builtin retargeting and preserves ordinary behavior", async () => {
	const f = await builtinPair(); const warnings: string[] = [];
	const a = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) }); const b = createQuotaTransportGuard();
	a.ensure(f.ctx(f.a, true)); b.ensure(f.ctx(f.a, true)); a.ensure(f.ctx(f.b, true));
	assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).api, f.a.api);
	assert.deepEqual(warnings, ["unsupported-mixed-api"]); assert.equal(await builtinRequest(f, f.b), 2);
	assert.deepEqual(f.registry.getAll(), f.catalog); a.dispose(); b.dispose(); assert.deepEqual(f.registry.getAll(), f.catalog);
});

test("foreign API-less models retire a shared bare overlay without bending defaults or reinstallation", async () => {
	const f = await builtinPair(); const control = await builtinPair();
	const { api: _api, ...base } = f.b; const models = [{ ...base, id: "synthetic-defaulted-model" }];
	control.registry.registerProvider(f.a.provider, { models });
	const aWarnings: string[] = []; const bWarnings: string[] = [];
	const a = createQuotaTransportGuard({ onWarning: (code) => aWarnings.push(code) }); const b = createQuotaTransportGuard({ onWarning: (code) => bWarnings.push(code) });
	a.ensure(f.ctx(f.a, true)); b.ensure(f.ctx(f.a, true)); const prepared = f.registry.getProvider(f.a.provider);
	f.registry.registerProvider(f.a.provider, { models }); a.ensure(f.ctx(f.a, true));
	assert.deepEqual(f.registry.getAll(), control.registry.getAll()); assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).streamSimple, undefined);
	b.ensure(f.ctx(f.a, true)); assert.equal(f.registry.getRegisteredProviderConfig(f.a.provider).streamSimple, undefined);
	assert.deepEqual(aWarnings, ["unsupported-default-model-api"]); assert.deepEqual(bWarnings, ["unsupported-default-model-api"]);
	let attempts = 0;
	const result = await prepared.streamSimple(f.a, context, { apiKey: "synthetic-not-a-credential", maxRetries: 1, fetch: async () => { attempts++; return new Response(body, { status: 429 }); } }).result();
	assert.equal(result.stopReason, "error"); assert.equal(attempts, 1);
	assert.equal(await builtinRequest(f, f.registry.find(f.a.provider, "synthetic-defaulted-model")), 2);
	a.dispose(); b.dispose(); assert.deepEqual(f.registry.getRegisteredProviderConfig(f.a.provider), { models });
});

test("unsafe-default retirement validates before unregister and remains recoverable if validation fails", () => {
	const seed = fixture(); const f = fixture({ base: seed.base }); const warnings: string[] = [];
	const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) });
	guard.ensure(f.ctx); const overlay = f.registry.getRegisteredProviderConfig().streamSimple;
	const { api: _api, ...base } = model; const models = [{ ...base, id: "foreign-default-model" }];
	f.registry.registerProvider("fixture", { models }); const register = f.registry.registerProvider; const unregister = f.registry.unregisterProvider;
	let unregistrations = 0;
	f.registry.registerProvider = ((id: any, cfg: any) => { if (cfg?.api === undefined) throw new Error("synthetic validation failure"); register(id, cfg); }) as any;
	f.registry.unregisterProvider = () => { unregistrations++; unregister(); };
	assert.doesNotThrow(() => guard.ensure(f.ctx)); assert.equal(unregistrations, 0);
	assert.equal(f.registry.getRegisteredProviderConfig().streamSimple, overlay);
	assert.deepEqual(warnings, ["unsupported-default-model-api", "legacy-restore-validation-failed"]);
	f.registry.registerProvider = register; guard.dispose(); assert.equal(unregistrations, 1);
	assert.deepEqual(f.registry.getRegisteredProviderConfig(), { models });
});

test("disposing a guard resets unsupported warning deduplication for its next session", () => {
	const f = fixture(); f.registry.registerProvider("fixture", { api: "openai-responses" }); const warnings: string[] = [];
	const guard = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code) });
	guard.ensure(f.ctx); guard.ensure(f.ctx); assert.deepEqual(warnings, ["unsupported-mixed-api"]);
	guard.dispose(); guard.ensure(f.ctx); assert.deepEqual(warnings, ["unsupported-mixed-api", "unsupported-mixed-api"]); guard.dispose();
});

test("native Codex raw retry loop fails after one recognized quota response with JSON preserved", { timeout: 3000 }, async () => {
	const native = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js")).href);
	const codex = { ...model, api: "openai-codex-responses", baseUrl: "https://fixture.invalid", name: "Synthetic", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 100 };
	const f = fixture(); f.registry.registerProvider({ ...f.base, stream: native.stream, streamSimple: native.streamSimple } as Provider);
	const guard = createQuotaTransportGuard(); guard.ensure({ modelRegistry: f.registry, model: codex } as never);
	const token = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic`;
	let attempts = 0;
	try {
		const events = f.registry.getProvider().streamSimple(codex, { messages: [{ role: "user", content: [{ type: "text", text: "Synthetic fixture" }], timestamp: 0 }] }, {
			apiKey: token, transport: "sse", maxRetries: 1, fetch: async () => { attempts++; return quota(); },
		});
		const result = await events.result();
		assert.equal(attempts, 1); assert.equal(result.stopReason, "error");
		assert.deepEqual(parseRateLimit(result.errorMessage), { retryAfterSeconds: 9905 });
	} finally { guard.dispose(); }
});
