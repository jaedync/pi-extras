/** Pi's real Anthropic adapter against a local server that holds a request with pings only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "first-event-http-"));
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
const { stallMessage } = await import("../lib/rate-limit-recovery/first-event.ts");

const TIMEOUT_MS = 150;
const PING_MS = 20;
const LATE_MS = TIMEOUT_MS * 3;
const DEADLINE_MS = 5000;
// Pi treats this prefix as subscription OAuth and sends it as a bearer token.
const OAUTH_TOKEN = "sk-ant-oat01-synthetic-not-a-credential";
const API_KEY = "synthetic-http-test-key";
type Behavior = "stall" | "late" | "ok";
interface Seen { readonly authorization: string | undefined; readonly apiKey: string | undefined; closedEarly: boolean }

function sse(res: ServerResponse, type: string, data: object): void {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function success(res: ServerResponse, model: string): void {
	sse(res, "message_start", { message: { id: "msg_synthetic", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } });
	sse(res, "ping", {});
	sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "Recovered after a held stream." } });
	sse(res, "content_block_stop", { index: 0 });
	sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
	sse(res, "message_stop", {});
	res.end();
}

function respond(req: IncomingMessage, res: ServerResponse, behavior: Behavior, model: string, seen: Seen): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	if (behavior === "ok") { success(res, model); return; }
	// The held-request shape from earendil-works/pi#10019: headers, then pings only.
	sse(res, "ping", {});
	const pings = setInterval(() => sse(res, "ping", {}), PING_MS);
	const late = behavior === "late" ? setTimeout(() => { clearInterval(pings); success(res, model); }, LATE_MS) : undefined;
	res.on("close", () => {
		clearInterval(pings); clearTimeout(late);
		if (!res.writableEnded) seen.closedEarly = true;
	});
	req.on("error", () => undefined);
}

async function endpoint(script: readonly Behavior[]) {
	const requests: Seen[] = [];
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const seen: Seen = { authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined, closedEarly: false };
			requests.push(seen);
			respond(req, res, script[requests.length - 1] ?? "ok", body.model, seen);
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	allowedOrigins.add(baseUrl);
	return { requests, baseUrl, host: new URL(baseUrl).host, async close() {
		allowedOrigins.delete(baseUrl);
		await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
	} };
}

interface SessionOptions { readonly key: string; readonly hosts: ReadonlySet<string>; readonly maxRetries?: number }
async function session(baseUrl: string, options: SessionOptions) {
	const agentDir = mkdtempSync(join(scratch, "main-"));
	const configFile = join(agentDir, "pi-extras.json");
	writeFileSync(configFile, "{}");
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: options.key }));
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("anthropic", { baseUrl, apiKey: options.key });
	const model = runtime.getModel("anthropic", "claude-sonnet-4-5");
	assert.ok(model);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", transport: "sse", retry: { enabled: true, maxRetries: options.maxRetries ?? 3, baseDelayMs: 1 } });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "first-event-recovery", factory: (pi) => recovery(pi, { configFile, env: {}, firstEvent: { timeoutMs: TIMEOUT_MS, hosts: options.hosts } }) }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch), noTools: "all" });
	const events: any[] = [];
	const errors: unknown[] = [];
	session.subscribe((event) => events.push(event));
	await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, setWidget() {}, onTerminalInput: () => () => {} } as never, onError: (error: unknown) => errors.push(error) } as never);
	return { session, events, errors, async close() {
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); }
	} };
}

async function bounded<T>(work: Promise<T>, cancel: () => Promise<void>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("First-event fixture exceeded bounded deadline")), DEADLINE_MS);
		})]);
	} catch (error) { await cancel(); throw error; }
	finally { clearTimeout(timer); }
}

const retries = (events: readonly any[]) => events.filter((event) => event.type === "auto_retry_start");

// The watchdog cancels without awaiting, so a server close can trail the finished turn.
async function released(requests: readonly Seen[]): Promise<boolean> {
	for (let waited = 0; waited < 1000 && !requests.every((request) => request.closedEarly); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
	return requests.every((request) => request.closedEarly);
}

test("a subscription stream held with pings fails fast and Pi's retry recovers", { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["stall", "ok"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl, { key: OAUTH_TOKEN, hosts: new Set([http.host]) });
	t.after(() => f.close());
	const started = Date.now();
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	const elapsed = Date.now() - started;
	assert.equal(f.session.getLastAssistantText(), "Recovered after a held stream.");
	assert.equal(http.requests.length, 2);
	assert.equal(http.requests[0]!.authorization, `Bearer ${OAUTH_TOKEN}`, "fixture exercises Pi's subscription auth path");
	assert.equal(http.requests[0]!.apiKey, undefined);
	assert.ok(await released(http.requests.slice(0, 1)), "the held connection is released, not left open");
	const attempts = retries(f.events);
	assert.equal(attempts.length, 1);
	assert.equal(attempts[0].errorMessage, stallMessage(TIMEOUT_MS));
	// The held request never completes by itself; this only guards against a hidden long wait.
	assert.ok(elapsed < DEADLINE_MS / 2, `recovered in ${elapsed}ms`);
	assert.ok(!f.session.messages.some((message: any) => message.role === "assistant" && message.stopReason === "error"), "failed attempt omitted from the retried context");
	assert.deepEqual(f.errors, []);
});

test("repeated holds stop at Pi's retry limit with the stall reason", { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["stall", "stall", "stall"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl, { key: OAUTH_TOKEN, hosts: new Set([http.host]), maxRetries: 1 });
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.equal(http.requests.length, 2, "one original request plus Pi's single allowed retry");
	const failure = f.session.messages.at(-1) as any;
	assert.equal(failure.stopReason, "error");
	assert.equal(failure.errorMessage, stallMessage(TIMEOUT_MS));
	assert.ok(await released(http.requests), "every held connection is released");
});

const untouched = [
	{ name: "API-key auth", key: API_KEY, hosts: (host: string) => new Set([host]) },
	{ name: "a host outside the watched set (such as a local Meridian proxy)", key: OAUTH_TOKEN, hosts: () => new Set(["api.anthropic.com"]) },
];
for (const scenario of untouched) test(`${scenario.name} keeps Pi's own behavior for a slow first event`, { timeout: 10_000 }, async (t) => {
	const http = await endpoint(["late"]);
	t.after(() => http.close());
	const f = await session(http.baseUrl, { key: scenario.key, hosts: scenario.hosts(http.host) });
	t.after(() => f.close());
	await bounded(f.session.prompt("Continue."), () => f.session.abort());
	assert.equal(http.requests.length, 1);
	assert.equal(http.requests[0]!.closedEarly, false);
	assert.equal(retries(f.events).length, 0);
	assert.equal(f.session.getLastAssistantText(), "Recovered after a held stream.");
});

test.after(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(scratch, { recursive: true, force: true });
});
