import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ANTHROPIC_HOSTS, guardFirstEvent, stallMessage, subscriptionMessagesRequest, watchFirstEvent, type FirstEventPolicy } from "../lib/rate-limit-recovery/first-event.ts";
import { createQuotaTransportGuard } from "../lib/rate-limit-recovery/transport.ts";
import { agentRoot } from "./support/pi-runtime.mjs";

const { isRetryableAssistantError } = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/utils/retry.js")).href);

const TIMEOUT_MS = 60;
const PING = "event: ping\ndata: {\"type\": \"ping\"}\n\n";
const START = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
const encoder = new TextEncoder();
const policy = { timeoutMs: TIMEOUT_MS, hosts: ANTHROPIC_HOSTS };
const oauth = { headers: { authorization: "Bearer synthetic-not-a-credential" } };
const messagesUrl = "https://api.anthropic.com/v1/messages?beta=true";

function upstream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const state = { cancelled: false };
	const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { state.cancelled = true; } });
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "request-id": "req_synthetic" } });
	return { response, state, send: (text: string) => controller.enqueue(encoder.encode(text)), close: () => controller.close(), fail: (error: unknown) => controller.error(error) };
}

async function readAll(response: Response): Promise<string> {
	return new TextDecoder().decode(await response.arrayBuffer());
}

test("keep-alive pings alone fail the stream with an error Pi's retry classifier accepts", async () => {
	const source = upstream();
	const watched = watchFirstEvent(source.response, TIMEOUT_MS);
	source.send(PING);
	const reading = readAll(watched);
	await sleep(TIMEOUT_MS / 3);
	source.send(PING);
	await assert.rejects(reading, (error: Error) => error.message === stallMessage(TIMEOUT_MS));
	assert.equal(source.state.cancelled, true, "the held upstream connection is released");
	assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: stallMessage(TIMEOUT_MS) }), true);
	assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: stallMessage(45_000) }), true);
	assert.match(stallMessage(45_000), /45s/);
});

test("a first event split across chunks disarms the watchdog and bytes pass through unchanged", async () => {
	const source = upstream();
	const watched = watchFirstEvent(source.response, TIMEOUT_MS);
	assert.equal(watched.status, 200);
	assert.equal(watched.headers.get("request-id"), "req_synthetic");
	const reading = readAll(watched);
	const chunks = ["event: pi", "ng\ndata: {}\n\nevent: message_", "start\r\ndata: {}\r\n\r\n"];
	for (const chunk of chunks) source.send(chunk);
	// Silence after the first real event belongs to Pi's own idle handling.
	await sleep(TIMEOUT_MS * 2);
	source.send("event: message_stop\ndata: {}\n\n");
	source.close();
	assert.equal(await reading, `${chunks.join("")}event: message_stop\ndata: {}\n\n`);
});

// A regression disarms the watchdog, so the read would otherwise hang until the suite timeout.
test("an overlong comment line cannot fake an event boundary", { timeout: 2000 }, async () => {
	const source = upstream();
	const reading = readAll(watchFirstEvent(source.response, TIMEOUT_MS));
	// Its retained 4096-character tail would read as a message event if the dropped prefix were forgotten.
	const fake = "event: message_start";
	source.send(`: ${"x".repeat(5000)}${fake}${" ".repeat(4096 - fake.length)}`);
	source.send("\n");
	source.send(PING);
	await assert.rejects(reading, (error: Error) => error.message === stallMessage(TIMEOUT_MS));
});

test("an event after an overlong line still disarms the watchdog", async () => {
	const source = upstream();
	const reading = readAll(watchFirstEvent(source.response, TIMEOUT_MS));
	const long = `: ${"x".repeat(5000)}`;
	source.send(long);
	source.send(`${"y".repeat(10)}\n${START}`);
	await sleep(TIMEOUT_MS * 2);
	source.close();
	assert.equal(await reading, `${long}${"y".repeat(10)}\n${START}`);
});

test("an immediate message_start is never interrupted", async () => {
	const source = upstream();
	source.send(START + PING);
	source.close();
	assert.equal(await readAll(watchFirstEvent(source.response, TIMEOUT_MS)), START + PING);
});

test("an upstream error before the deadline surfaces unchanged and cancels the timer", async () => {
	const source = upstream();
	const abort = new DOMException("This operation was aborted", "AbortError");
	const controller = new AbortController();
	const reading = readAll(watchFirstEvent(source.response, TIMEOUT_MS, controller.signal));
	source.send(PING);
	controller.abort();
	source.fail(abort);
	await assert.rejects(reading, (error: unknown) => error === abort);
	await sleep(TIMEOUT_MS * 2);
});

test("cancelling the watched body cancels upstream without a later stall error", async () => {
	const source = upstream();
	const watched = watchFirstEvent(source.response, TIMEOUT_MS);
	const reader = watched.body!.getReader();
	source.send(PING);
	await reader.read();
	await reader.cancel("consumer done");
	assert.equal(source.state.cancelled, true);
	await sleep(TIMEOUT_MS * 2);
});

test("non-streaming and failed responses pass through as the same object", () => {
	const json = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	const failed = new Response("{}", { status: 529, headers: { "content-type": "text/event-stream" } });
	assert.equal(watchFirstEvent(json, TIMEOUT_MS), json);
	assert.equal(watchFirstEvent(failed, TIMEOUT_MS), failed);
});

test("only bearer-auth Messages requests to the configured hosts are watched", () => {
	assert.equal(subscriptionMessagesRequest(messagesUrl, oauth, ANTHROPIC_HOSTS), true);
	assert.equal(subscriptionMessagesRequest(new URL(messagesUrl), { headers: new Headers(oauth.headers) }, ANTHROPIC_HOSTS), true);
	assert.equal(subscriptionMessagesRequest(new Request(messagesUrl, { method: "POST", headers: oauth.headers }), undefined, ANTHROPIC_HOSTS), true);
	// Like fetch(), init.headers replaces a Request's headers instead of merging with them.
	assert.equal(subscriptionMessagesRequest(new Request(messagesUrl, { method: "POST", headers: { "x-api-key": "old" } }), oauth, ANTHROPIC_HOSTS), true);
	assert.equal(subscriptionMessagesRequest(new Request(messagesUrl, { method: "POST", headers: oauth.headers }), { headers: {} }, ANTHROPIC_HOSTS), false);
	assert.equal(subscriptionMessagesRequest(new Request(messagesUrl, { method: "POST", headers: oauth.headers }), { method: "POST" }, ANTHROPIC_HOSTS), true);
	assert.equal(subscriptionMessagesRequest(messagesUrl, { headers: [["Authorization", "Bearer synthetic"]] }, ANTHROPIC_HOSTS), true);
	// API keys, local proxies such as Meridian, and other endpoints keep Pi's own behavior.
	assert.equal(subscriptionMessagesRequest(messagesUrl, { headers: { "x-api-key": "synthetic" } }, ANTHROPIC_HOSTS), false);
	assert.equal(subscriptionMessagesRequest(messagesUrl, { headers: { ...oauth.headers, "x-api-key": "synthetic" } }, ANTHROPIC_HOSTS), false);
	assert.equal(subscriptionMessagesRequest("http://127.0.0.1:3456/v1/messages", oauth, ANTHROPIC_HOSTS), false);
	assert.equal(subscriptionMessagesRequest("https://api.anthropic.com/v1/messages/count_tokens", oauth, ANTHROPIC_HOSTS), false);
	assert.equal(subscriptionMessagesRequest("https://openrouter.ai/api/v1/messages", oauth, ANTHROPIC_HOSTS), false);
	assert.equal(subscriptionMessagesRequest("not a url", oauth, ANTHROPIC_HOSTS), false);
	assert.equal(subscriptionMessagesRequest("http://127.0.0.1:3456/v1/messages", oauth, new Set(["127.0.0.1:3456"])), true);
});

test("guardFirstEvent applies only to anthropic-messages with an enabled policy", () => {
	const make = () => upstream().response;
	const openai = make();
	assert.equal(guardFirstEvent("openai-completions", messagesUrl, oauth, openai, policy), openai);
	const disabled = make();
	assert.equal(guardFirstEvent("anthropic-messages", messagesUrl, oauth, disabled, undefined), disabled);
	const zero = make();
	assert.equal(guardFirstEvent("anthropic-messages", messagesUrl, oauth, zero, { ...policy, timeoutMs: 0 }), zero);
	const apiKey = make();
	assert.equal(guardFirstEvent("anthropic-messages", messagesUrl, { headers: { "x-api-key": "synthetic" } }, apiKey, policy), apiKey);
	const watched = make();
	const result = guardFirstEvent("anthropic-messages", messagesUrl, oauth, watched, policy);
	assert.notEqual(result, watched);
	void result.body!.cancel();
});

type Kind = "native" | "legacy";

// Mirrors ModelRegistry's native registration and defined-only legacy config merge.
function sharedProvider(kind: Kind) {
	const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-fixture" };
	const stream = (_model: unknown, _context: unknown, options: any) => options.fetch(messagesUrl, { ...oauth, signal: options.signal });
	const base = { id: "anthropic", name: "Fixture", auth: {}, getModels: () => [model], stream, streamSimple: stream };
	const state: { native: any; config: any } = kind === "native" ? { native: base, config: undefined } : { native: undefined, config: { api: model.api, streamSimple: stream } };
	const registry = {
		getProvider: () => state.native ?? { ...base, ...state.config },
		getError: () => undefined,
		getRegisteredNativeProvider: () => state.native,
		getRegisteredProviderConfig: () => state.config,
		registerProvider(providerOrId: any, config?: any) {
			if (typeof providerOrId !== "string") { state.native = providerOrId; state.config = undefined; return; }
			state.native = undefined;
			state.config = { ...state.config, ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) };
		},
		unregisterProvider() { state.native = undefined; state.config = undefined; },
	};
	const request = async () => {
		const upstreamResponse = upstream().response;
		const response: Response = await registry.getProvider().streamSimple(model, {}, { fetch: async () => upstreamResponse });
		void response.body?.cancel();
		return response !== upstreamResponse;
	};
	const original = () => kind === "native" ? state.native === base : state.config?.streamSimple === stream;
	return { ctx: { modelRegistry: registry, model } as never, request, original };
}

const ownerCases = ["native", "legacy"].flatMap((kind) => [true, false].flatMap((enabledFirst) => ["first", "second"].map((leaver) => ({ kind: kind as Kind, enabledFirst, leaver }))));
for (const { kind, enabledFirst, leaver } of ownerCases) test(`a shared ${kind} wrapper follows its live owners (${enabledFirst ? "enabled" : "disabled"} creator, ${leaver} owner leaves)`, async () => {
	const f = sharedProvider(kind);
	const guard = (value: FirstEventPolicy | undefined) => createQuotaTransportGuard({ onWarning: () => undefined, firstEvent: () => value });
	const first = guard(enabledFirst ? policy : undefined);
	const second = guard(enabledFirst ? undefined : policy);
	first.ensure(f.ctx);
	second.ensure(f.ctx);
	assert.equal(await f.request(), !enabledFirst, "the newest live owner's policy applies");
	const [leaving, staying, stayingEnabled] = leaver === "first" ? [first, second, !enabledFirst] : [second, first, enabledFirst];
	leaving.dispose();
	assert.equal(f.original(), false, "the remaining owner keeps the wrapper installed");
	assert.equal(await f.request(), stayingEnabled, "a departed owner's policy no longer applies");
	staying.dispose();
	assert.equal(f.original(), true, "the last owner restores the provider");
});

test("a throwing policy source leaves requests unwatched and warns", async () => {
	const f = sharedProvider("native");
	const warnings: string[] = [];
	const g = createQuotaTransportGuard({ onWarning: (code) => warnings.push(code), firstEvent: () => { throw new Error("synthetic"); } });
	g.ensure(f.ctx);
	assert.equal(await f.request(), false);
	assert.deepEqual(warnings, ["first-event-policy-failed"]);
	g.dispose();
});
