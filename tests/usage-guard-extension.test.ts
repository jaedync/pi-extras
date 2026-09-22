import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLimitStore, type LimitStore } from "../lib/limit-store.ts";
import type { LimitEntry } from "../lib/status-plus-logic.ts";
import usageGuard, { GUARD_CUSTOM_TYPE, loadGuardConfig, parseBudgetArgs, saveGuardConfig } from "../extensions/usage-guard.ts";

const NOW = 1_800_000_000_000;
const RESET = NOW + 3_600_000;

interface Sent { content: string; deliverAs: string; details?: unknown }
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
		sendMessage: (message: { content: string; details?: unknown }, options: { deliverAs: string }) =>
			pi.sent.push({ content: message.content, deliverAs: options.deliverAs, details: message.details }),
		appendEntry: (customType: string, data: unknown) => pi.entries.push({ type: "custom", customType, data }),
		registerTool: (tool: FakePi["tool"]) => { pi.tool = tool; },
		registerCommand: (_name: string, command: FakePi["command"]) => { pi.command = command; },
	});
	return pi;
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

test("a crossing at turn end warns once, persists the key, and stays quiet afterwards", async () => {
	const { pi, store, ctx } = setup();
	await pi.handlers.get("session_start")!({}, ctx);
	assert.deepEqual(pi.sent, []);
	anthropicSnapshot(store, 91);
	// A poll landing while idle announces for the next prompt.
	assert.equal(pi.sent.length, 1);
	assert.equal(pi.sent[0].deliverAs, "nextTurn");
	assert.match(pi.sent[0].content, /^Usage notice: anthropic 7d is at 91%/);
	assert.deepEqual(pi.entries.map((entry) => entry.customType), [GUARD_CUSTOM_TYPE]);
	// Later turns in the same band: nothing.
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	await pi.handlers.get("turn_end")!({ toolResults: [] }, ctx);
	assert.equal(pi.sent.length, 1);
	// Next band lands mid tool loop: the subscription stays quiet while busy and turn end steers.
	const busy = { ...ctx, isIdle: () => false };
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, busy);
	anthropicSnapshot(store, 96);
	assert.equal(pi.sent.length, 1);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, busy);
	assert.equal(pi.sent.length, 2);
	assert.equal(pi.sent[1].deliverAs, "steer");
	assert.match(pi.sent[1].content, /^Usage warning: .*Wrap up at a good stopping point/);
	assert.equal(store.isHot("anthropic"), false);
});

test("a resumed session restores fired keys and the budget instead of repeating them", async () => {
	const { pi, store, ctx } = setup();
	anthropicSnapshot(store, 91);
	await pi.handlers.get("session_start")!({}, ctx);
	assert.equal(pi.sent.length, 1);
	await pi.command!.handler("budget 7d 95", ctx);
	assert.match(ctx.notices.at(-1) ?? "", /Session budget: 7d at 95%/);
	// Same entries, fresh extension instance: nothing new to say.
	const again = fakePi();
	again.entries = pi.entries;
	usageGuard(again as never, { store, configFile: join(tmpdir(), "unused.json"), now: () => NOW });
	const resumed = fakeCtx(again, { provider: "anthropic", id: "claude-sonnet-5" });
	await again.handlers.get("session_start")!({}, resumed);
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
	assert.equal(report.limits[2].reset.resumeAfterSeconds, 3600 + 86_400 + 300);
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
	assert.deepEqual(reread.usageGuard, { enabled: false, bands: [80, 90], resumeMarginSeconds: 300, proximityPct: 10 });
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
	assert.deepEqual(pi.sent, []);
	assert.equal(store.isHot("anthropic"), false);
	const result = await pi.tool!.execute("t1", { setBudget: { window: "7d", pct: 60 } }, undefined, undefined, ctx);
	const report = JSON.parse(result.content[0].text);
	assert.equal(report.warnings, "off");
	assert.equal(report.limits[1].budgetPct, 60);
	assert.deepEqual(report.limits[0].thresholds, []);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].content, /reached the session budget: 96% used, budget 60%/);
	assert.doesNotMatch(pi.sent[0].content, /sleep/);
	await pi.handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
	assert.equal(pi.sent.length, 1);
});

test("budget arguments parse strictly", () => {
	assert.deepEqual(parseBudgetArgs(["7d", "60"]), { window: "7d", pct: 60 });
	assert.equal(parseBudgetArgs(["clear"]), null);
	assert.equal(parseBudgetArgs(["7d"]), undefined);
	assert.equal(parseBudgetArgs(["7d", "0"]), undefined);
	assert.equal(parseBudgetArgs(["7d", "101"]), undefined);
	assert.equal(parseBudgetArgs(["7d", "sixty"]), undefined);
});
