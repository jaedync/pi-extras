import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recovery from "../extensions/rate-limit-recovery.ts";

const NOW = Date.parse("2026-09-30T02:00:00Z");
const limitMessage = (seconds: unknown = 10) => ({ role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "claude-opus", timestamp: NOW, content: [], stopReason: "error", errorMessage: JSON.stringify({ error: { type: "rate_limit_error", retry_after: seconds } }) });

type Handler = (event: any, ctx: any) => any;
function fixture(config: Record<string, unknown> = { autoWait: true }, mode = "tui", waiting = false) {
	const dir = mkdtempSync(join(tmpdir(), "rate-limit-test-"));
	const file = join(dir, "pi-extras.json");
	writeFileSync(file, JSON.stringify({ rateLimitRecovery: config, keep: { value: true } }));
	const handlers = new Map<string, Handler>();
	const entries: any[] = [];
	const notices: string[] = [];
	const widgets: unknown[] = [];
	let terminal: ((data: string) => unknown) | undefined;
	let unsubscribed = 0;
	let terminalFault = false;
	let appendFault = false;
	let now = NOW;
	let selected = { provider: "anthropic", api: "anthropic-messages", id: "claude-opus" };
	const controller = new AbortController();
	const provider = (id: string) => ({ id, name: id, stream() {}, streamSimple() {} });
	const providers = new Map(["anthropic", "openai"].map((id) => [id, provider(id)]));
	let registryFault = false;
	let legacy: { api?: string; streamSimple?: (...args: unknown[]) => unknown } | undefined;
	const getProvider = (id: string) => { if (registryFault) throw new Error("synthetic registry failure"); return providers.get(id); };
	const modelRegistry = {
		getProvider, getRegisteredNativeProvider: (id: string) => legacy ? undefined : getProvider(id),
		getRegisteredProviderConfig: () => legacy,
		registerProvider(value: ReturnType<typeof provider> | string, config?: typeof legacy) {
			if (typeof value === "string") legacy = { ...legacy, ...config };
			else { legacy = undefined; providers.set(value.id, value); }
		},
		unregisterProvider(id: string) { legacy = undefined; providers.delete(id); },
	};
	let release: ((finished: boolean) => void) | undefined;
	let command: Handler | undefined;
	let waited = 0;
	let waitStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => { waitStarted = resolve; });
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		appendEntry(type: string, data: unknown) { if (appendFault) throw new Error("synthetic append failure"); entries.push({ type, data }); },
		registerCommand(_name: string, options: { handler: Handler }) { command = options.handler; },
	};
	const ctx = {
		mode, hasUI: mode === "tui", signal: controller.signal, modelRegistry,
		get model() { return selected; },
		abort() { controller.abort(); },
		ui: {
			notify(text: string) { notices.push(text); },
			setWidget(_key: string, widget: unknown) { widgets.push(widget); },
			onTerminalInput(callback: (data: string) => unknown) {
				if (terminalFault) throw new Error("synthetic UI setup failure");
				terminal = callback;
				return () => { terminal = undefined; unsubscribed++; };
			},
		},
	};
	recovery(pi as never, {
		configFile: file, env: {}, now: () => now,
		wait: async (ms: number, signal: AbortSignal) => {
			waited++;
			waitStarted!();
			if (!waiting) { now += ms + 234; return true; }
			return new Promise<boolean>((resolve) => {
				release = (finished) => { now += finished ? ms : 50; resolve(finished); };
				signal.addEventListener("abort", () => resolve(false), { once: true });
			});
		},
	});
	const emit = (name: string, event: any = {}) => Promise.resolve(handlers.get(name)?.(event, ctx));
	return {
		ctx, emit, entries, notices, started, file, modelRegistry,
		get waited() { return waited; }, get unsubscribed() { return unsubscribed; },
		key(data: string) { return terminal?.(data); },
		finish() { release!(true); },
		rollBackClock(ms: number) { now -= ms; },
		failRegistrySetup() { registryFault = true; },
		setLegacy(config: NonNullable<typeof legacy>) { legacy = config; },
		failTerminalSetup() { terminalFault = true; },
		failAppendSetup() { appendFault = true; },
		select(model: typeof selected) { selected = model; return emit("model_select", { model }); },
		command(args: string) { return command!(args, ctx); },
		async detect(seconds: unknown = 10) { return emit("message_end", { message: limitMessage(seconds) }); },
		turn(entries: unknown[] = []) { return emit("turn_end", { message: limitMessage(), messageEntryId: "failure", entries, context: { canContinue: true } }); },
		close() { handlers.get("session_shutdown")?.({}, ctx); rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 10 }); },
	};
}

test("public provider guards are deduplicated, refreshed and restored at session shutdown", async () => {
	const f = fixture();
	const original = f.modelRegistry.getProvider("anthropic")!;
	const other = f.modelRegistry.getProvider("openai")!;
	try {
		await f.emit("session_start");
		const wrapped = f.modelRegistry.getProvider("anthropic")!;
		assert.notEqual(wrapped.streamSimple, original.streamSimple);
		await f.emit("before_agent_start");
		await f.emit("context");
		assert.equal(f.modelRegistry.getProvider("anthropic")!.streamSimple, wrapped.streamSimple);
		await f.select({ provider: "openai", api: "openai-responses", id: "synthetic-model" });
		assert.notEqual(f.modelRegistry.getProvider("openai")!.streamSimple, other.streamSimple);
		await f.emit("session_shutdown");
		assert.equal(f.modelRegistry.getProvider("anthropic")!.streamSimple, original.streamSimple);
		assert.equal(f.modelRegistry.getProvider("openai")!.streamSimple, other.streamSimple);
	} finally { f.close(); }
});

test("a later provider registration is protected at the next context and not lost on reload", async () => {
	const f = fixture();
	try {
		await f.emit("session_start");
		const replacement = { id: "anthropic", name: "replacement", stream() {}, streamSimple() {} };
		f.modelRegistry.registerProvider(replacement);
		await f.emit("context");
		assert.notEqual(f.modelRegistry.getProvider("anthropic")!.streamSimple, replacement.streamSimple);
		await f.emit("session_shutdown");
		assert.equal(f.modelRegistry.getProvider("anthropic")!.streamSimple, replacement.streamSimple);
		await f.emit("session_start");
		assert.notEqual(f.modelRegistry.getProvider("anthropic")!.streamSimple, replacement.streamSimple);
	} finally { f.close(); }
});

test("late callbacks after shutdown cannot reinstall guards or begin a stale recovery", async () => {
	const f = fixture();
	const original = f.modelRegistry.getProvider("anthropic")!;
	try {
		await f.emit("session_start");
		await f.emit("session_shutdown");
		await f.emit("before_agent_start");
		await f.emit("context");
		assert.equal(f.modelRegistry.getProvider("anthropic")!.streamSimple, original.streamSimple);
		assert.equal(await f.detect(), undefined);
		assert.equal(await f.turn(), undefined);
		assert.equal(f.waited, 0);
		await f.emit("session_start");
		assert.notEqual(f.modelRegistry.getProvider("anthropic")!.streamSimple, original.streamSimple);
	} finally { f.close(); }
});

test("unsupported legacy API switches show one honest nonblocking warning", async () => {
	const f = fixture();
	try {
		f.setLegacy({ api: "anthropic-messages", streamSimple() {} });
		await f.emit("session_start");
		await f.select({ provider: "anthropic", api: "openai-responses", id: "custom-model" });
		await f.emit("context");
		await f.emit("before_agent_start");
		assert.equal(f.ctx.signal.aborted, false);
		assert.equal(f.notices.filter((text) => /hidden-retry protection is unavailable for this provider and API\. Routing and retries are unchanged/i.test(text)).length, 1);
		assert.equal(f.modelRegistry.getRegisteredProviderConfig()!.api, "anthropic-messages");
	} finally { f.close(); }
});

test("transport disposal failure cannot skip main-session reload or shutdown cleanup", async () => {
	const f = fixture();
	try {
		await f.emit("session_start");
		f.failRegistrySetup();
		await assert.doesNotReject(f.emit("session_shutdown"));
		writeFileSync(f.file, JSON.stringify({ rateLimitRecovery: { autoWait: false } }));
		await assert.doesNotReject(f.emit("session_start"));
		await f.command("status");
		assert.match(f.notices.join("\n"), /quota waiting off/i);
	} finally { f.close(); }
});

test("transport protection setup failure aborts with guidance and never schedules recovery", async () => {
	const f = fixture();
	try {
		f.failRegistrySetup();
		await f.emit("before_agent_start");
		assert.equal(f.ctx.signal.aborted, true);
		assert.match(f.notices.join("\n"), /quota retry protection.*reload/i);
		assert.equal(f.waited, 0);
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
	} finally { f.close(); }
});

test("detection defaults to fail-fast without any wait or continuation", async () => {
	const f = fixture({});
	try {
		const replacement = await f.detect();
		assert.equal(replacement.message.stopReason, "error");
		assert.match(replacement.message.errorMessage, /expected reset/i);
		assert.match(replacement.message.errorMessage, /waiting is off/i);
		assert.equal(await f.turn(), undefined);
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
		assert.equal(f.waited, 0);
	} finally { f.close(); }
});

test("a completed wait commits canonical resume context and consumes one continuation", async () => {
	const f = fixture();
	try {
		await f.detect();
		const prior = { type: "custom", customType: "other", data: {} };
		const result = await f.turn([prior]);
		assert.equal(result.entries[0], prior);
		assert.deepEqual(result.entries[1], { type: "context_edit", targetId: "failure", replacement: null });
		const note = result.entries[2];
		assert.equal(note.type, "custom_message");
		assert.match(note.content, /20.234 seconds/);
		assert.match(note.content, /Paused at: 2026-09-30T02:00:00.000Z/);
		assert.match(note.content, /Resumed at: 2026-09-30T02:00:20.234Z/);
		assert.equal(f.waited, 1);
		assert.deepEqual(await f.emit("agent_before_settle", { context: { canContinue: true } }), { continue: true });
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
		assert.equal(f.unsubscribed, 1);
	} finally { f.close(); }
});

test("a queued continuation taking over consumes ready without requesting another", async () => {
	const f = fixture();
	try {
		await f.detect(); await f.turn();
		await f.emit("context", { messages: [] });
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
	} finally { f.close(); }
});

for (const key of ["\x1b", "\x03"]) test(`normal ${JSON.stringify(key)} cancels without resume injection`, async () => {
	const f = fixture({ autoWait: true }, "tui", true);
	try {
		await f.detect(); const turn = f.turn(); await f.started;
		f.key(key);
		assert.equal(await turn, undefined);
		assert.equal(f.ctx.signal.aborted, true);
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
		assert.equal(f.unsubscribed, 1);
	} finally { f.close(); }
});

test("Kitty key release is ignored and an Anthropic model switch retains the wait", async () => {
	const f = fixture({ autoWait: true }, "tui", true);
	try {
		await f.detect(); const turn = f.turn(); await f.started;
		f.key("\x1b[99;5:3u");
		assert.equal(f.ctx.signal.aborted, false);
		await f.select({ provider: "meridian", api: "anthropic-messages", id: "sonnet-alias" });
		assert.equal(f.ctx.signal.aborted, false);
		f.finish();
		assert.match((await turn).entries[1].content, /meridian\/sonnet-alias/);
	} finally { f.close(); }
});

test("switching out of provider scope aborts without a stale resume", async () => {
	const f = fixture({ autoWait: true }, "tui", true);
	try {
		await f.detect(); const turn = f.turn(); await f.started;
		await f.select({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6" });
		assert.equal(await turn, undefined);
		assert.equal(f.ctx.signal.aborted, true);
	} finally { f.close(); }
});

for (const mode of ["print", "json", "rpc"]) test(`${mode} sessions never auto-wait even with global opt-in`, async () => {
	const f = fixture({ autoWait: true }, mode);
	try {
		const result = await f.detect();
		assert.match(result.message.errorMessage, /never.*wait/i);
		assert.equal(f.ctx.signal.aborted, true);
		assert.equal(await f.turn(), undefined);
		assert.equal(f.waited, 0);
	} finally { f.close(); }
});

test("limits cannot produce an unbounded retry loop or excessive aggregate wait", async () => {
	const f = fixture({ autoWait: true, maxRecoveries: 1 });
	try {
		await f.detect(); await f.turn(); await f.emit("agent_before_settle", { context: { canContinue: true } });
		const result = await f.detect();
		assert.match(result.message.errorMessage, /recovery limit/i);
		assert.equal(await f.turn(), undefined);
		assert.equal(f.waited, 1);
		await f.emit("before_agent_start");
		await f.detect(); await f.turn();
		assert.equal(f.waited, 2);
	} finally { f.close(); }
});

for (const boundary of ["session_start", "session_shutdown"]) test(`${boundary} cancels an active wait without stale continuation`, async () => {
	const f = fixture({ autoWait: true }, "tui", true);
	try {
		await f.detect(); const waiting = f.turn(); await f.started;
		await f.emit(boundary);
		assert.equal(await waiting, undefined);
		assert.equal(f.ctx.signal.aborted, true);
		assert.equal(f.unsubscribed, 1);
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
		assert.equal(f.entries.length, 1, "only the pause marker remains");
	} finally { f.close(); }
});

test("append-entry setup failure cannot retain active state or schedule retry", async () => {
	const f = fixture();
	try {
		f.failAppendSetup(); await f.detect();
		assert.equal(await f.turn(), undefined);
		assert.equal(f.ctx.signal.aborted, true);
		assert.equal(f.waited, 0);
		assert.equal(f.entries.length, 0);
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
		await f.command("status");
		assert.doesNotMatch(f.notices.at(-1)!, /currently hibernating/i);
	} finally { f.close(); }
});

test("clock rollback cannot buy a second five-hour wait", async () => {
	const f = fixture({ autoWait: true }, "tui", true);
	try {
		await f.detect(17_990); const waiting = f.turn(); await f.started;
		f.rollBackClock(36_000_000); f.finish();
		const resumed = await waiting;
		assert.match(resumed.entries.at(-1).content, /at least 18000.000 seconds/);
		assert.match(resumed.entries.at(-1).content, /clock.*changed/i);
		assert.equal(resumed.entries.at(-1).details.elapsedIsLowerBound, true);
		await f.emit("agent_before_settle", { context: { canContinue: true } });
		assert.match((await f.detect(17_990)).message.errorMessage, /aggregate.*budget/i);
		assert.equal(await f.turn(), undefined);
		assert.equal(f.waited, 1);
	} finally { f.close(); }
});

test("overslept elapsed time counts against the aggregate wait budget", async () => {
	const f = fixture({ autoWait: true, maxWaitSeconds: 20 });
	try {
		await f.detect(); await f.turn();
		await f.emit("agent_before_settle", { context: { canContinue: true } });
		assert.match((await f.detect()).message.errorMessage, /aggregate.*budget/i);
		assert.equal(await f.turn(), undefined);
		assert.equal(f.waited, 1);
	} finally { f.close(); }
});

test("UI setup failure aborts without a stale active wait or continuation", async () => {
	const f = fixture();
	try {
		await f.detect(); f.failTerminalSetup();
		assert.equal(await f.turn(), undefined);
		assert.equal(f.ctx.signal.aborted, true);
		assert.equal(f.waited, 0);
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
		assert.match(f.notices.at(-1) ?? "", /failed.*cancelled/i);
	} finally { f.close(); }
});

test("cancellation winning the deadline race never injects a resumed notice", async () => {
	const f = fixture({ autoWait: true }, "tui", true);
	try {
		await f.detect(); const turn = f.turn(); await f.started;
		f.finish(); f.key("\x03");
		assert.equal(await turn, undefined);
		assert.equal(await f.emit("agent_before_settle", { context: { canContinue: true } }), undefined);
	} finally { f.close(); }
});

test("shutdown clears an active wait and commands preserve unrelated config", async () => {
	const f = fixture({ autoWait: true }, "tui", true);
	try {
		await f.command("off");
		assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")).keep, { value: true });
		await f.command("on");
		await f.detect(); const turn = f.turn(); await f.started;
		await f.emit("session_shutdown");
		assert.equal(await turn, undefined);
		assert.equal(f.ctx.signal.aborted, true);
		assert.equal(f.unsubscribed, 1);
	} finally { f.close(); }
});
