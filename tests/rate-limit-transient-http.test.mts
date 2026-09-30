/** Pi's real OpenRouter (openai-completions) adapter against a local server returning upstream 429s. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "transient-http-"));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const originalFetch = globalThis.fetch;
const allowedOrigins = new Set<string>();
// Fail closed: nothing here may reach a real provider.
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	assert.ok(allowedOrigins.has(url.origin), `Unexpected non-fixture network request to ${url.origin}`);
	return originalFetch(input, init);
};
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const { default: recovery } = await import("../extensions/rate-limit-recovery.ts");
const { createChildRateLimitGuard } = await import("../lib/rate-limit-recovery/child.ts");

const DEADLINE_MS = 5000;
const UPSTREAM = "is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations";
type Reply = "limited" | { readonly limited: true; readonly retryAfter: string } | "midstream" | "ok";
interface Seen { readonly model: string }

function limited(res: ServerResponse, model: string, retryAfter?: string): void {
	res.writeHead(429, { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}) });
	res.end(JSON.stringify({ error: { message: `${model} ${UPSTREAM}`, code: 429, metadata: { raw: `${model} ${UPSTREAM}`, provider_name: "OpenAI" } } }));
}

// OpenRouter reports a limit hit after streaming starts as an error event on an HTTP 200.
function midstream(res: ServerResponse, model: string): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write(`data: ${JSON.stringify({ id: "gen-synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Partial " }, finish_reason: null }] })}\n\n`);
	res.end(`data: ${JSON.stringify({ error: { message: `${model} ${UPSTREAM}`, code: 429 } })}\n\n`);
}

function success(res: ServerResponse, model: string): void {
	const chunk = (delta: object, finish: string | null, extra: object = {}) => res.write(`data: ${JSON.stringify({ id: "gen-synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	chunk({ role: "assistant", content: `Answered by ${model}.` }, null);
	chunk({}, "stop", { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
	res.end("data: [DONE]\n\n");
}

async function endpoint(script: readonly Reply[]) {
	const requests: Seen[] = [];
	const server = createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.split("?")[0]!.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push({ model: body.model });
			const reply = script[requests.length - 1] ?? script.at(-1) ?? "ok";
			if (reply === "ok") success(res, body.model);
			else if (reply === "midstream") midstream(res, body.model);
			else limited(res, body.model, typeof reply === "object" ? reply.retryAfter : undefined);
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	allowedOrigins.add(origin);
	return { requests, baseUrl: `${origin}/api/v1`, async close() {
		allowedOrigins.delete(origin);
		await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
	} };
}

type Wait = (ms: number, signal: AbortSignal) => Promise<boolean>;
interface SessionOptions { readonly transientMaxWaitSeconds?: number; readonly wait?: Wait; readonly child?: boolean }

async function session(baseUrl: string, options: SessionOptions = {}) {
	const agentDir = mkdtempSync(join(scratch, "agent-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, JSON.stringify(options.transientMaxWaitSeconds === undefined ? {} : { rateLimitRecovery: { transientMaxWaitSeconds: options.transientMaxWaitSeconds } }));
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify("openrouter", async () => ({ type: "api_key", key: "synthetic-not-a-credential" }));
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("openrouter", { baseUrl, apiKey: "synthetic-not-a-credential" });
	const [model, other] = runtime.getModels("openrouter").filter((candidate) => candidate.api === "openai-completions");
	assert.ok(model && other);
	const waits: number[] = [];
	const wait: Wait = options.wait ?? (async (ms) => { waits.push(ms); return true; });
	const recorded: Wait = (ms, signal) => { if (options.wait) waits.push(ms); return wait(ms, signal); };
	// Pi's own retry stays on with its defaults, so a double retry owner would show up as requests.
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", transport: "sse", retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
	const factory = options.child
		? createChildRateLimitGuard({ configFile, transient: { wait: recorded, random: () => 0.5 } }).extension
		: { name: "transient-recovery", factory: (pi: any) => recovery(pi, { configFile, env: {}, wait: (ms, signal) => recorded(ms, signal), random: () => 0.5 }) };
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [factory] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "all" });
	const events: any[] = [];
	const errors: unknown[] = [];
	session.subscribe((event) => events.push(event));
	await session.bindExtensions({ mode: options.child ? "print" : "tui", uiContext: { notify() {}, setWidget() {}, onTerminalInput: () => () => {} } as never, onError: (error: unknown) => errors.push(error) } as never);
	return { session, model, other, waits, events, errors, async close() {
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); }
	} };
}

async function bounded<T>(work: Promise<T>, cancel: () => Promise<void>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Transient fixture exceeded bounded deadline")), DEADLINE_MS);
		})]);
	} catch (error) { await cancel(); throw error; }
	finally { clearTimeout(timer); }
}

const piRetries = (events: readonly any[]) => events.filter((event) => event.type === "auto_retry_start").length;
const failedInContext = (f: Awaited<ReturnType<typeof session>>) => f.session.messages.filter((message: any) => message.role === "assistant" && message.stopReason === "error");

for (const child of [false, true]) test(`an upstream 429 streak is waited out and resumed (${child ? "print-mode subagent guard" : "interactive main"})`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["limited", "limited", "ok"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl, { child });
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.equal(http.requests.length, 3, "one request per attempt: Pi's own retry did not also run");
	assert.deepEqual(f.waits, [5_000, 10_000]);
	assert.equal(piRetries(f.events), 0);
	assert.equal(f.session.getLastAssistantText(), `Answered by ${f.model.id}.`);
	assert.deepEqual(failedInContext(f), [], "failed attempts are omitted from the retried context");
	assert.equal(f.session.sessionManager.getEntries().filter((entry: any) => entry.type === "message" && entry.message.stopReason === "error").length, 2, "raw history keeps them");
	assert.deepEqual(f.errors, []);
});

test("a Retry-After header on the 429 sets the wait", { timeout: 10_000 }, async (t) => {
	const http = await endpoint([{ limited: true, retryAfter: "7" }, "ok"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl);
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.deepEqual(f.waits, [7_000]);
	assert.equal(http.requests.length, 2);
});

test("a limit reported mid-stream on an HTTP 200 is waited out too, dropping the partial reply", { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["midstream", "ok"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl);
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.deepEqual(f.waits, [5_000]);
	assert.equal(http.requests.length, 2);
	assert.equal(piRetries(f.events), 0);
	assert.equal(f.session.getLastAssistantText(), `Answered by ${f.model.id}.`);
	assert.deepEqual(failedInContext(f), []);
});

test("a limit that outlasts the budget ends the run with guidance and no Pi retries", { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["limited"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl, { transientMaxWaitSeconds: 10 });
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.deepEqual(f.waits, [5_000, 5_000], "the second wait uses what remains of the budget");
	assert.equal(http.requests.length, 3);
	assert.equal(piRetries(f.events), 0);
	const failure = f.session.messages.at(-1) as any;
	assert.equal(failure.stopReason, "error");
	assert.match(failure.errorMessage, /^Request quota exceeded for openrouter\/.+: a temporary provider rate limit\. It persisted after 2 automatic retries over 10 s\./);
});

test("transientMaxWaitSeconds 0 leaves the error to Pi's own retry", { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["limited", "ok"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl, { transientMaxWaitSeconds: 0 });
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.deepEqual(f.waits, []);
	assert.equal(piRetries(f.events), 1);
	assert.equal(http.requests.length, 2);
	assert.equal(f.session.getLastAssistantText(), `Answered by ${f.model.id}.`);
});

test("switching models during the wait resumes at once with the new model", { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["limited", "ok"]);
	t.after(() => http.close());
	let f!: Awaited<ReturnType<typeof session>>;
	// Waits until aborted, as a real 5 s timer would outlast this switch.
	const hold: Wait = (_ms, signal) => new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(false), { once: true });
		void f.session.setModel(f.other);
	});
	f = await session(http.baseUrl, { wait: hold });
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.deepEqual(http.requests.map((request) => request.model), [f.model.id, f.other.id]);
	assert.equal(f.session.getLastAssistantText(), `Answered by ${f.other.id}.`);
	assert.equal(piRetries(f.events), 0);
});

test("aborting during the wait ends the run without another request", { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["limited", "ok"]);
	t.after(() => http.close());
	let f!: Awaited<ReturnType<typeof session>>;
	const escape: Wait = (_ms, signal) => new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(false), { once: true });
		void f.session.abort();
	});
	f = await session(http.baseUrl, { wait: escape });
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.equal(http.requests.length, 1);
	assert.equal(piRetries(f.events), 0);
});

test.after(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(scratch, { recursive: true, force: true });
});
