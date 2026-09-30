import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLimitStore, type LimitStore } from "../lib/limit-store.ts";
import type { LimitEntry } from "../lib/status-plus-logic.ts";
import { rowKind } from "../lib/tool-row.ts";
import usageGuard, { GUARD_CUSTOM_TYPE, loadGuardConfig, parseBudgetArgs, saveGuardConfig } from "../extensions/usage-guard.ts";

const NOW = 1_800_000_000_000;
const RESET = NOW + 3_600_000;

interface Sent { content: string; deliverAs?: string; triggerTurn?: boolean; details?: unknown }
interface FakePi {
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
	sent: Sent[];
	entries: Array<{ type: string; customType: string; data: unknown }>;
	tool?: { name: string; execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown }> };
	command?: { handler: (args: string, ctx: unknown) => Promise<void> };
}

function fakePi(): FakePi {
	const pi: FakePi = { handlers: new Map(), sent: [], entries: [] };
	Object.assign(pi, {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => pi.handlers.set(name, handler),
		sendMessage: (message: { content: string; details?: unknown }, options: { deliverAs?: string; triggerTurn?: boolean }) =>
			pi.sent.push({ content: message.content, deliverAs: options.deliverAs, triggerTurn: options.triggerTurn, details: message.details }),
		appendEntry: (customType: string, data: unknown) => pi.entries.push({ type: "custom", customType, data }),
		registerTool: (tool: FakePi["tool"]) => { pi.tool = tool; },
		registerCommand: (_name: string, command: FakePi["command"]) => { pi.command = command; },
	});
	return pi;
}

async function request(pi: FakePi, ctx: unknown, messages: unknown[] = []): Promise<any> {
	return await pi.handlers.get("context")!({ messages }, ctx);
}

function fakeCtx(pi: FakePi, model: { provider: string; id: string }, idle = true) {
	const notices: string[] = [];
	return {
		notices,
		model,
		isIdle: () => idle,
		sessionManager: { getEntries: () => pi.entries },
		ui: { notify: (text: string) => notices.push(text) },
	};
}

function anthropicSnapshot(store: LimitStore, sevenPct: number, fablePct = 10): void {
	const entries: LimitEntry[] = [
		{ label: "5h", key: "five_hour", usedPct: 5, resetMs: RESET, allowed: true },
		{ label: "7d", key: "seven_day", usedPct: sevenPct, resetMs: RESET + 86_400_000, allowed: true },
		{ label: "7d-fable", key: "seven_day_fable", modelFamily: "fable", usedPct: fablePct, resetMs: RESET + 86_400_000, allowed: true },
	];
	store.set("anthropic", { entries, atMs: NOW - 5_000, source: "poll" });
}

function setup(model = { provider: "anthropic", id: "claude-sonnet-5" }, idle = true, warnings = true) {
	const dir = mkdtempSync(join(tmpdir(), "usage-guard-"));
	const configFile = join(dir, "pi-extras.json");
	if (warnings) saveGuardConfig({ enabled: true }, configFile);
	const store = createLimitStore();
	const pi = fakePi();
	usageGuard(pi as never, { store, configFile, now: () => NOW });
	const ctx = fakeCtx(pi, model, idle);
	return { pi, store, ctx, configFile };
}

test("the usage tool is marked for Tool Display, which draws its rows with a layout of its own", () => {
	const { pi } = setup();
	assert.equal(rowKind(pi.tool), "usage");
	assert.equal(pi.tool!.name, "usage");
});

test("a crossing at turn end warns once, persists the key, and stays quiet afterwards", async () => {
	const { pi, store, ctx } = setup();
	await pi.handlers.get("session_start")!({}, ctx);
	assert.equal(pi.sent.length, 0);
	anthropicSnapshot(store, 91);
	// An idle crossing is evaluated for the model selected at the next request.
	assert.equal(pi.sent.length, 0);
	const projected = await request(pi, ctx);
	assert.equal(projected.messages.length, 1);
	assert.equal(pi.sent.length, 1);
	assert.equal(pi.sent[0].triggerTurn, false);
	assert.equal(pi.sent[0].deliverAs, undefined);
	assert.match(pi.sent[0].content, /^Usage notice: anthropic 7d is at 91%/);
	assert.deepEqual(pi.entries.map((entry) => entry.customType), [GUARD_CUSTOM_TYPE]);
	// Later turns in the same band: nothing.
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	await pi.handlers.get("turn_end")!({ toolResults: [] }, ctx);
	assert.equal(pi.sent.length, 1);
	// Next band lands mid tool loop: the next request, not turn end, delivers it.
	const busy = { ...ctx, isIdle: () => false };
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, busy);
	anthropicSnapshot(store, 96);
	assert.equal(pi.sent.length, 1);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, busy);
	assert.equal(pi.sent.length, 1);
	await request(pi, busy);
	assert.equal(pi.sent.length, 2);
	assert.equal(pi.sent[1].triggerTurn, false);
	assert.match(pi.sent[1].content, /^Usage warning: .*too far away to wait for/);
	assert.equal(store.isHot("anthropic"), false);
});

test("a resumed session restores fired keys and the budget instead of repeating them", async () => {
	const { pi, store, ctx } = setup();
	anthropicSnapshot(store, 91);
	await pi.handlers.get("session_start")!({}, ctx);
	await request(pi, ctx);
	assert.equal(pi.sent.length, 1);
	await pi.command!.handler("budget 7d 95", ctx);
	assert.match(ctx.notices.at(-1) ?? "", /Session budget: 7d at 95%/);
	// Same entries, fresh extension instance: nothing new to say.
	const again = fakePi();
	again.entries = pi.entries;
	usageGuard(again as never, { store, configFile: join(tmpdir(), "unused.json"), now: () => NOW });
	const resumed = fakeCtx(again, { provider: "anthropic", id: "claude-sonnet-5" });
	await again.handlers.get("session_start")!({}, resumed);
	await request(again, resumed);
	assert.deepEqual(again.sent, []);
	const result = await again.tool!.execute("t1", {}, undefined, undefined, resumed);
	const report = JSON.parse(result.content[0].text);
	assert.deepEqual(report.budget, { window: "7d", pct: 95 });
});

test("a session budget fires once at its own threshold and marks the provider hot nearby", async () => {
	const { pi, store, ctx } = setup();
	await pi.handlers.get("session_start")!({}, ctx);
	anthropicSnapshot(store, 52);
	await pi.tool!.execute("t1", { setBudget: { window: "7d", pct: 60 } }, undefined, undefined, ctx);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	assert.equal(pi.sent.length, 0);
	assert.equal(store.isHot("anthropic"), true);
	anthropicSnapshot(store, 61);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	await request(pi, ctx);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].content, /reached the session budget: 61% used, budget 60%/);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	assert.equal(pi.sent.length, 1);
	await pi.tool!.execute("t2", { clearBudget: true }, undefined, undefined, ctx);
	assert.deepEqual(pi.entries.at(-1)?.data, { budget: null });
});

test("the tool reports governing windows, refreshes on request and honours all", async () => {
	const { pi, store, ctx } = setup({ provider: "anthropic", id: "claude-fable-5-1" });
	const refreshed: string[] = [];
	store.setRefresher(async (provider) => { refreshed.push(provider); anthropicSnapshot(store, 31, 62); });
	await pi.handlers.get("session_start")!({}, ctx);
	const empty = JSON.parse((await pi.tool!.execute("t0", {}, undefined, undefined, ctx)).content[0].text);
	assert.match(empty.notes[0], /No usage data yet/);
	const result = await pi.tool!.execute("t1", { refresh: true }, undefined, undefined, ctx);
	assert.deepEqual(refreshed, ["anthropic"]);
	const report = JSON.parse(result.content[0].text);
	assert.deepEqual(report.limits.map((limit: { window: string }) => limit.window), ["5h", "7d", "7d-fable"]);
	assert.equal(report.limits[2].usedPct, 62);
	assert.equal(report.limits[2].reset.resumeAfterSeconds, 3600 + 86_400 + 180);
	assert.equal(report.warnings, "on");
	store.set("openai-codex", { entries: [{ label: "7d", key: "primary", usedPct: 100, allowed: true, resetMs: RESET }], atMs: NOW, source: "poll" });
	const everything = JSON.parse((await pi.tool!.execute("t2", { all: true }, undefined, undefined, ctx)).content[0].text);
	assert.equal(everything.limits.length, 4);
	assert.equal(everything.limits[3].status, "full-but-allowed");
});

test("/usage injects a snapshot and toggles warnings in the config file", async () => {
	const { pi, store, ctx, configFile } = setup();
	await pi.handlers.get("session_start")!({}, ctx);
	anthropicSnapshot(store, 31);
	await pi.command!.handler("", ctx);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].content, /^Current usage limits:/);
	assert.equal(pi.sent[0].deliverAs, "nextTurn");
	await pi.command!.handler("warnings off", ctx);
	assert.equal(JSON.parse(readFileSync(configFile, "utf8")).usageGuard.enabled, false);
	assert.equal(loadGuardConfig(configFile).enabled, false);
	anthropicSnapshot(store, 99);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	assert.equal(pi.sent.length, 1);
	await pi.command!.handler("warnings on", ctx);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	await request(pi, ctx);
	assert.equal(pi.sent.length, 2);
	await pi.command!.handler("bogus", ctx);
	assert.match(ctx.notices.at(-1) ?? "", /^Usage: \/usage/);
});

test("config helpers preserve unrelated keys and honour the env override", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-guard-"));
	const file = join(dir, "pi-extras.json");
	assert.equal(loadGuardConfig(file).enabled, false);
	saveGuardConfig({ bands: [80, 90] }, file);
	const written = JSON.parse(readFileSync(file, "utf8"));
	written.other = { keep: true };
	writeFileSync(file, JSON.stringify(written));
	saveGuardConfig({ enabled: false }, file);
	const reread = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(reread.other, { keep: true });
	assert.deepEqual(reread.usageGuard, { enabled: false, bands: [80, 90], resumeMarginSeconds: 180, proximityPct: 10, maxWaitSeconds: 18_000 });
	assert.equal(loadGuardConfig(file, { PI_EXTRAS_USAGE_GUARD: "0" }).enabled, false);
	assert.equal(loadGuardConfig(file, { PI_EXTRAS_USAGE_GUARD: "1" }).enabled, true);
	saveGuardConfig({ enabled: true }, file);
	assert.equal(loadGuardConfig(file, { PI_EXTRAS_USAGE_GUARD: "0" }).enabled, false);
	assert.equal(loadGuardConfig(file, {}).enabled, true);
});

test("with the default config, bands stay silent but a session budget still warns once", async () => {
	const { pi, store, ctx } = setup(undefined, true, false);
	await pi.handlers.get("session_start")!({}, ctx);
	anthropicSnapshot(store, 96);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	assert.equal(pi.sent.length, 0);
	assert.equal(store.isHot("anthropic"), false);
	const result = await pi.tool!.execute("t1", { setBudget: { window: "7d", pct: 60 } }, undefined, undefined, ctx);
	const report = JSON.parse(result.content[0].text);
	assert.equal(report.warnings, "off");
	assert.equal(report.limits[1].budgetPct, 60);
	assert.deepEqual(report.limits[0].thresholds, []);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	await request(pi, ctx);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].content, /reached the session budget: 96% used, budget 60%/);
	assert.doesNotMatch(pi.sent[0].content, /sleep/);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	assert.equal(pi.sent.length, 1);
});

test("a limit climbing to a block over many polls with drifting resets sends two messages, and none after a reload", async () => {
	const { pi, store, ctx, configFile } = setup();
	await pi.handlers.get("session_start")!({}, ctx);
	const poll = (i: number, pct: number) => store.set("anthropic", {
		// Proxies recompute the reset on every fetch, so it drifts by a few hundred ms.
		entries: [{ label: "5h", key: "five_hour", usedPct: pct, resetMs: RESET + ((i * 397) % 1000), allowed: pct < 100, exhausted: pct >= 100 }],
		atMs: NOW, source: "poll",
	});
	for (let i = 0; i < 70; i++) {
		poll(i, Math.min(100, 90 + Math.floor(i / 5)));
		if (i % 3 === 0) await request(pi, ctx);
	}
	assert.deepEqual(pi.sent.map((sent) => sent.content.split(":")[0]), ["Usage notice", "Usage warning"]);
	assert.match(pi.sent[1].content, /5h is at 95%/);
	// A reload restores the fired keys from the session, whatever the drift.
	const reloaded = fakePi();
	reloaded.entries = pi.entries;
	usageGuard(reloaded as never, { store, configFile, now: () => NOW });
	const reloadedCtx = fakeCtx(reloaded, { provider: "anthropic", id: "claude-sonnet-5" });
	await reloaded.handlers.get("session_start")!({}, reloadedCtx);
	for (let i = 70; i < 90; i++) {
		poll(i, 100);
		await request(reloaded, reloadedCtx);
	}
	assert.deepEqual(reloaded.sent, []);
});

test("idle notices are checked at the next prompt, after switching from Claude to Codex", async () => {
	const { pi, store, ctx } = setup();
	await pi.handlers.get("session_start")!({}, ctx);
	anthropicSnapshot(store, 96);
	assert.equal(pi.sent.length, 0, "polling must not freeze a Claude warning into Pi's nextTurn queue");
	assert.equal(pi.entries.length, 0, "an undelivered warning must not count as fired");

	const codex = fakeCtx(pi, { provider: "openai-codex", id: "gpt-6.1-sol" });
	await pi.handlers.get("model_select")!({ model: codex.model, previousModel: ctx.model }, codex);
	store.set("openai-codex", { entries: [{ label: "7d", key: "primary", usedPct: 21, resetMs: RESET }], atMs: NOW, source: "poll" });
	await request(pi, codex);
	assert.equal(pi.sent.length, 0);
	assert.equal(store.isHot("anthropic"), false);
	const report = JSON.parse((await pi.tool!.execute("t1", {}, undefined, undefined, codex)).content[0].text);
	assert.deepEqual(report.limits.map((limit: any) => limit.provider), ["openai-codex"]);
	assert.equal(report.limits[0].usedPct, 21);

	// Returning to Claude can still warn: no false fired key was persisted while idle.
	await pi.handlers.get("model_select")!({ model: ctx.model, previousModel: codex.model }, ctx);
	await request(pi, ctx);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].content, /anthropic 7d is at 96%/);
});

test("a notice at the last turn waits for a fresh prompt and current model", async () => {
	const { pi, store, ctx } = setup(undefined, false);
	await pi.handlers.get("session_start")!({}, ctx);
	anthropicSnapshot(store, 96);
	await pi.handlers.get("turn_end")!({ toolResults: [] }, ctx);
	assert.deepEqual(pi.sent, []);
	const codex = fakeCtx(pi, { provider: "openai-codex", id: "gpt-6.1-sol" });
	await request(pi, codex);
	assert.deepEqual(pi.sent, []);
});

test("context omits obsolete automatic warnings but keeps explicit usage snapshots", async () => {
	const { pi, ctx } = setup();
	await pi.handlers.get("session_start")!({}, ctx);
	const claude = { role: "custom", customType: GUARD_CUSTOM_TYPE, content: "old warning", details: {
		key: `anthropic|five_hour|95|${RESET}`, reason: "band",
	} };
	const fable = { ...claude, details: { ...claude.details, key: `anthropic|seven_day_fable|95|${RESET}` } };
	const codex = { ...claude, details: { ...claude.details, key: `openai-codex|primary|95|${RESET}` } };
	const snapshot = { role: "custom", customType: GUARD_CUSTOM_TYPE, content: "Current usage limits:", details: {} };
	const unrelated = { role: "custom", customType: "other", content: "keep" };
	const messages = [claude, fable, codex, snapshot, unrelated];
	const filter = pi.handlers.get("context")!;
	assert.ok(filter, "a request boundary must recheck historical and already queued warnings");
	const forCodex: any = await filter({ messages }, fakeCtx(pi, { provider: "openai-codex", id: "gpt-6.1-sol" }));
	assert.deepEqual(forCodex.messages, [codex, snapshot, unrelated]);
	const forSonnet: any = await filter({ messages }, ctx);
	assert.deepEqual(forSonnet.messages, [claude, snapshot, unrelated]);
	assert.deepEqual(messages, [claude, fable, codex, snapshot, unrelated], "raw history is unchanged");
});

test("budget arguments parse strictly", () => {
	assert.deepEqual(parseBudgetArgs(["7d", "60"]), { window: "7d", pct: 60 });
	assert.equal(parseBudgetArgs(["clear"]), null);
	assert.equal(parseBudgetArgs(["7d"]), undefined);
	assert.equal(parseBudgetArgs(["7d", "0"]), undefined);
	assert.equal(parseBudgetArgs(["7d", "101"]), undefined);
	assert.equal(parseBudgetArgs(["7d", "sixty"]), undefined);
});
