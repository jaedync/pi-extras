/**
 * Conformance of the shell-jobs delivery code with its Quint model
 * (formal/shell-jobs-delivery/delivery.qnt). Each trace that the model made
 * (`fv.mjs traces`) is replayed step by step against the real
 * lib/shell-jobs-delivery.ts, and after each step the code's state must equal
 * the model's: attempts, delivered, failed, claimed, outbox, reads in flight,
 * sends and the messages in the session. A difference means the model no
 * longer describes the code, so its checks prove nothing about the code.
 *
 * The real code here: attachDelivery, flush, sendCompletion,
 * acknowledgeCompletion, reconcileDeliveries and parkForReload. The test copies
 * the few lines of finalize, stopJob and the event handlers that feed them.
 * Pi is a fake that follows the model's Pi rules (a send during agent_settled
 * waits, and the waiting actions run one at a time). The replay does not check
 * those rules against Pi: repro-f1.mts and repro-f2.mts do that in a real
 * AgentSession. See formal/shell-jobs-delivery/README.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { delivery, jiti } from "./support/shell-jobs-harness.mts";

const processModule = (await jiti.import("../../lib/shell-jobs-process.ts")) as typeof import("../lib/shell-jobs-process.ts");

const TRACES = new URL("../formal/shell-jobs-delivery/traces.itf.jsonl.gz", import.meta.url);
const RUNTIME_ID = "conformance";

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

/** The code side of one replay: a runtime, a fake Pi, and controllable tail reads. */
function makeWorld(first: Record<string, any>) {
	const jobs = Object.keys(first.jobs);
	const runtime: any = {
		runtimeId: RUNTIME_ID, jobs: new Map(), outbox: new Set<string>(), delivery: null, closing: false,
		widget: { update() {}, detach() {} }, reloadTimer: null,
	};
	const session = {};
	for (const id of jobs) {
		runtime.jobs.set(id, {
			id, pid: 0, command: "true", title: null, toolCallId: null, cwd: "/", logPath: `/log/${id}`, startedAt: 0, epoch: 0,
			state: "running", code: null, signal: null, endedAt: null, claimed: false, attempts: 0, delivered: false,
			deliveryFailed: false, cleanupError: null, runtimeId: RUNTIME_ID,
		});
	}
	const PROMPT = "prompt";
	const pi = { busy: Boolean(first.busy), settling: false, deferred: [] as string[], later: [] as string[], loopRun: false, queue: [] as string[], history: [] as any[] };
	const sends: Record<string, number> = Object.fromEntries(jobs.map((id) => [id, 0]));
	const reads = new Map<string, () => void>();
	let binding = 0;
	let active = false;
	let settleHandler: Promise<void> | null = null;
	let settleHandlerDone = true;

	const apiFor = (b: number) => ({
		// Pi's sendCustomMessage with triggerTurn: steer into a run, start one, or wait for agent_settled to end.
		sendMessage(message: any) {
			sends[message.details.id] += 1;
			if (pi.settling) pi.deferred.push(message.details.id);
			else { pi.queue.push(message.details.id); pi.busy = true; }
			void b;
		},
	});
	const readTailFor = (b: number) => (logPath: string) => new Promise((resolve) => {
		const id = logPath.slice("/log/".length);
		reads.set(`${id}@${b}`, () => resolve({ text: "out", truncated: false, totalLines: 1, notice: null }));
	});
	const ctx = {
		isIdle: () => !pi.busy,
		sessionManager: { getBranch: () => pi.history },
	};
	const attach = () => {
		binding += 1;
		active = true;
		return delivery.attachDelivery(runtime, apiFor(binding) as any, readTailFor(binding) as any);
	};
	attach();

	const actions: Record<string, (s: Record<string, any>, before: Record<string, any>) => void> = {
		finishStart(s) {
			const id = picked(s, "j");
			runtime.jobs.set(id, { ...runtime.jobs.get(id), state: "stopping" });
		},
		finishEnd(s) {
			// The tail of finalize, extensions/shell-jobs.ts:193-214.
			const id = picked(s, "j");
			const latest = runtime.jobs.get(id);
			const done = { ...latest, state: "done", code: 0, endedAt: 1 };
			const suppressed = runtime.closing || done.claimed || done.delivered;
			runtime.jobs.set(id, suppressed ? done : { ...done, attempts: done.attempts + 1 });
			if (!suppressed) runtime.outbox.add(id);
			if (!suppressed) void runtime.delivery?.flush();
		},
		killStart(s) {
			// stopJob before its first await, lib/shell-jobs-manage.ts:148.
			const id = picked(s, "j");
			runtime.jobs.set(id, { ...runtime.jobs.get(id), claimed: true, state: "stopping" });
		},
		killAnswer() {},
		killTimeout(s) {
			// stopJob after KILL_WAIT_MS, lib/shell-jobs-manage.ts:160-161.
			const id = picked(s, "j");
			const pending = runtime.jobs.get(id);
			if (pending.state !== "done") runtime.jobs.set(id, { ...pending, claimed: false });
		},
		readSome(s) {
			const [id, b] = picked(s, "r");
			const release = reads.get(`${id}@${b}`);
			assert.ok(release, `the code has no read in flight for ${id} in binding ${b}`);
			reads.delete(`${id}@${b}`);
			release();
		},
		piDeliver() {
			// Pi appends the message; the message_end handler acknowledges it (extensions/shell-jobs.ts:844-852).
			const id = pi.queue.shift()!;
			pi.history.push({ type: "custom_message", customType: delivery.COMPLETION_CUSTOM_TYPE, details: { id, runtimeId: RUNTIME_ID } });
			if (active) delivery.acknowledgeCompletion(runtime, id);
		},
		runEnds(s, before) {
			// _emitAgentSettled starts; an abort dropped the run's messages (clearQueue).
			if (s.runs > before.runs) pi.queue = [];
			pi.busy = false;
			pi.settling = true;
		},
		settleHandler() {
			// The agent_settled handler, extensions/shell-jobs.ts:856-858.
			if (!active) return;
			settleHandlerDone = false;
			settleHandler = delivery.reconcileDeliveries(runtime, ctx as any).then(() => { settleHandlerDone = true; });
		},
		settleEnds() {
			assert.equal(settleHandlerDone, true, "the model ends agent_settled while the shell-jobs handler still awaits a read");
			// Deferred actions run one at a time; those of a nested emission go first.
			const items = [...pi.deferred, ...pi.later];
			pi.settling = false;
			pi.deferred = [];
			settleHandler = null;
			if (items.length === 0) { pi.busy = false; pi.later = []; pi.loopRun = false; return; }
			const [head, ...rest] = items;
			pi.busy = true;
			pi.loopRun = true;
			if (head !== PROMPT) pi.queue.push(head);
			pi.later = rest;
		},
		userPrompt() {
			if (pi.settling) pi.deferred.push(PROMPT);
			else pi.busy = true;
		},
		reloadRequest() {},
		reloadPark() {
			// session_shutdown with reason "reload" (extensions/shell-jobs.ts:860-872).
			active = false;
			processModule.parkForReload(session, runtime, () => {});
		},
		sessionStart() {
			// extensions/shell-jobs.ts:818-835: attach, reconcile, flush.
			if (runtime.reloadTimer) clearTimeout(runtime.reloadTimer);
			runtime.reloadTimer = null;
			const fresh = attach();
			void delivery.reconcileDeliveries(runtime, ctx as any).then(() => fresh.flush());
		},
	};

	const codeState = () => ({
		jobs: Object.fromEntries(jobs.map((id) => {
			const job = runtime.jobs.get(id);
			return [id, { done: job.state === "done", claimed: job.claimed, attempts: job.attempts, delivered: job.delivered, failed: job.deliveryFailed }];
		})),
		outbox: [...runtime.outbox].sort(),
		reading: [...reads.keys()].sort(),
		sends: { ...sends },
		history: Object.fromEntries(jobs.map((id) => [id, pi.history.filter((e) => e.details.id === id).length])),
		binding: runtime.delivery === null ? 0 : binding,
	});
	return { actions, codeState, pending: () => settleHandler };
}

function modelState(s: Record<string, any>) {
	const jobs = s.jobs as Record<string, any>;
	return {
		jobs: Object.fromEntries(Object.entries(jobs).map(([id, j]) => [id, { done: j.phase === "done", claimed: j.claimed, attempts: j.attempts, delivered: j.delivered, failed: j.failed }])),
		outbox: [...s.outbox].sort(),
		reading: s.reading.map(([id, b]: [string, number]) => `${id}@${b}`).sort(),
		sends: s.sends,
		history: s.history,
		binding: s.binding,
	};
}

/** Replay one trace; returns the code's final state. */
async function replay(trace: Itf, index: number) {
	const states = trace.states.map(plain);
	const world = makeWorld(states[0]);
	assert.deepEqual(world.codeState(), modelState(states[0]), `trace ${index}: initial state`);
	for (let i = 1; i < states.length; i++) {
		const action = states[i]["mbt::actionTaken"];
		const run = world.actions[action];
		assert.ok(run, `trace ${index}: the replay has no mapping for action ${action}`);
		run(states[i], states[i - 1]);
		await settle();
		await settle();
		assert.deepEqual(world.codeState(), modelState(states[i]), `trace ${index}, step ${i} (${action}): the code and the model differ`);
	}
	return { steps: states.length - 1, final: world.codeState() };
}

test("the delivery code follows every step of the model traces", async () => {
	const traces = loadTraces();
	assert.ok(traces.length >= 200, `expected the committed traces, found ${traces.length}`);
	let steps = 0;
	for (const [index, trace] of traces.entries()) steps += (await replay(trace, index)).steps;
	assert.ok(steps > 3000, `expected over 3000 replayed steps, replayed ${steps}`);
});

// Finding F in formal/shell-jobs-delivery/README.md: a send that Pi defers
// during agent_settled is invisible to reconcile, so one completion can be
// delivered twice. This test shows that the code takes each step of the
// model's path; it is not a wish. When the code is fixed, the model and this
// test change with it.
test("finding F: the code follows the model's path to a duplicate completion", async () => {
	const traces = loadTraces();
	const index = traces.findIndex((t: any) => t["#meta"]?.witness === "oneCompletion");
	assert.ok(index >= 0, "the traces hold no oneCompletion witness; run fv.mjs traces");
	const { final } = await replay(traces[index], index);
	assert.ok(Object.values(final.history).some((count) => count === 2), "the replay did not end with two completion messages for one job");
});
