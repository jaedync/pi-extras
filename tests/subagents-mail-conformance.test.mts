/**
 * Conformance of subagent mail to main with its Quint model
 * (formal/subagents-mail/mail.qnt). Each trace that the model made
 * (`fv.mjs traces`) is replayed step by step against the real MainMail
 * (lib/subagents/deliver.ts), the real watchMain (lib/subagents/main-watch.ts)
 * and the real PortBinding (lib/subagents/host.ts). After each step the code's
 * state must equal the model's: the outbox, the pending items, what main owes,
 * the batch and its timer, the retry timer, the route, idle(), and where Pi
 * holds each message (the starting message of a run, the deferred actions,
 * the held custom messages, the steering queue, the transcript).
 *
 * The test copies a few lines that it cannot run: the message_end and
 * reconcile handlers of extensions/subagents.ts:333-353, Host.rebind
 * (host-state.ts:223-229), Host.close's drain and handOverMail
 * (host-state.ts:250-254, :295-301) and postKeptMail's resend
 * (host-state.ts:304-311). Pi is a fake that follows the model's Pi rules
 * (sendCustomMessage, as:1844-1883; the deferred actions, as:683-701). The
 * replay does not check those rules against Pi: repro-f1.mts does that in a
 * real AgentSession. See formal/subagents-mail/README.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { MainMail } from "../lib/subagents/deliver.ts";
import { MESSAGE_TYPE, type HeldMail, type HostPorts, type OutgoingMessage } from "../lib/subagents/contract.ts";
import { PortBinding } from "../lib/subagents/host.ts";
import { watchMain } from "../lib/subagents/main-watch.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const TRACES = new URL("../formal/subagents-mail/traces.itf.jsonl.gz", import.meta.url);

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

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sorted = (values: Iterable<string>) => [...values].sort();

/** The model's name for a message: a (note), b (relay), r (report), rem (reminder). */
function modelId(details: { kind: string }): string {
	return ({ note: "a", relay: "b", report: "r", reminder: "rem" } as Record<string, string>)[details.kind]!;
}

function record(name: string): AgentRecord {
	return {
		name, parent: "main", depth: 1, task: "t", model: "p/m", readOnly: false, fork: false, blocking: false,
		state: "idle", createdAt: 0, startedAt: 0, endedAt: 1, activity: null, toolCalls: 1, usage: { ...NO_USAGE },
		runs: 1, report: `${name} says done`, sessionFile: `/s/${name}.jsonl`,
	} as AgentRecord;
}

type Handler = (event: any, ctx: any) => unknown;

/** The code side of one replay. */
function makeWorld() {
	let time = 1_000_000;
	const now = () => time;
	// Pi, as the model has it.
	const pi = {
		phase: "idle", prep: [] as OutgoingMessage[], deferred: [] as Array<OutgoingMessage | "prompt">, later: [] as Array<OutgoingMessage | "prompt">,
		pendingCustom: [] as OutgoingMessage[], steerQ: [] as OutgoingMessage[], compacting: false, bsContinue: false,
		entries: [] as any[], cut: 0, promptWaiting: false,
	};
	let entryId = 0;
	let failNext = false;
	const active = () => pi.phase === "prep" || pi.phase === "work" || pi.phase === "bs";
	const append = (message: OutgoingMessage) => {
		pi.entries.push({ type: "custom_message", id: `e${++entryId}`, customType: message.customType, content: message.content, display: message.display, details: message.details });
	};
	const reply = () => { pi.entries.push({ type: "message", id: `e${++entryId}`, message: { role: "assistant", stopReason: "stop" } }); };
	// sendCustomMessage (as:1844-1883).
	const sendMessage = (message: OutgoingMessage, options: { triggerTurn: boolean; deliverAs?: string }) => {
		if (failNext) { failNext = false; throw new Error("stale pi"); }
		if (active() && options.triggerTurn) pi.steerQ.push(message);
		else if (options.triggerTurn) {
			if (pi.phase === "settle") pi.deferred.push(message);
			else { pi.phase = "prep"; pi.prep.push(message); }
		} else if (active()) pi.pendingCustom.push(message);
		else append(message);
	};
	const ctx = {
		isIdle: () => !active() && !pi.compacting,
		sessionManager: { getBranch: () => pi.entries },
	};

	// One evaluation of the extension: its own event handlers and its watchMain.
	let served = true;
	let mail: MainMail;
	const host = () => (served ? mail : null);
	let handlers = new Map<string, Handler[]>();
	const newModule = () => {
		handlers = new Map();
		const bus = { on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
		const watch = watchMain(bus as never, () => host(), now);
		// extensions/subagents.ts:333-353, registered after watchMain as there.
		const reconcile = () => host()?.reconcile(pi.entries);
		bus.on("turn_end", async () => reconcile());
		bus.on("agent_end", async () => reconcile());
		bus.on("agent_settled", async () => reconcile());
		bus.on("message_end", (event: any) => { const id = event.message?.details?.id; if (typeof id === "string") host()?.acknowledge(id); });
		const ports: HostPorts = {
			send: (message, options) => sendMessage(message as OutgoingMessage, options),
			route: () => watch.route(ctx),
			notify() {}, teamChanged() {}, mailChanged() {},
			launcher: { launch: async () => { throw new Error("no launches here"); } } as never,
			models: () => ({ allowed: [], fallbackModel: null }),
		};
		return ports;
	};
	const emit = async (name: string, event: any = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
		return results;
	};
	const newMail = (binding: PortBinding) => new MainMail({
		port: { send: (message, options) => binding.ports.send(message, options) },
		route: () => binding.ports.route(),
		batchMs: 1_000_000_000,
		now,
	});
	let binding = new PortBinding(newModule());
	mail = newMail(binding);
	let kept: HeldMail[] = [];

	const land = (messages: OutgoingMessage[]) => { for (const message of messages) append(message); };
	const contextMessages = () => pi.entries.slice(pi.cut).map((e) => e.type === "message" ? e.message : { role: "custom", customType: e.customType, details: e.details });
	const startRun = async () => {
		// _startRun: held custom messages first (as:1437-1440), then agent_start and the starting messages (agent-loop.js:55-60).
		land(pi.pendingCustom.splice(0));
		pi.phase = "work";
		await emit("agent_start");
		for (const message of pi.prep.splice(0)) {
			await emit("message_end", { message: { role: "custom", ...message } });
			append(message);
		}
	};

	const actions: Record<string, (s: Record<string, any>, before: Record<string, any>) => Promise<void> | void> = {
		childMail(s) {
			failNext = picked(s, "throws") === true;
			const id = picked(s, "id");
			// The team calls its own mail, served or parked (host-state.ts:85).
			mail.deliver(id === "a" ? { kind: "note", from: "scout", text: "found it" } : { kind: "relay", from: "user", to: "scout", text: "hi", answered: false });
		},
		childReport() { mail.deliver({ kind: "report", record: record("scout") }); },
		batchFlush(s) { failNext = picked(s, "throws") === true; mail.flush(); },
		retryFire(s) { failNext = picked(s, "throws") === true; mail.retry(); },
		retrySoonFire() { mock.timers.tick(1); },
		reconcileTick() { host()?.reconcile(pi.entries); },
		async runStart(s) { failNext = picked(s, "throws") === true; await startRun(); },
		async turnEnd(s) {
			reply();
			await emit("turn_end");
			// Pi flushes after the turn_end handlers (as:796-798).
			land(pi.pendingCustom.splice(0));
			if (s.phase === "work") return;
			await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
			pi.phase = "bs";
		},
		async beforeSettle() {
			const context = { contextMessages: contextMessages(), pendingMessages: pi.pendingCustom.map((m) => ({ role: "custom", ...m })) };
			const [result] = await emit("agent_before_settle", { context });
			pi.bsContinue = (result as { continue?: boolean } | undefined)?.continue === true;
		},
		async bsEnd(s) {
			failNext = picked(s, "throws") === true;
			land(pi.pendingCustom.splice(0));
			if (pi.bsContinue) { pi.phase = "work"; pi.bsContinue = false; await emit("agent_start"); }
			else pi.phase = "settle";
		},
		async settledHandler(s) { failNext = picked(s, "throws") === true; await emit("agent_settled", { aborted: false }); },
		settleEnd() {
			const items = [...pi.deferred, ...pi.later];
			pi.deferred = [];
			if (items.length === 0) { pi.phase = "idle"; pi.later = []; return; }
			const [head, ...rest] = items;
			pi.phase = "prep";
			if (head !== "prompt") pi.prep.push(head!);
			pi.later = rest;
		},
		async userInput() { pi.promptWaiting = true; await emit("input"); },
		userInputDeferred() { pi.deferred.push("prompt"); },
		promptRun() { pi.promptWaiting = false; if (pi.phase === "idle" && !pi.compacting) pi.phase = "prep"; },
		graceEnds() { time += 2_001; },
		async userAbort() {
			// clearAllQueues and abort (interactive-mode.js:3853, as:1971-1982); the finally flushes (as:1467-1471).
			pi.steerQ = [];
			await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
			land(pi.pendingCustom.splice(0));
			pi.phase = "settle";
		},
		async compactMidRun() {
			await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
			land(pi.pendingCustom.splice(0));
			pi.phase = "settle";
		},
		compactIdle() {},
		async compactStart() { pi.compacting = true; await emit("session_before_compact", { reason: "manual" }); },
		async compactEnd(s) {
			failNext = picked(s, "throws") === true;
			if (s.unread.length === 0) pi.cut = pi.entries.length;
			await emit("session_compact", { reason: "manual" });
			pi.compacting = false;
		},
		reloadStart() { binding.park(); served = false; },
		async reloadAdopt(s) {
			failNext = picked(s, "throws") === true;
			const ports = newModule();
			await emit("session_start", { reason: "reload" });
			// Host.rebind, host-state.ts:223-229.
			binding.bind(ports);
			served = true;
			mail.retry();
		},
		fallbackClose() {
			// Host.close, host-state.ts:250-254, and handOverMail (:295-301) with no module bound.
			const live = binding.beginClose();
			const items = mail.drain();
			kept = live ? items.filter(({ message }) => { try { live.send(message, { triggerTurn: false }); return false; } catch { return true; } }) : [...items];
			binding.close();
			served = false;
		},
		async fallbackOpen(s) {
			failNext = picked(s, "throws") === true;
			const ports = newModule();
			await emit("session_start", { reason: "reload" });
			binding = new PortBinding(ports);
			mail = newMail(binding);
			served = true;
			// postKeptMail, host-state.ts:304-311.
			const items = kept;
			kept = [];
			mail.resend(items);
		},
	};

	const box = () => mail as any;
	const codeState = () => ({
		outbox: box().outbox.map((item: HeldMail) => modelId(item.message.details)),
		pending: sorted(mail.pending().map((item) => item.id.startsWith("pending-report-") ? "pr" : modelId(item))),
		owing: sorted([...box().owing.keys()].map((id: string) => idKinds.get(id)!)),
		batch: box().batch.length > 0,
		batchTimer: box().timer !== null,
		retryArmed: box().retryTimer !== null,
		closed: box().closed,
		phase: pi.phase,
		prep: pi.prep.map((m) => modelId(m.details)),
		deferred: pi.deferred.map((m) => (m === "prompt" ? m : modelId(m.details))),
		later: pi.later.map((m) => (m === "prompt" ? m : modelId(m.details))),
		pendingCustom: pi.pendingCustom.map((m) => modelId(m.details)),
		steerQ: pi.steerQ.map((m) => modelId(m.details)),
		landed: Object.fromEntries(["a", "b", "r", "rem"].map((id) => [id, pi.entries.filter((e) => e.type === "custom_message" && modelId(e.details) === id).length])),
		compacting: pi.compacting,
		kept: kept.map((item) => modelId(item.message.details)),
		route: binding.ports.route(),
		idle: mail.idle(),
	});
	// Code ids to model ids, read from everything the mail has made so far.
	const idKinds = new Map<string, string>();
	const learnIds = () => {
		for (const item of box().outbox as HeldMail[]) idKinds.set(item.message.details.id, modelId(item.message.details));
		for (const m of [...pi.prep, ...pi.pendingCustom, ...pi.steerQ, ...pi.deferred, ...pi.later]) if (m !== "prompt") idKinds.set(m.details.id, modelId(m.details));
		for (const e of pi.entries) if (e.type === "custom_message") idKinds.set(e.details.id, modelId(e.details));
	};
	const after = () => { failNext = false; learnIds(); };
	// Each step takes a millisecond, so two MainMail instances never make the same id (deliver.ts:420-422).
	const tick = () => { time += 1; };
	return { actions, codeState, after, tick, dispose: () => mail.dispose() };
}

const ROUTE_ACTIVE = new Set(["prep", "work", "bs"]);
function modelState(s: Record<string, any>) {
	const served = s.hostPhase === "served";
	const route = !served ? "hold"
		: !ROUTE_ACTIVE.has(s.phase) && !s.compacting ? (s.grace ? "hold" : "wake")
			: s.running && !s.settling ? "queue" : "hold";
	return {
		outbox: s.outbox, pending: sorted(s.pending), owing: sorted(s.owing), batch: s.batch, batchTimer: s.batchTimer,
		retryArmed: s.retryArmed, closed: s.closed, phase: s.phase, prep: s.prep, deferred: s.deferred, later: s.later,
		pendingCustom: s.pendingCustom, steerQ: s.steerQ, landed: s.landed, compacting: s.compacting, kept: s.kept,
		route, idle: s.pending.length === 0 && !s.batch && s.outbox.length === 0 && s.owing.length === 0,
	};
}

/** Replay one trace; returns the code's final state. */
async function replay(trace: Itf, index: number) {
	const states = trace.states.map(plain);
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout"] });
	const world = makeWorld();
	try {
		assert.deepEqual(world.codeState(), modelState(states[0]), `trace ${index}: initial state`);
		for (let i = 1; i < states.length; i++) {
			const action = states[i]["mbt::actionTaken"];
			const run = world.actions[action];
			assert.ok(run, `trace ${index}: the replay has no mapping for action ${action}`);
			world.tick();
			await run(states[i], states[i - 1]);
			world.after();
			await settle();
			await settle();
			assert.deepEqual(world.codeState(), modelState(states[i]), `trace ${index}, step ${i} (${action}): the code and the model differ`);
		}
		return { steps: states.length - 1, final: world.codeState(), last: states.at(-1)! };
	} finally {
		world.dispose();
		mock.timers.reset();
	}
}

test("subagent mail follows every step of the model traces", async () => {
	const traces = loadTraces();
	assert.ok(traces.length >= 150, `expected the committed traces, found ${traces.length}`);
	let steps = 0;
	for (const [index, trace] of traces.entries()) steps += (await replay(trace, index)).steps;
	assert.ok(steps > 2000, `expected over 2000 replayed steps, replayed ${steps}`);
});

// Finding F1 in formal/subagents-mail/README.md: the model's path to waking
// mail that main never answers. This test shows that the code takes each step
// of it; it is not a wish. When the code is fixed, the model and this test change.
test("finding F1: the code follows the model's path to waking mail main never answers", async () => {
	const traces = loadTraces();
	const index = traces.findIndex((t: any) => t["#meta"]?.witness === "wokenForMail");
	assert.ok(index >= 0, "the traces hold no wokenForMail witness; run fv.mjs traces");
	const { final, last } = await replay(traces[index], index);
	assert.equal(final.phase, "idle");
	assert.ok(last.unreplied.some((id: string) => id !== "b" && !last.excused.includes(id)), "the witness ends with waking mail that main did not answer");
	void MESSAGE_TYPE;
});
