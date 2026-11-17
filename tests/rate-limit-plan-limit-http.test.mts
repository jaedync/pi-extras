/**
 * ChatGPT plan usage limits through Pi's real Codex and OpenAI Responses providers, the SDK
 * session and this extension: the Codex 429 body and its WebSocket event form, Sign in with
 * ChatGPT's code and its recorded prose (2026-10-20), the plan readings, and an actual child.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { agentRoot, piAiRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "rate-limit-plan-http-"));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const originalFetch = globalThis.fetch;
const allowedOrigins = new Set<string>();
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.ok(allowedOrigins.has(url.origin), `Unexpected non-fixture network request to ${url.origin}`);
	return originalFetch(input, init);
};
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;
const { default: recovery } = await import("../extensions/rate-limit-recovery.ts");
const { createLauncher } = await import("../lib/subagents/child.ts");
const { Team } = await import("../lib/subagents/team.ts");
const { createLimitStore } = await import("../lib/limit-store.ts");
const { setPlanAuthFile } = await import("../lib/plan-billing.ts");

// The transport checks a reset against the real clock, so the session clock starts there.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const HOUR_MS = 3600_000;
const DEADLINE_MS = 4000;
const RECORDED_PROSE = "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
const CODEX_PROSE = "The usage limit has been reached";
const retry = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
const accountId = "synthetic-plan-account";
const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const codexToken = `${jwtPart({ alg: "none", typ: "JWT" })}.${jwtPart({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.synthetic-signature`;
interface Fixture { readonly provider: "openai-codex" | "openai"; readonly api: string; readonly route: string }
const codex: Fixture = { provider: "openai-codex", api: "openai-codex-responses", route: "/codex/responses" };
const chatgpt: Fixture = { provider: "openai", api: "openai-responses", route: "/responses" };
const notes = (entries: readonly any[]) => entries.filter((entry) => entry.type === "custom_message" && entry.customType === "rate-limit-recovery");
const sse = (res: ServerResponse, type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

function success(res: ServerResponse): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Recovered after the plan reset.", annotations: [] }] };
	sse(res, "response.created", { response: { id: "resp_fixture", status: "in_progress" } });
	sse(res, "response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
	sse(res, "response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "Recovered after the plan reset." });
	sse(res, "response.output_item.done", { output_index: 0, item });
	sse(res, "response.completed", { response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } });
	res.end();
}

/** How the plan refuses: Codex's HTTP 429 body, its WebSocket event form on a stream, or Sign in with ChatGPT's failed response. */
type Rejection =
	| { readonly kind: "codex-429"; readonly resetsAtMs: number; readonly windowMinutes: number }
	| { readonly kind: "codex-event"; readonly resetsAtMs: number; readonly windowMinutes: number }
	| { readonly kind: "chatgpt-failed"; readonly code: boolean };

function reject(res: ServerResponse, rejection: Rejection): void {
	if (rejection.kind === "codex-429") {
		res.writeHead(429, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: CODEX_PROSE, plan_type: "plus", resets_at: rejection.resetsAtMs / 1000, limit_window_minutes: rejection.windowMinutes } }));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (rejection.kind === "codex-event") {
		// The shape of codex-rs responses_websocket.rs `parse_wrapped_websocket_error_event_maps_to_transport_http`.
		sse(res, "error", { status: 429, error: { type: "usage_limit_reached", message: CODEX_PROSE, plan_type: "plus", resets_at: rejection.resetsAtMs / 1000, limit_window_minutes: rejection.windowMinutes } });
	} else {
		sse(res, "response.created", { response: { id: "resp_fixture", status: "in_progress" } });
		sse(res, "response.failed", { response: { id: "resp_fixture", status: "failed", error: { ...(rejection.code ? { code: "subscription_sharing_usage_limit_exceeded" } : {}), message: RECORDED_PROSE } } });
	}
	res.end();
}

async function endpoint(fixture: Fixture, rejection: Rejection, recover = true) {
	const requests: { entries: readonly any[] }[] = [];
	const errors: unknown[] = [];
	let entries: () => readonly any[] = () => [];
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url?.split("?")[0] !== fixture.route) { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("error", (error) => errors.push(error));
		req.on("end", () => {
			try {
				const body = Buffer.concat(chunks);
				JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(body, { maxOutputLength: 1_000_000 }) : body).toString("utf8"));
				requests.push({ entries: [...entries()] });
				if (recover && requests.length === 2) success(res);
				else reject(res, rejection);
			} catch (error) { errors.push(error); res.writeHead(500).end(); }
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	allowedOrigins.add(baseUrl);
	return { requests, errors, baseUrl, observe: (getEntries: typeof entries) => { entries = getEntries; }, async close() {
		allowedOrigins.delete(baseUrl);
		await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
	} };
}

/** Sign in with ChatGPT is an OAuth record for `openai` in Pi's auth.json; an API key is not. */
function login(kind: "oauth" | "api_key"): void {
	const file = join(mkdtempSync(join(scratch, "auth-")), "auth.json");
	writeFileSync(file, JSON.stringify({ openai: { type: kind } }));
	setPlanAuthFile(file);
}

async function runtimeFor(baseUrl: string, fixture: Fixture) {
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify(fixture.provider, async () => fixture === codex
		? { type: "oauth", access: codexToken, refresh: "synthetic-never-refresh", expires: Date.now() + 86_400_000 }
		: { type: "api_key", key: "synthetic-plan-test-key" });
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new ai.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider(fixture.provider, fixture === codex ? { baseUrl, oauth: {
		name: "Synthetic native Codex OAuth", isSubscription: true,
		login: async () => { throw new Error("Fixture must never initiate OAuth login"); },
		refreshToken: async () => { throw new Error("Fixture must never refresh synthetic OAuth"); },
		getApiKey: (credential: { access: string }) => credential.access,
	} } : { baseUrl, apiKey: "synthetic-plan-test-key" });
	const model = runtime.getModels(fixture.provider).find((candidate: { api: string }) => candidate.api === fixture.api);
	assert.ok(model, `Pi's catalog has a ${fixture.provider} model on ${fixture.api}`);
	assert.equal(model.baseUrl, baseUrl);
	return { runtime, model };
}

async function bounded<T>(work: Promise<T>, cancel: () => Promise<void>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Plan-limit fixture exceeded bounded deadline")), DEADLINE_MS);
		})]);
	} catch (error) { await cancel(); throw error; }
	finally { clearTimeout(timer); }
}

/** Plan readings as status-plus's poll writes them; `polls` counts the forced polls. */
function planReadings(entries: (now: number) => object[] | undefined) {
	const store = createLimitStore();
	const polls: string[] = [];
	store.setRefresher(async (provider: string, force: boolean) => {
		polls.push(`${provider}:${force}`);
		const polled = entries(NOW);
		if (polled) store.set("openai-codex", { entries: polled as never, atMs: NOW, source: "poll" });
	});
	return { store, polls };
}

async function mainSession(baseUrl: string, fixture: Fixture, limits = planReadings(() => undefined)) {
	const agentDir = mkdtempSync(join(scratch, "main-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify({ rateLimitRecovery: { autoWait: true } }));
	const { runtime, model } = await runtimeFor(baseUrl, fixture);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", transport: "sse", retry });
	let now = NOW;
	const waits: number[] = [];
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "plan-limit-recovery", factory: (pi) => recovery(pi, { configFile, env: {}, now: () => now, limits: limits.store,
			wait: async (ms, signal) => { assert.equal(signal.aborted, false); waits.push(ms); now += ms + 234; return true; },
		}) }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "all" });
	const events: any[] = [];
	const errors: unknown[] = [];
	session.subscribe((event) => events.push(event));
	await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, setWidget() {}, onTerminalInput: () => () => {} } as never, onError: (error: unknown) => errors.push(error) } as never);
	return { session, waits, events, errors, polls: limits.polls, async close() {
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); }
	} };
}

function assertResumedOnce(http: Awaited<ReturnType<typeof endpoint>>, f: Awaited<ReturnType<typeof mainSession>>, resetAtMs: number): void {
	assert.deepEqual(http.errors, []);
	assert.equal(http.requests.length, 2, "one rejected request and one continuation, no hidden retries");
	assert.equal(notes(http.requests[0]!.entries).length, 0);
	assert.equal(notes(http.requests[1]!.entries).length, 1, "the timing note is saved before the continuation reaches HTTP");
	assert.deepEqual(f.waits, [resetAtMs - NOW + 10_000], "the wait ends at the plan reset plus the 10 s margin");
	assert.equal(f.session.getLastAssistantText(), "Recovered after the plan reset.");
	assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 0, "Pi's own retry does not compete");
	assert.deepEqual(f.errors, []);
	const context = JSON.stringify(f.session.messages);
	assert.equal((context.match(/Rate-limit recovery:/g) ?? []).length, 1);
	assert.doesNotMatch(context, /Subscription Sharing|usage limit has been reached/, "no provider prose reaches the model");
	assert.ok(!f.session.messages.some((message: any) => message.role === "assistant" && message.stopReason === "error"), "the failed reply leaves the context");
}

function failure(f: Awaited<ReturnType<typeof mainSession>>): string {
	const last = f.session.messages.at(-1) as any;
	assert.equal(last.stopReason, "error");
	return last.errorMessage;
}

for (const kind of ["codex-429", "codex-event"] as const) test(`a Codex plan limit (${kind}) waits for the 5h reset the provider sent and continues once`, { timeout: 10_000 }, async (t) => {
	const resetsAtMs = NOW + 2 * HOUR_MS;
	const http = await endpoint(codex, { kind, resetsAtMs, windowMinutes: 300 });
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, codex);
	t.after(() => f.close());
	http.observe(() => f.session.sessionManager.getEntries());
	await bounded(f.session.prompt("Continue the long task."), () => f.session.abort());
	assertResumedOnce(http, f, resetsAtMs);
	assert.deepEqual(f.polls, [], "an exact reset from the provider needs no poll");
});

test("a Codex weekly-window rejection is refused with its reset time and what to do", { timeout: 10_000 }, async (t) => {
	const resetsAtMs = NOW + 3 * 24 * HOUR_MS;
	const http = await endpoint(codex, { kind: "codex-429", resetsAtMs, windowMinutes: 10080 }, false);
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, codex);
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue the long task."), () => f.session.abort());
	assert.equal(http.requests.length, 1);
	assert.deepEqual(f.waits, []);
	const text = failure(f);
	assert.match(text, /ChatGPT plan usage limit was reached \(the 7d window is full\)/);
	assert.match(text, new RegExp(`Expected reset at ${new Date(resetsAtMs).toISOString().replace(/\./g, "\\.")}`));
	assert.match(text, /no wait was scheduled\. Continue after the reset, or switch to a model of another provider/);
	assert.doesNotMatch(text, /usage limit has been reached/, "no provider prose");
	assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 0);
});

for (const code of [true, false]) test(`Sign in with ChatGPT's plan limit (${code ? "with its code" : "recorded prose only"}) waits for the reset of the full window in a fresh reading`, { timeout: 10_000 }, async (t) => {
	login("oauth");
	t.after(() => setPlanAuthFile(undefined));
	const resetAtMs = NOW + 90 * 60_000;
	const limits = planReadings((now) => [
		{ label: "5h", key: "primary", usedPct: 100, exhausted: true, resetMs: resetAtMs, windowSeconds: 18_000, sampledMs: now },
		{ label: "7d", key: "secondary", usedPct: 61, exhausted: false, resetMs: now + 4 * 24 * HOUR_MS, windowSeconds: 604_800, sampledMs: now },
	]);
	const http = await endpoint(chatgpt, { kind: "chatgpt-failed", code });
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, chatgpt, limits);
	t.after(() => f.close());
	http.observe(() => f.session.sessionManager.getEntries());
	await bounded(f.session.prompt("Continue the long task."), () => f.session.abort());
	assertResumedOnce(http, f, resetAtMs);
	assert.deepEqual(f.polls, ["openai:true"], "one forced poll of the plan");
});

for (const [name, entries, reason] of [
	["no reading", () => undefined, /No usage reading of the ChatGPT plan from the last minute/],
	["a reading with no full window", (now: number) => [{ label: "5h", key: "primary", usedPct: 40, exhausted: false, resetMs: now + HOUR_MS, sampledMs: now }], /show no full window/],
	["a full weekly window", (now: number) => [{ label: "7d", key: "secondary", usedPct: 100, exhausted: true, resetMs: now + 2 * 24 * HOUR_MS, sampledMs: now }], /the 7d window is full\)\. Expected reset at .*no wait was scheduled/],
] as const) test(`Sign in with ChatGPT's plan limit with ${name} stops the run with guidance`, { timeout: 10_000 }, async (t) => {
	login("oauth");
	t.after(() => setPlanAuthFile(undefined));
	const http = await endpoint(chatgpt, { kind: "chatgpt-failed", code: true }, false);
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, chatgpt, planReadings(entries as (now: number) => object[] | undefined));
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue the long task."), () => f.session.abort());
	assert.equal(http.requests.length, 1);
	assert.deepEqual(f.waits, []);
	const text = failure(f);
	assert.match(text, /^Request quota exceeded for openai: the ChatGPT plan usage limit was reached/);
	assert.match(text, reason);
	assert.doesNotMatch(text, /Subscription Sharing/, "no provider prose");
});

test("an openai API-key session is unchanged: no poll, no wait, Pi's own error", { timeout: 10_000 }, async (t) => {
	login("api_key");
	t.after(() => setPlanAuthFile(undefined));
	const limits = planReadings((now) => [{ label: "5h", key: "primary", usedPct: 100, exhausted: true, resetMs: now + HOUR_MS, sampledMs: now }]);
	const http = await endpoint(chatgpt, { kind: "chatgpt-failed", code: true }, false);
	t.after(() => http.close());
	const f = await mainSession(http.baseUrl, chatgpt, limits);
	t.after(() => f.close());
	await bounded(f.session.prompt("Work."), () => f.session.abort());
	assert.equal(http.requests.length, 1);
	assert.deepEqual(f.waits, []);
	assert.deepEqual(f.polls, []);
	const text = failure(f);
	assert.match(text, /subscription_sharing_usage_limit_exceeded: The ChatGPT user has reached/, "Pi's message as Pi wrote it");
	assert.doesNotMatch(text, /Request quota exceeded/);
	assert.equal(notes(f.session.sessionManager.getEntries()).length, 0);
});

test("an actual child fails fast on a Codex plan limit with the reset time, despite the parent's opt-in", { timeout: 10_000 }, async (t) => {
	const resetsAtMs = NOW + 2 * HOUR_MS;
	const http = await endpoint(codex, { kind: "codex-429", resetsAtMs, windowMinutes: 300 }, false);
	t.after(() => http.close());
	const agentDir = mkdtempSync(join(scratch, "child-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry, cacheWarming: "off", transport: "sse", compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "pi-extras.json"), JSON.stringify({ rateLimitRecovery: { autoWait: true } }));
	const { runtime, model } = await runtimeFor(http.baseUrl, codex);
	const errors: unknown[] = [];
	const team = new Team({ maxConcurrent: 1, maxDepth: 1, replyTimeoutMs: 1000, deliverToMain: () => {},
		launcher: createLauncher({ sdk: sdk as never, agentDir, cwd: scratch, sessionDir: null, modelRuntime: async () => runtime,
			toolsFor: () => ({ tools: [], customTools: [] }), instructions: () => "Synthetic plan-limit child. No tools or external network.", onExtensionError: (error) => errors.push(error),
		}),
	});
	t.after(() => team.close());
	assert.equal(team.spawn({ name: "limited", task: "Review.", parent: "main", model: `${model.provider}/${model.id}`, readOnly: false, fork: false, blocking: false }).ok, true);
	const done = await bounded(team.whenDone("limited"), () => team.close());
	assert.equal(http.requests.length, 1);
	assert.equal(done.state, "failed");
	assert.match(done.error ?? "", /ChatGPT plan usage limit was reached \(the 5h window is full\)/);
	assert.match(done.error ?? "", /Subagents never automatically wait or resume/);
	assert.match(done.error ?? "", new RegExp(`Expected reset at ${new Date(resetsAtMs).toISOString().replace(/\./g, "\\.")}`));
	assert.deepEqual(errors, []);
});

test.after(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	rmSync(scratch, { recursive: true, force: true });
});
