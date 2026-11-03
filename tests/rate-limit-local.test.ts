import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isPrivateHost, localTarget, LOCAL_MAX_DELAY_MS, PROBE_INTERVAL_MS, FALLBACK_RESEND_MS, modelsUrl, probeServer, waitUntilAnswering } from "../lib/rate-limit-recovery/local.ts";
import { MAX_FAILURES_AFTER_ANSWER, TransientBackoff, isConnectionReport, localWaitingMessage, outageText } from "../lib/rate-limit-recovery/transient.ts";
import { createChildRateLimitGuard } from "../lib/rate-limit-recovery/child.ts";
import { normalizeConfig } from "../lib/rate-limit-recovery/config.ts";
import { piAiRoot } from "./support/pi-runtime.mjs";

const aiDist = join(piAiRoot, "dist");
const { isRetryableAssistantError } = await import(pathToFileURL(join(aiDist, "utils/retry.js")).href);
const { isContextOverflow } = await import(pathToFileURL(join(aiDist, "utils/overflow.js")).href);

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PAID = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };
const model = (provider: string, baseUrl: string, cost: unknown = FREE): any => ({ provider, id: "m", baseUrl, cost });
const DOWN = "503 Service Unavailable";
const failed = (provider: string, errorMessage = "Connection error."): any => ({ role: "assistant", stopReason: "error", errorMessage, provider, model: "qwen3.8-flash-next", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

test("private, loopback, tailnet, link-local and single-label hosts are local; public hosts are not", () => {
	for (const host of ["localhost", "fw01", "redarch", "127.0.0.1", "127.8.9.10", "10.142.15.84", "172.16.0.1", "172.31.255.255", "192.168.107.1", "169.254.1.1", "100.64.0.1", "100.73.222.109", "100.127.255.255", "::1", "[::1]", "fd12:3456::1", "fe80::1", "kiln.local", "box.lan", "box.internal", "nas.home.arpa", "op01.tail1234.ts.net", "api.localhost"]) {
		assert.equal(isPrivateHost(host), true, host);
	}
	for (const host of ["localhost.evil.com", "localhost.", "::ffff:8.8.8.8", "[::ffff:8.8.8.8]", "8.8.8.8", "100.128.0.1", "100.63.255.255", "172.32.0.1", "192.169.0.1", "api.anthropic.com", "opencode.ai", "2001:4860::8888", ""]) {
		assert.equal(isPrivateHost(host), false, host);
	}
});

test("a provider is local only when the model is free and its server is not public", () => {
	assert.deepEqual(localTarget(model("fw01", "http://fw01:8080/v1"), []), { baseUrl: "http://fw01:8080/v1" });
	assert.ok(localTarget(model("redarch-lora", "http://redarch.local:8081/v1"), []));
	// Meridian listens on loopback but proxies a billed cloud model.
	assert.equal(localTarget(model("anthropic", "http://127.0.0.1:3456", PAID), []), undefined);
	// A free model on a public host is someone else's hardware.
	assert.equal(localTarget(model("opencode-go", "https://opencode.ai/zen/go/v1"), []), undefined);
	// No cost record or no address reads as not local.
	assert.equal(localTarget(model("fw01", "http://fw01:8080/v1", null), []), undefined);
	assert.equal(localTarget(model("fw01", "", FREE), []), undefined);
	assert.equal(localTarget(model("fw01", "not a url", FREE), []), undefined);
	assert.equal(localTarget(undefined, []), undefined);
	// The owner can name a provider that the rule misses.
	assert.deepEqual(localTarget(model("lab", "https://lab.example.com/v1", PAID), ["lab"]), { baseUrl: "https://lab.example.com/v1" });
});

test("the server counts as answering for any HTTP reply except 502, 503 and 504", async () => {
	const calls: Array<{ url: string; redirect?: string }> = [];
	const reply = (status: number) => (async (url: string, init?: RequestInit) => { calls.push({ url, redirect: init?.redirect }); return new Response(null, { status }); }) as typeof fetch;
	const signal = new AbortController().signal;
	for (const status of [200, 301, 401, 404, 500, 501]) assert.equal(await probeServer("http://fw01:8080/v1", signal, reply(status)), true, String(status));
	for (const status of [502, 503, 504]) assert.equal(await probeServer("http://fw01:8080/v1", signal, reply(status)), false, String(status));
	assert.equal(await probeServer("http://fw01:8080/v1", signal, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch), false);
	assert.ok(calls.every((c) => c.url === "http://fw01:8080/v1/models" && c.redirect === "manual"), "no redirect is followed");
	assert.equal(modelsUrl("http://fw01:8080/v1/"), "http://fw01:8080/v1/models");
	assert.equal(modelsUrl("http://user:secret@fw01:8080/v1?key=1#x"), "http://fw01:8080/v1/models", "no userinfo, query or fragment");
	assert.equal(modelsUrl("not a url"), undefined);
});

test("the wait loop checks every 10 s and ends when the server answers", async () => {
	const waits: number[] = [];
	let clock = 0;
	const answers = [false, false, true];
	const done = await waitUntilAnswering({
		delayMs: 5_000, signal: new AbortController().signal, tick: () => {}, now: () => clock,
		wait: async (ms) => { waits.push(ms); clock += ms; return true; },
		probe: async () => answers.shift() ?? true,
	});
	assert.equal(done, "answered");
	assert.deepEqual(waits, [5_000, PROBE_INTERVAL_MS, PROBE_INTERVAL_MS]);
});

test("the wait loop sends the request again after 10 min even when the check never answers", async () => {
	let clock = 0;
	let probes = 0;
	const done = await waitUntilAnswering({
		delayMs: 5_000, signal: new AbortController().signal, tick: () => {}, now: () => clock,
		wait: async (ms) => { clock += ms; return true; },
		probe: async () => { probes++; return false; },
	});
	assert.equal(done, "timer");
	assert.ok(clock >= FALLBACK_RESEND_MS && clock < FALLBACK_RESEND_MS + PROBE_INTERVAL_MS + 5_000, String(clock));
	assert.ok(probes >= 59, String(probes));
});

test("the wait loop stops at once when the wait is cancelled", async () => {
	const controller = new AbortController();
	let probes = 0;
	const done = await waitUntilAnswering({
		delayMs: 5_000, signal: controller.signal, tick: () => {}, now: () => 0,
		wait: async () => { controller.abort(); return false; },
		probe: async () => { probes++; return true; },
	});
	assert.equal(done, "cancelled");
	assert.equal(probes, 0);
});

function localBackoff(options: { probe?: () => Promise<boolean>; local?: boolean; providers?: string[] } = {}) {
	const waits: number[] = [];
	let clock = 1_000_000;
	const b = new TransientBackoff({
		budgetMs: () => 180_000, random: () => 0.5, now: () => clock,
		wait: async (ms) => { waits.push(ms); clock += ms; return true; },
		local: () => ({ enabled: options.local ?? true, providers: options.providers ?? [] }),
		probe: options.probe ?? (async () => false),
	});
	const registry = { find: (provider: string) => provider.startsWith("fw01") ? model(provider, `http://${provider}:8080/v1`) : model(provider, "https://api.anthropic.com", PAID) };
	const ctx = { signal: new AbortController().signal, modelRegistry: registry } as never;
	const turn = (entryId: string) => ({ message: { role: "assistant", stopReason: "error" }, toolResults: [], messageEntryId: entryId, entries: [] }) as never;
	return { b, waits, ctx, turn, advance: (ms: number) => { clock += ms; } };
}

test("a local provider is waited on with no time limit and no retry limit", async () => {
	const f = localBackoff();
	for (let i = 0; i < 40; i++) {
		const replaced = f.b.messageEnd(failed("fw01", DOWN), f.ctx);
		assert.ok(replaced, `failure ${i}`);
		assert.ok(isConnectionReport(replaced.errorMessage!));
		assert.doesNotMatch(replaced.errorMessage!, /persisted|retry limit|transientMaxWaitSeconds/, `failure ${i} must not give up`);
		const resumed = await f.b.turnEnd(f.turn(`e${i}`), f.ctx);
		assert.ok(resumed, `failure ${i} resumes`);
		assert.equal(f.b.consumeReady(), true);
	}
	assert.ok(Math.max(...f.waits) <= LOCAL_MAX_DELAY_MS, `longest wait ${Math.max(...f.waits)}`);
});

test("a cloud provider still stops at the budget", async () => {
	const f = localBackoff();
	let last = "";
	for (let i = 0; i < 12; i++) {
		last = f.b.messageEnd(failed("anthropic", DOWN), f.ctx)!.errorMessage!;
		if (/persisted/.test(last)) break;
		await f.b.turnEnd(f.turn(`e${i}`), f.ctx);
	}
	assert.match(last, /persisted after \d+ automatic retries/);
});

test("the local wait is off when the owner turns it off, and a named provider is local", async () => {
	const off = localBackoff({ local: false });
	let last = "";
	for (let i = 0; i < 12 && !/persisted/.test(last); i++) {
		last = off.b.messageEnd(failed("fw01", DOWN), off.ctx)!.errorMessage!;
		await off.b.turnEnd(off.turn(`e${i}`), off.ctx);
	}
	assert.match(last, /persisted/);
	const named = localBackoff({ providers: ["anthropic"] });
	for (let i = 0; i < 12; i++) {
		assert.doesNotMatch(named.b.messageEnd(failed("anthropic", DOWN), named.ctx)!.errorMessage!, /persisted/);
		await named.b.turnEnd(named.turn(`e${i}`), named.ctx);
	}
});

test("the local message says why it waits, how long it is down, and how to cancel; Pi does not retry it", async () => {
	const f = localBackoff();
	const first = f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!;
	await f.b.turnEnd(f.turn("e1"), f.ctx);
	const later = f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!;
	for (const text of [first, later]) {
		assert.match(text, /local hardware/);
		assert.match(text, /Esc/);
		const message = { ...failed("fw01", text) };
		assert.equal(isRetryableAssistantError(message), false, text);
		assert.equal(isContextOverflow(message, 100_000), false, text);
	}
	assert.match(later, /no answer for 10 min/);
});

test("the outage clock restarts after a good reply", async () => {
	const f = localBackoff();
	f.b.messageEnd(failed("fw01", DOWN), f.ctx);
	await f.b.turnEnd(f.turn("e1"), f.ctx);
	f.advance(3_600_000);
	f.b.messageEnd({ ...failed("fw01"), stopReason: "stop", errorMessage: undefined }, f.ctx);
	assert.doesNotMatch(f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!, /no answer for/);
});

test("the local settings are on by default and keep only provider names", () => {
	assert.equal(normalizeConfig({}).localRetry, true);
	assert.deepEqual(normalizeConfig({}).localProviders, []);
	assert.equal(normalizeConfig({ localRetry: false }).localRetry, false);
	assert.equal(normalizeConfig({ localRetry: "no" }).localRetry, true);
	assert.deepEqual(normalizeConfig({ localProviders: ["fw01", 3, "", " lab ", null] }).localProviders, ["fw01", "lab"]);
	assert.deepEqual(normalizeConfig({ localProviders: "fw01" }).localProviders, []);
});

test("no outage length makes the message look like a status code to Pi's retry", () => {
	for (let minutes = 0; minutes <= 60 * 24 * 40; minutes += minutes < 1500 ? 1 : 7) {
		const text = localWaitingMessage("fw01/qwen3.8-flash-next", "down", minutes * 60_000 + 30_000);
		assert.equal(isRetryableAssistantError(failed("fw01", text)), false, `${minutes} min: ${text}`);
	}
	assert.equal(outageText(502 * 60_000), "8 h 22 min");
	assert.equal(outageText(26 * 3_600_000), "1 d 2 h");
	assert.equal(outageText(59 * 60_000), "59 min");
});

test("a request that fails while the server answers goes back to the budget after 3 tries, until a good reply", async () => {
	const f = localBackoff({ probe: async () => true });
	const texts: string[] = [];
	for (let i = 0; i < 20; i++) {
		const text = f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!;
		texts.push(text);
		if (/persisted/.test(text)) break;
		await f.b.turnEnd(f.turn(`e${i}`), f.ctx);
	}
	assert.equal(texts.filter((t) => /local hardware/.test(t)).length, MAX_FAILURES_AFTER_ANSWER);
	assert.match(texts.at(-1)!, /persisted after \d+ automatic retries/);
	// A good reply ends the outage; the next failure is local again.
	f.b.messageEnd({ ...failed("fw01"), stopReason: "stop", errorMessage: undefined }, f.ctx);
	assert.match(f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!, /local hardware/);
});

test("resends after the 10 min timer do not count as failures while the server answers", async () => {
	const f = localBackoff({ probe: async () => false });
	for (let i = 0; i < 8; i++) {
		assert.match(f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!, /local hardware/, `failure ${i}`);
		await f.b.turnEnd(f.turn(`e${i}`), f.ctx);
	}
});

test("hours of local waiting leave a cloud provider's budget whole", async () => {
	const f = localBackoff();
	for (let i = 0; i < 35; i++) {
		f.b.messageEnd(failed("fw01", DOWN), f.ctx);
		await f.b.turnEnd(f.turn(`l${i}`), f.ctx);
	}
	const cloud = f.b.messageEnd(failed("anthropic", DOWN), f.ctx)!.errorMessage!;
	assert.match(cloud, /retry 1, at most 3 min/);
});

test("each local provider has its own outage clock", async () => {
	const f = localBackoff();
	f.b.messageEnd(failed("fw01", DOWN), f.ctx);
	await f.b.turnEnd(f.turn("e1"), f.ctx);
	f.advance(3_600_000);
	assert.doesNotMatch(f.b.messageEnd(failed("fw01b", DOWN), f.ctx)!.errorMessage!, /no answer for/);
});

test("Esc during a check ends the local wait with no resend", async () => {
	let started!: () => void;
	const probing = new Promise<void>((resolve) => { started = resolve; });
	const b = new TransientBackoff({
		budgetMs: () => 180_000, random: () => 0.5,
		wait: async () => true,
		local: () => ({ enabled: true, providers: [] }),
		probe: (_url, signal) => new Promise<boolean>((resolve) => { started(); signal.addEventListener("abort", () => resolve(false), { once: true }); }),
	});
	const ctx = { signal: new AbortController().signal, modelRegistry: { find: () => model("fw01", "http://fw01:8080/v1") } } as never;
	b.messageEnd(failed("fw01", DOWN), ctx);
	const result = b.turnEnd({ message: { role: "assistant", stopReason: "error" }, toolResults: [], messageEntryId: "e", entries: [] } as never, ctx);
	await probing;
	b.cancel();
	assert.equal(await result, undefined);
	assert.equal(b.consumeReady(), false);
});

function childFixture(config: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "local-retry-child-"));
	const file = join(dir, "pi-extras.json");
	writeFileSync(file, JSON.stringify(config));
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const guard = createChildRateLimitGuard({ configFile: file, transient: { wait: async () => true, probe: async () => false } });
	guard.extension.factory({ on: (name: string, handler: any) => handlers.set(name, handler), appendEntry() {} } as never);
	const provider = { id: "fw01", name: "fw01", stream() {}, streamSimple() {} };
	const modelRegistry = { getProvider: () => provider, getRegisteredNativeProvider: () => provider, getRegisteredProviderConfig: () => undefined, registerProvider() {}, unregisterProvider() {}, find: () => model("fw01", "http://fw01:8080/v1") };
	const controller = new AbortController();
	const ctx = { modelRegistry, model: { provider: "fw01", api: "openai-completions", id: "m" }, mode: "print", hasUI: false, signal: controller.signal, abort: () => controller.abort(), ui: { notify() {} } };
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	return { emit, close: () => { guard.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a subagent waits on a local server only when no fallback model is named", async () => {
	const alone = childFixture({});
	try { assert.match(alone.emit("message_end", { message: failed("fw01", DOWN) }).message.errorMessage, /local hardware/); }
	finally { alone.close(); }
	const withFallback = childFixture({ subagents: { fallbackModels: ["opencode-go/deepseek-v4.1-flash"] } });
	try { assert.match(withFallback.emit("message_end", { message: failed("fw01", DOWN) }).message.errorMessage, /at most 3 min/); }
	finally { withFallback.close(); }
});

test("a resend after the 10 min timer that fails breaks the row of failures while the server answers", async () => {
	// The check answers twice, then the server is off past the timer, then it answers twice again.
	const answers = [true, true, false, true, true];
	let current = true;
	const f = localBackoff({ probe: async () => current });
	for (let i = 0; i < answers.length + 1; i++) {
		assert.match(f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!, /local hardware/, `failure ${i}`);
		current = answers[i] ?? true;
		await f.b.turnEnd(f.turn(`e${i}`), f.ctx);
	}
});

test("a cloud failure ends a local outage", async () => {
	const f = localBackoff();
	f.b.messageEnd(failed("fw01", DOWN), f.ctx);
	await f.b.turnEnd(f.turn("e1"), f.ctx);
	f.advance(3_600_000);
	f.b.messageEnd(failed("anthropic", DOWN), f.ctx);
	assert.doesNotMatch(f.b.messageEnd(failed("fw01", DOWN), f.ctx)!.errorMessage!, /no answer for/);
});
