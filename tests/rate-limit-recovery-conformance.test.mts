/**
 * Conformance of the rate-limit recovery controller with its Quint model
 * (formal/rate-limit-recovery/recovery.qnt). Each trace that the model made
 * (`fv.mjs traces`) is replayed step by step against the real Recovery class
 * (lib/rate-limit-recovery/controller.ts) with its real TransientBackoff and
 * LocalIdleWait. After each step the code's state must equal the model's:
 * pending, ready, attempts, spentMs, the active hibernation, the transient
 * pending, ready, wait and streak, the idle wait and its session entry, and
 * the fake Pi's phase, queue and abort flag (the code moves them through
 * ctx.abort() and pi.sendMessage()).
 *
 * Pi is a fake that follows the model's Pi rules: a message while a run is
 * active steers into it, a run continues on queued messages with no
 * agent_before_settle, an abort ends the run, and the TUI's ctx.abort() and
 * Esc clear the queue. The replay does not check those rules against Pi:
 * formal/rate-limit-recovery/repro-*.mts and README.md do that.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { Recovery, RECOVERY_TYPE } from "../lib/rate-limit-recovery/controller.ts";
import { LOCAL_RESUME_TYPE } from "../lib/rate-limit-recovery/idle-wait.ts";

const TRACES = new URL("../formal/rate-limit-recovery/traces.itf.jsonl.gz", import.meta.url);
const NOW = Date.parse("2026-11-09T02:00:00Z");
// One quota wait: retry_after 60 s and no margin. The budget holds two (BUDGET = 2).
const QUOTA_SECONDS = 60;
const UNIT_MS = QUOTA_SECONDS * 1000;

type Itf = { states: Array<Record<string, any>> };

/** ITF values to plain ones: {#bigint}, {#set}, {#map}, {#tup}. */
function plain(value: any): any {
	if (Array.isArray(value)) return value.map(plain);
	if (value === null || typeof value !== "object") return value;
	if ("#bigint" in value) return Number(value["#bigint"]);
	if ("#set" in value) return value["#set"].map(plain);
	if ("#tup" in value) return value["#tup"].map(plain);
	if ("#map" in value) return Object.fromEntries(value["#map"].map(([k, v]: [any, any]) => [plain(k), plain(v)]));
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
}

function picked(state: Record<string, any>, name: string): any {
	const pick = state["mbt::nondetPicks"]?.[name];
	return pick?.tag === "Some" ? plain(pick.value) : undefined;
}

function loadTraces(): Itf[] {
	return gunzipSync(readFileSync(TRACES)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

const MODELS: Record<string, { provider: string; api: string; id: string }> = {
	a1: { provider: "anthropic", api: "anthropic-messages", id: "claude-opus" },
	a2: { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet" },
	oa: { provider: "openai", api: "openai-responses", id: "gpt-x" },
	loc: { provider: "fw01", api: "openai-completions", id: "qwen3.8-flash-next" },
};

/** One reply for each error kind of the model. The classification code is not the target. */
function reply(kind: string): any {
	const base = { role: "assistant", content: [], usage: {}, timestamp: NOW };
	switch (kind) {
		case "ok": return { ...base, provider: "anthropic", api: "anthropic-messages", model: "claude-opus", stopReason: "stop" };
		case "aborted": return { ...base, provider: "anthropic", api: "anthropic-messages", model: "claude-opus", stopReason: "aborted", errorMessage: "Request was aborted" };
		case "quota": return { ...base, provider: "anthropic", api: "anthropic-messages", model: "claude-opus", stopReason: "error", errorMessage: JSON.stringify({ error: { type: "rate_limit_error", retry_after: QUOTA_SECONDS } }) };
		case "cloud": return { ...base, provider: "openrouter", api: "openai-completions", model: "openai/gpt-6-luna", stopReason: "error", errorMessage: "openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly." };
		case "local": return { ...base, provider: "fw01", api: "openai-completions", model: "qwen3.8-flash-next", stopReason: "error", errorMessage: "Connection error." };
		case "other": return { ...base, provider: "anthropic", api: "anthropic-messages", model: "claude-opus", stopReason: "error", errorMessage: "invalid_request_error: messages.0.content is empty" };
		default: throw new Error(`unknown kind ${kind}`);
	}
}

interface PendingWait { ms: number; signal: AbortSignal; resolve: (finished: boolean) => void; done: boolean }

function makeWorld() {
	const dir = mkdtempSync(join(tmpdir(), "rate-limit-conformance-"));
	const file = join(dir, "pi-extras.json");
	writeFileSync(file, JSON.stringify({ rateLimitRecovery: {
		autoWait: true, maxRecoveries: 2, maxWaitSeconds: 2 * QUOTA_SECONDS, resumeMarginSeconds: 0,
		transientMaxWaitSeconds: 15, localRetry: true, localProviders: ["fw01"],
	} }));
	let now = NOW;
	let selected = MODELS.a1;
	// The fake Pi (the model's phase, queue and abort flag).
	const pi = { phase: "idle", queued: 0, aborted: false, settleGo: false };
	let run: AbortController | undefined;
	let branch: any[] = [];
	// The other branch that /tree can go to: at first the root, before any entry.
	let other: any[] = [];
	const waits: PendingWait[] = [];
	const terminal = new Set<(data: string) => unknown>();
	let handlers = new Map<string, (event: any, ctx: any) => any>();
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	let turnEnd: Promise<unknown> | undefined;
	let turnEndDone = false;
	let lastReply: any;

	const provider = (id: string) => ({ id, name: id, stream() {}, streamSimple() {} });
	const providers = new Map(["anthropic", "openai", "openrouter", "fw01"].map((id) => [id, provider(id)]));
	const modelRegistry = {
		getProvider: (id: string) => providers.get(id),
		getRegisteredNativeProvider: (id: string) => providers.get(id),
		getRegisteredProviderConfig: () => undefined,
		find: (id: string, model: string) => id === "fw01" ? { provider: "fw01", id: model, api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : undefined,
		registerProvider(value: any) { if (typeof value !== "string") providers.set(value.id, value); },
		unregisterProvider(id: string) { providers.delete(id); },
	};
	// ctx.abort() in the TUI: restoreQueuedMessagesToEditor({ abort: true }) clears the queues, then
	// AgentSession.abort() (interactive-mode.js:1478-1480, :3852-3869; agent-session.js:1971-1981).
	const abortRun = () => {
		pi.queued = 0;
		if (pi.phase !== "idle") { pi.aborted = true; run?.abort(); }
	};
	const ctx: any = {
		mode: "tui", hasUI: true, modelRegistry,
		get signal() { return pi.phase === "idle" ? undefined : run?.signal; },
		get model() { return selected; },
		sessionManager: { getBranch: () => branch },
		abort: abortRun,
		ui: {
			notify() {}, setWidget() {}, getEditorText: () => "",
			onTerminalInput(callback: (data: string) => unknown) { terminal.add(callback); return () => { terminal.delete(callback); }; },
		},
	};
	const startRun = (event: any) => {
		run = new AbortController();
		pi.phase = "starting"; pi.aborted = false; pi.settleGo = false;
		handlers.get("before_agent_start")?.(event, ctx);
	};
	const fakePi = {
		on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
		appendEntry(type: string, data: unknown) { branch.push({ type: "custom", customType: type, data }); },
		registerCommand(_name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) { command = options.handler; },
		// sendCustomMessage with triggerTurn: steer into an active run, else start one (agent-session.js:1857-1870).
		sendMessage(message: any) {
			if (pi.phase !== "idle") pi.queued += 1;
			else startRun({ messageType: "custom", message });
		},
	};
	let recovery: any;
	const load = () => {
		handlers = new Map();
		recovery = new Recovery(fakePi as never, {
			configFile: file, env: {}, now: () => now, random: () => 0.5,
			probe: async () => true,
			wait: (ms: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
				const entry: PendingWait = { ms, signal, resolve: (finished) => { if (!entry.done) { entry.done = true; resolve(finished); } }, done: false };
				if (signal.aborted) { entry.resolve(false); return; }
				signal.addEventListener("abort", () => entry.resolve(false), { once: true });
				waits.push(entry);
			}),
		});
		recovery.register();
	};
	load();
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const idleSignal = () => recovery.idleWait.active?.controller.signal as AbortSignal | undefined;
	const live = () => waits.filter((w) => !w.done && !w.signal.aborted);
	const runWait = () => {
		const idle = idleSignal();
		const found = live().filter((w) => w.signal !== idle);
		assert.equal(found.length, 1, "one in-run wait is pending");
		return found[0];
	};
	const watchTurnEnd = (promise: Promise<unknown>) => {
		turnEnd = promise; turnEndDone = false;
		void promise.then(() => { turnEndDone = true; });
	};
	/** After a step that can end our turn_end handler: the wait phases become "post". */
	const afterWait = () => {
		if ((pi.phase === "waitT" || pi.phase === "waitH") && turnEndDone) pi.phase = "post";
	};

	const actions: Record<string, (s: Record<string, any>) => Promise<void> | void> = {
		userPrompt() {
			if (pi.phase !== "idle") pi.queued += 1;
			else startRun({ messageType: "user", prompt: "go on" });
		},
		otherMessage() {
			if (pi.phase !== "idle") pi.queued += 1;
			else startRun({ messageType: "custom", message: { customType: "shell-job-report" } });
		},
		context() {
			emit("context", { messages: [] });
			pi.queued = 0; pi.phase = "request";
		},
		messageEnd(s) {
			const kind = pi.aborted ? "aborted" : picked(s, "kind");
			const message = reply(kind);
			const result = emit("message_end", { message });
			// Pi puts a replacement in place (agent-session.js:935-951).
			lastReply = result?.message ?? message;
			pi.phase = "msgDone";
		},
		async turnEnd() {
			watchTurnEnd(Promise.resolve(emit("turn_end", { message: lastReply, toolResults: [], messageEntryId: "failed", entries: [] })));
			await settle();
			pi.phase = turnEndDone ? "post" : recovery.active ? "waitH" : "waitT";
		},
		async transientTimer() {
			const wait = runWait();
			now += wait.ms; wait.resolve(true);
			await settle(); afterWait();
		},
		async hibernateTimer() {
			const wait = runWait();
			now += wait.ms; wait.resolve(true);
			await settle(); afterWait();
		},
		postRun() {
			// _handlePostAgentRun and the loop of _startRun (agent-session.js:1440-1460, :1531-1561).
			if (pi.aborted) { pi.phase = "idle"; return; }
			if (pi.queued > 0) { pi.queued = 0; pi.phase = "starting"; return; }
			const result = emit("agent_before_settle", { outcome: "error", context: { canContinue: true } });
			pi.settleGo = result?.continue === true;
			pi.phase = "settle";
		},
		settleEnd(s) {
			const go = !pi.aborted && (pi.settleGo || pi.queued > 0 || picked(s, "otherGo") === true);
			pi.settleGo = false;
			if (go) { pi.queued = 0; pi.phase = "starting"; } else pi.phase = "idle";
		},
		async idleWaitEnds() {
			const idle = idleSignal();
			const wait = live().find((w) => w.signal === idle);
			assert.ok(wait, "the idle wait has a pending timer");
			wait.resolve(true);
			await settle();
		},
		async modelSelect(s) {
			const m = picked(s, "m");
			// A skipped transient wait counts as long as it ran: let the clock run its full delay.
			if (recovery.transient.waiting) now += runWait().ms;
			selected = MODELS[m];
			emit("model_select", { model: selected });
			await settle(); afterWait();
		},
		async esc() {
			// The wait lines listen first (wait.ts:51-57), then Pi's onEscape (interactive-mode.js:2377-2379).
			for (const callback of [...terminal]) callback("\x1b");
			if (pi.phase !== "idle") abortRun();
			await settle(); afterWait();
		},
		async cancelCommand() {
			await command!("cancel", ctx);
			await settle(); afterWait();
		},
		async reload() {
			emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
			pi.aborted = false;
			load();
			emit("session_start", { type: "session_start", reason: "reload" });
			await settle();
		},
		async clone() {
			// fork(leaf, { position: "at" }): the branch is copied before teardown (agent-session-runtime.js:211-229).
			const copy = branch.map((entry) => ({ ...entry }));
			emit("session_shutdown", { type: "session_shutdown", reason: "fork" });
			branch = copy;
			other = [];
			pi.aborted = false;
			load();
			emit("session_start", { type: "session_start", reason: "fork" });
			await settle();
		},
		async leave(s) {
			// /resume away and back, or a new `pi --continue` (agent-session-runtime.js newSession, switchSession).
			// late: the user comes back after RESTART_RESTORE_MAX_AGE_MS (10 min, idle-wait.ts:20).
			emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
			if (picked(s, "late") === true) now += 11 * 60_000;
			pi.aborted = false;
			load();
			emit("session_start", { type: "session_start", reason: "resume" });
			await settle();
		},
		async tree(s) {
			// AgentSession.navigateTree while idle: no handler of ours runs (controller.ts:123-165).
			// keepsEntry: the target keeps the branch. Else the user goes to the other branch (first the root, later back).
			if (picked(s, "keepsEntry") !== true) [branch, other] = [other, branch];
			await settle();
		},
		stutter() {},
	};

	const entryOpen = () => {
		for (let i = branch.length - 1; i >= 0; i--) {
			const data = branch[i].data;
			if (branch[i].customType === RECOVERY_TYPE && data?.kind === "local-wait") return data.state === "open";
		}
		return false;
	};
	const snapshot = () => {
		const pending = recovery.pending as { eligible: boolean } | undefined;
		const tPending = recovery.transient.pending as { local?: unknown } | undefined;
		return {
			phase: pi.phase, aborted: pi.aborted, queued: pi.queued,
			model: Object.entries(MODELS).find(([, value]) => value === selected)![0],
			qPending: pending ? (pending.eligible ? "eligible" : "ineligible") : "none",
			qReady: recovery.ready, attempts: recovery.attempts, spent: recovery.spentMs / UNIT_MS, hActive: recovery.active !== undefined,
			tPending: tPending ? (tPending.local ? "local" : "cloud") : "none",
			tReady: recovery.transient.ready, tActive: recovery.transient.waiting, streak: recovery.transient.streaks["rate-limit"].attempts,
			iActive: recovery.idleWait.waiting, entryOpen: entryOpen(),
		};
	};
	return {
		actions, snapshot,
		async close() {
			emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			for (const wait of waits) wait.resolve(false);
			await turnEnd?.catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const COMPARED = ["phase", "aborted", "queued", "model", "qPending", "qReady", "attempts", "spent", "hActive", "tPending", "tReady", "tActive", "streak", "iActive", "entryOpen"] as const;

test("every model trace replays on the real recovery controller with equal state after each step", async () => {
	const traces = loadTraces();
	assert.ok(traces.length >= 100, `at least 100 traces (got ${traces.length})`);
	const seen = new Set<string>();
	for (const [index, trace] of traces.entries()) {
		const world = makeWorld();
		try {
			for (let step = 1; step < trace.states.length; step++) {
				const state = trace.states[step];
				const action = state["mbt::actionTaken"] as string;
				seen.add(action);
				const run = world.actions[action];
				assert.ok(run, `trace ${index} step ${step}: no replay for action ${action}`);
				await run(state);
				await settle();
				const code = world.snapshot();
				const model = plain(state);
				for (const key of COMPARED) {
					assert.deepEqual(code[key], model[key], `trace ${index} step ${step} (${action}): ${key} is ${JSON.stringify(code[key])} in the code, ${JSON.stringify(model[key])} in the model`);
				}
			}
		} finally { await world.close(); }
	}
	for (const action of ["userPrompt", "context", "messageEnd", "turnEnd", "transientTimer", "hibernateTimer", "postRun", "settleEnd", "idleWaitEnds", "modelSelect", "esc", "cancelCommand", "reload", "clone", "leave", "tree"]) {
		assert.ok(seen.has(action), `the traces reach ${action}`);
	}
	void LOCAL_RESUME_TYPE;
});
