/** Native Anthropic/Codex HTTP, real SDK boundaries, and the actual child launcher. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "rate-limit-http-sdk-"));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const originalFetch = globalThis.fetch;
const allowedOrigins = new Set<string>();
// Fail closed even if a future SDK starts a catalog/auth/background request.
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.ok(allowedOrigins.has(url.origin), `Unexpected non-fixture network request to ${url.origin}`);
	return originalFetch(input, init);
};
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { default: recovery } = await import("../extensions/rate-limit-recovery.ts");
const { createLauncher } = await import("../lib/subagents/child.ts");
const { Team } = await import("../lib/subagents/team.ts");

const NOW = Date.parse("2026-09-30T02:00:00Z");
const RETRY_SECONDS = 9905;
const DEADLINE_MS = 4000;
// Pi's agent retry is on. Leave retry.provider.maxRetries unset to exercise the
// native default (zero), rather than masking transport retries with an override.
interface RetrySettings {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly provider?: { readonly maxRetries: number; readonly maxRetryDelayMs?: number };
}
const retrySettings: RetrySettings = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
const configuredRetry: RetrySettings = { ...retrySettings, provider: { maxRetries: 1 } };
const accountId = "synthetic-http-account";
const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const codexToken = `${jwtPart({ alg: "none", typ: "JWT" })}.${jwtPart({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.synthetic-signature`;
interface NativeFixture { readonly provider: string; readonly api: string; readonly route: string }
const anthropic: NativeFixture = { provider: "anthropic", api: "anthropic-messages", route: "/v1/messages" };
const codex: NativeFixture = { provider: "openai-codex", api: "openai-codex-responses", route: "/codex/responses" };
const notes = (entries: readonly any[]) => entries.filter((entry) => entry.type === "custom_message" && entry.customType === "rate-limit-recovery");

function success(res: ServerResponse, model: string): void {
	const sse = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	sse("message_start", { message: { id: "msg_synthetic", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } });
	sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Recovered over native HTTP." } });
	sse("content_block_stop", { index: 0 });
	sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
	sse("message_stop", {});
	res.end();
}

async function endpoint(options: { recover?: boolean; retryAfter?: string; status?: 429 | 500 } = {}, fixture: NativeFixture = anthropic) {
	const requests: { body: any; retryCount: string | string[] | undefined; entries: readonly any[]; metadata: { overlay: string | string[] | undefined; model: string | string[] | undefined } }[] = [];
	const errors: unknown[] = [];
	let entries: () => readonly any[] = () => [];
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url?.split("?")[0] !== fixture.route) { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		let bytes = 0;
		req.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 1_000_000) req.destroy(new Error("Fixture request too large"));
			else chunks.push(chunk);
		});
		req.on("error", (error) => errors.push(error));
		req.on("end", () => {
			try {
				const body = Buffer.concat(chunks);
				const json = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(body, { maxOutputLength: 1_000_000 }) : body;
				assert.ok(json.length <= 1_000_000, "Bound decoded native request size");
				const request = JSON.parse(json.toString("utf8"));
				requests.push({ body: request, retryCount: req.headers["x-stainless-retry-count"], entries: [...entries()], metadata: { overlay: req.headers["x-overlay-origin"], model: req.headers["x-model-file"] } });
				if (fixture === codex) {
					assert.equal(req.headers.authorization, `Bearer ${codexToken}`);
					assert.equal(req.headers["chatgpt-account-id"], accountId);
				} else assert.equal(req.headers["x-api-key"], "synthetic-http-test-key");
				if (options.recover && requests.length === 2) { success(res, request.model); return; }
				res.writeHead(options.status ?? 429, { "content-type": "application/json", ...(options.retryAfter !== undefined ? { "retry-after": options.retryAfter } : {}) });
				const error = options.status === 500 ? { type: "api_error", message: "synthetic temporary upstream failure" }
					: { type: "rate_limit_error", message: "synthetic quota rejection", retry_after: RETRY_SECONDS };
				res.end(JSON.stringify({ type: "error", error }));
			} catch (error) { errors.push(error); res.writeHead(500).end(); }
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	allowedOrigins.add(baseUrl);
	return { requests, errors, baseUrl, fixture, observe: (getEntries: typeof entries) => { entries = getEntries; }, async close() {
		allowedOrigins.delete(baseUrl);
		await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
	} };
}

interface RuntimeOptions { readonly nativeRegistration?: boolean; readonly modelsPath?: string; readonly headers?: Record<string, string>; readonly recoveryEnabled?: boolean }
async function nativeRuntime(baseUrl: string, fixture: NativeFixture = anthropic, options: RuntimeOptions = {}) {
	const nativeRegistration = options.nativeRegistration ?? false;
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify(fixture.provider, async () => fixture === codex
		? { type: "oauth", access: codexToken, refresh: "synthetic-never-refresh", expires: Date.now() + 86_400_000 }
		: { type: "api_key", key: "synthetic-http-test-key" });
	// A real models.json must not opt these fixtures into Pi's background disk
	// catalog cache: registration/shutdown refreshes can outlive scratch cleanup.
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: options.modelsPath ?? null, modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
	// Override only endpoint/auth. Do not replace the native API with a faux stream.
	runtime.registerProvider(fixture.provider, fixture === codex ? { baseUrl, oauth: {
		name: "Synthetic native Codex OAuth", isSubscription: true,
		login: async () => { throw new Error("Fixture must never initiate OAuth login"); },
		refreshToken: async () => { throw new Error("Fixture must never refresh synthetic OAuth"); },
		getApiKey: (credential) => credential.access,
	} } : { baseUrl, apiKey: "synthetic-http-test-key", ...(options.headers ? { headers: options.headers } : {}) });
	// Codex 0.99 prefixes catalog IDs with chat:, while 0.87 does not.
	const model = fixture === codex ? runtime.getModels(fixture.provider).find((candidate) => candidate.id.endsWith("gpt-5.5"))
		: runtime.getModel(fixture.provider, "claude-sonnet-4-5");
	assert.ok(model);
	assert.equal(model.api, fixture.api);
	assert.equal(model.baseUrl, baseUrl);
	if (fixture === codex) {
		assert.equal((await runtime.checkAuth(fixture.provider))?.type, "oauth");
		assert.equal((await runtime.getAuth(model))?.auth.apiKey, codexToken);
	}
	const original = runtime.getProvider(fixture.provider);
	assert.ok(original);
	let config = runtime.getRegisteredProviderConfig(fixture.provider);
	// Overlay restoration legitimately creates new SDK stream closures. A
	// native registration lets the lifecycle cases check strict identity too.
	if (nativeRegistration) runtime.registerNativeProvider(original);
	return { runtime, model,
		expectConfig(expected: typeof config) { config = expected; },
		assertWrapped() { assert.notEqual(runtime.getProvider(fixture.provider)?.stream, original.stream, "Quota guard actually wrapped the native provider"); },
		assertRestored() {
			if (nativeRegistration) {
				const restored = runtime.getProvider(fixture.provider);
				assert.equal(restored?.stream, original.stream, "Native stream restored after shutdown");
				assert.equal(restored?.streamSimple, original.streamSimple, "Native streamSimple restored after shutdown");
			} else {
				assert.equal(runtime.getRegisteredNativeProvider(fixture.provider), undefined, "No quota wrapper left registered after shutdown");
				assert.deepEqual(runtime.getRegisteredProviderConfig(fixture.provider), config, "Endpoint/auth overlays restored after shutdown");
			}
		},
	};
}

async function bounded<T>(work: Promise<T>, cancel: () => Promise<void>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Native HTTP fixture exceeded bounded deadline")), DEADLINE_MS);
		})]);
	} catch (error) { await cancel(); throw error; }
	finally { clearTimeout(timer); }
}

async function mainSession(baseUrl: string, autoWait: boolean, retry: RetrySettings = retrySettings, fixture: NativeFixture = anthropic, options: RuntimeOptions = {}) {
	const agentDir = mkdtempSync(join(scratch, "main-"));
	const configFile = join(agentDir, "pi-extras.json");
	// An empty config proves default-off rather than an explicit false override.
	writeFileSync(configFile, JSON.stringify(autoWait ? { rateLimitRecovery: { autoWait: true } } : {}));
	const { runtime, model, assertWrapped, assertRestored, expectConfig } = await nativeRuntime(baseUrl, fixture, options);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", transport: "sse", retry });
	assert.equal(settingsManager.getProviderRetrySettings().maxRetries, retry.provider?.maxRetries, "retain the requested native retry settings");
	let now = NOW;
	const waits: number[] = [];
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: options.recoveryEnabled === false ? [] : [{ name: "native-http-recovery", factory: (pi) => recovery(pi, { configFile, env: {}, now: () => now,
			wait: async (ms, signal) => { assert.equal(signal.aborted, false); waits.push(ms); now += ms + 234; return true; },
		}) }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "all" });
	const events: any[] = [];
	const errors: unknown[] = [];
	session.subscribe((event) => events.push(event));
	try {
		await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, setWidget() {}, onTerminalInput: () => () => {} } as never, onError: (error: unknown) => errors.push(error) } as never);
	} catch (error) { session.dispose(); throw error; }
	let closed = false;
	return { session, runtime, waits, events, errors, assertWrapped, assertRestored, expectConfig, async close() {
		if (closed) return;
		closed = true;
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); }
		assertRestored();
	} };
}

async function childSession(baseUrl: string, fixture: NativeFixture, retry: RetrySettings, nativeRegistration = false) {
	const agentDir = mkdtempSync(join(scratch, "child-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry, cacheWarming: "off", transport: "sse", compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "pi-extras.json"), JSON.stringify({ rateLimitRecovery: { autoWait: true } }));
	const { runtime, model, assertWrapped, assertRestored } = await nativeRuntime(baseUrl, fixture, { nativeRegistration });
	const reports: any[] = [];
	const errors: unknown[] = [];
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: (report) => reports.push(report),
		launcher: createLauncher({ sdk: sdk as never, agentDir, cwd: scratch, sessionDir: null, modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "Synthetic quota regression child. No tools or external network.", onExtensionError: (error) => errors.push(error),
		}),
	});
	return { team, model, reports, errors, assertWrapped, assertRestored, async close() { await team.close(); assertRestored(); } };
}

function assertRequests(http: Awaited<ReturnType<typeof endpoint>>, count: number): void {
	assert.deepEqual(http.errors, []);
	assert.equal(http.requests.length, count, "HTTP attempts include any hidden native transport retries");
	for (const request of http.requests) {
		assert.equal(request.body.stream, true);
		if (http.fixture === anthropic) assert.equal(request.retryCount, "0", "Anthropic SDK's internal retry count stays zero");
	}
}

for (const retry of [retrySettings, configuredRetry]) test(`native HTTP 429 recovery persists one timing note before the only resumed request (provider retries ${retry.provider?.maxRetries ?? "default"})`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint({ recover: true, ...(retry.provider ? { retryAfter: "0.2" } : {}) });
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, true, retry);
	t.after(() => f.close());
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; injected waits: ${f.waits.length}`));
	http.observe(() => f.session.sessionManager.getEntries());
	await bounded(f.session.prompt("Continue the task."), () => f.session.abort());
	assertRequests(http, 2);
	assert.equal(notes(http.requests[0]!.entries).length, 0);
	assert.equal(notes(http.requests[1]!.entries).length, 1, "canonical note already persisted when retry reaches HTTP");
	assert.deepEqual(f.waits, [(RETRY_SECONDS + 10) * 1000], "default safety margin, no physical cooldown sleep");
	assert.equal(f.session.getLastAssistantText(), "Recovered over native HTTP.");
	assert.deepEqual(f.errors, []);
	assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 0, "recovery owns recognized quota errors with agent retry enabled");
	const retriedContext = JSON.stringify(http.requests[1]!.body.messages);
	assert.equal((retriedContext.match(/Rate-limit recovery:/g) ?? []).length, 1);
	assert.match(retriedContext, /9915\.234 seconds/);
	assert.match(retriedContext, /Paused at: 2026-09-30T02:00:00\.000Z/);
	assert.match(retriedContext, /Resumed at: 2026-09-30T04:45:15\.234Z/);
	assert.doesNotMatch(retriedContext, /synthetic quota rejection/);
	const raw = f.session.sessionManager.getEntries();
	assert.equal(notes(raw).length, 1);
	assert.ok(raw.some((entry: any) => entry.type === "message" && entry.message.stopReason === "error"), "native rejection retained in raw history");
	assert.ok(!f.session.messages.some((message: any) => message.role === "assistant" && message.stopReason === "error"), "failed assistant omitted from projected retry context");
});

for (const fixture of [anthropic, codex]) for (const retry of [retrySettings, configuredRetry]) test(`default-off TUI main stops after one native ${fixture.provider} HTTP quota rejection (provider retries ${retry.provider?.maxRetries ?? "default"})`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint(fixture === codex ? { retryAfter: "0.1" } : retry.provider ? { retryAfter: "0.2" } : {}, fixture);
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, false, retry, fixture);
	t.after(() => f.close());
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; injected waits: ${f.waits.length}`));
	await bounded(f.session.prompt("Work."), () => f.session.abort());
	assertRequests(http, 1);
	assert.deepEqual(f.waits, []);
	assert.deepEqual(f.errors, []);
	const failure = f.session.messages.at(-1) as any;
	assert.equal(failure.stopReason, "error");
	assert.match(failure.errorMessage, /waiting is off/i);
	assert.match(failure.errorMessage, /9905 seconds/);
	assert.match(failure.errorMessage, /2026-09-30T04:45:05\.000Z/);
	assert.equal(notes(f.session.sessionManager.getEntries()).length, 0);
	assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 0);
});

const childScenarios = [
	{ name: "default provider retries", retry: retrySettings, endpoint: {} },
	{ name: "provider retries 1", retry: configuredRetry, endpoint: { retryAfter: "0.2" } },
	// The deadline must abort this request if transport tries to honor the long
	// header. maxRetryDelayMs=0 prevents its delay ceiling from hiding a sleep.
	{ name: "provider retries 1, uncapped 9905s header", retry: { ...retrySettings, provider: { maxRetries: 1, maxRetryDelayMs: 0 } }, endpoint: { retryAfter: String(RETRY_SECONDS) } },
];
for (const fixture of [anthropic, codex]) for (const scenario of childScenarios) test(`actual pi-extras child guard fails after one native ${fixture.provider} HTTP quota rejection despite parent opt-in (${scenario.name})`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint(fixture === codex && !scenario.endpoint.retryAfter ? { retryAfter: "0.1" } : scenario.endpoint, fixture);
	t.after(() => http.close());
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; deadline: ${DEADLINE_MS}ms`));
	const f = await childSession(http.baseUrl, fixture, scenario.retry);
	const { team, model, reports, errors } = f;
	t.after(() => f.close());
	assert.equal(team.spawn({ name: "limited", task: "Review quota.", parent: "main", model: `${model.provider}/${model.id}`, readOnly: false, fork: false, blocking: false }).ok, true);
	const done = await bounded(team.whenDone("limited"), () => team.close());
	assertRequests(http, 1);
	assert.equal(done.state, "failed");
	assert.ok(done.error?.includes(fixture.provider), "Child report identifies the native provider");
	assert.match(done.error ?? "", /Subagents never automatically wait or resume/);
	assert.match(done.error ?? "", /9905 seconds/);
	assert.match(done.error ?? "", /Expected reset at \d{4}-\d{2}-\d{2}T/);
	assert.equal(reports.filter((report) => report.kind === "report").length, 1);
	assert.deepEqual(errors, []);
	t.diagnostic(`Native HTTP requests: ${http.requests.length}; actual child state: ${done.state}`);
});

for (const fixture of [anthropic, codex]) test(`main shutdown restores native ${fixture.provider} stream functions`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint({ retryAfter: "0.1" }, fixture);
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, false, configuredRetry, fixture, { nativeRegistration: true });
	t.after(() => f.close());
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; main restoration checked`));
	await bounded(f.session.prompt("Exercise native provider lease."), () => f.session.abort());
	f.assertWrapped();
	await f.close();
	f.assertRestored();
	assertRequests(http, 1);
});

for (const fixture of [anthropic, codex]) test(`an actual child's end restores native ${fixture.provider} stream functions`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint({ retryAfter: "0.1" }, fixture);
	t.after(() => http.close());
	const f = await childSession(http.baseUrl, fixture, configuredRetry, true);
	t.after(() => f.close());
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; child restoration checked`));
	// Checked while the request is in flight: the child's session is released as soon as it ends.
	let wrapped = false;
	http.observe(() => {
		try { f.assertWrapped(); wrapped = true; } catch { /* reported below */ }
		return [];
	});
	assert.equal(f.team.spawn({ name: "lease", task: "Exercise child native provider lease.", parent: "main", model: `${f.model.provider}/${f.model.id}`, readOnly: false, fork: false, blocking: false }).ok, true);
	await bounded(f.team.whenDone("lease"), () => f.team.close());
	assert.ok(wrapped, "Quota guard wrapped the native provider during the child's request");
	for (let i = 0; i < 100 && runtimeWrapped(f); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	f.assertRestored();
	await f.team.close();
	f.assertRestored();
	assertRequests(http, 1);
});

/** Whether the guard is still wrapped, without failing; release is asynchronous. */
function runtimeWrapped(f: { assertWrapped(): void }): boolean {
	try { f.assertWrapped(); return true; } catch { return false; }
}

test("ordinary native HTTP 500 retains Pi session retry ownership", { timeout: 10_000 }, async (t) => {
	const http = await endpoint({ status: 500, recover: true });
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, true);
	t.after(() => f.close());
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; session retries: ${f.events.filter((event) => event.type === "auto_retry_start").length}`));
	await bounded(f.session.prompt("Recover a temporary upstream failure."), () => f.session.abort());
	assertRequests(http, 2);
	assert.equal(f.session.getLastAssistantText(), "Recovered over native HTTP.");
	assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 1);
	assert.deepEqual(f.waits, []);
	assert.equal(notes(f.session.sessionManager.getEntries()).length, 0);
	assert.deepEqual(f.errors, []);
});

test("ordinary native HTTP 500 retains transport retries with Pi session retry disabled", { timeout: 10_000 }, async (t) => {
	const http = await endpoint({ status: 500, recover: true, retryAfter: "0.1" });
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, true, { ...configuredRetry, enabled: false });
	t.after(() => f.close());
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; session retries: ${f.events.filter((event) => event.type === "auto_retry_start").length}`));
	await bounded(f.session.prompt("Recover at the native transport boundary only."), () => f.session.abort());
	assertRequests(http, 2);
	assert.equal(f.session.getLastAssistantText(), "Recovered over native HTTP.");
	assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 0);
	assert.deepEqual(f.waits, []);
	assert.equal(notes(f.session.sessionManager.getEntries()).length, 0);
	assert.deepEqual(f.errors, []);
});

for (const recoveryEnabled of [false, true]) test(`endpoint/header overlays and models-file updates survive foreign partial registration (recovery ${recoveryEnabled ? "loaded" : "not loaded"})`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint({ retryAfter: "0.1" });
	t.after(() => http.close());
	const modelsPath = join(mkdtempSync(join(scratch, "models-")), "models.json");
	const id = "claude-sonnet-4-5";
	const saveModels = (override: object) => writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { modelOverrides: { [id]: override } } } }));
	saveModels({ contextWindow: 32000, headers: { "x-model-file": "first" } });
	const headers = { "x-overlay-origin": "preserved" };
	const f = await mainSession(http.baseUrl, false, { ...retrySettings, enabled: false }, anthropic, { modelsPath, headers, recoveryEnabled });
	t.after(() => t.diagnostic(`Native HTTP requests: ${http.requests.length}; live overlay/model reload checks`));
	t.after(() => f.close());
	const currentModel = () => { const model = f.runtime.getModel("anthropic", id); assert.ok(model); return model; };
	const initial = currentModel();
	assert.equal(initial.contextWindow, 32000);
	assert.equal((await f.runtime.getAuth(initial))?.auth.headers?.["x-model-file"], "first");
	await bounded(f.session.prompt("Activate recovery provider handling."), () => f.session.abort());
	const expected = { baseUrl: http.baseUrl, apiKey: "synthetic-http-test-key", headers, name: "Foreign partial registration" };
	f.runtime.registerProvider("anthropic", { name: expected.name });
	f.expectConfig(expected);
	const registered = f.runtime.getRegisteredProviderConfig("anthropic");
	// The active guard may add its own selector/callback. Foreign configuration
	// must still merge exactly; complete equality belongs after shutdown.
	for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
		assert.deepEqual(registered?.[key], expected[key], `Foreign partial registration preserves ${key}`);
	}
	assert.equal(currentModel().baseUrl, http.baseUrl);
	assert.equal((await f.runtime.getAuth(currentModel()))?.auth.headers?.["x-overlay-origin"], "preserved");
	await bounded(f.session.prompt("Use the merged provider registration."), () => f.session.abort());
	saveModels({ contextWindow: 48000, headers: { "x-model-file": "second" } });
	await f.runtime.refresh({ allowNetwork: false, providers: ["anthropic"] });
	const updated = currentModel();
	assert.equal(updated.contextWindow, 48000);
	assert.equal((await f.runtime.getAuth(updated))?.auth.headers?.["x-model-file"], "second");
	await f.session.setModel(updated);
	await bounded(f.session.prompt("Use updated model-file fields."), () => f.session.abort());
	saveModels({});
	await f.runtime.refresh({ allowNetwork: false, providers: ["anthropic"] });
	const removed = currentModel();
	assert.notEqual(removed.contextWindow, 32000, "Removed context limit must not be frozen in a wrapped provider snapshot");
	assert.notEqual(removed.contextWindow, 48000);
	assert.equal((await f.runtime.getAuth(removed))?.auth.headers?.["x-model-file"], undefined, "Removed model header must not remain in a wrapped provider snapshot");
	assert.equal(removed.baseUrl, http.baseUrl);
	await f.session.setModel(removed);
	await bounded(f.session.prompt("Use model-file fields after removal."), () => f.session.abort());
	assertRequests(http, 4);
	assert.deepEqual(http.requests.map((request) => request.metadata), [
		{ overlay: "preserved", model: "first" }, { overlay: "preserved", model: "first" },
		{ overlay: "preserved", model: "second" }, { overlay: "preserved", model: undefined },
	], "Live provider/model headers reach the native HTTP transport after updates and removals");
	assert.deepEqual(f.errors, []);
	await f.close();
	assert.deepEqual(f.runtime.getRegisteredProviderConfig("anthropic"), expected, "Shutdown must not erase foreign partial registrations");
});

test.after(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	rmSync(scratch, { recursive: true, force: true });
});
