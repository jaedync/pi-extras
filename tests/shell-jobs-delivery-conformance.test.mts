/**
 * Conformance of the shell-jobs delivery code with its Quint model
 * (formal/shell-jobs-delivery/delivery.qnt). Each trace that the model made
 * (`fv.mjs traces`) is replayed step by step against the real
 * lib/shell-jobs-delivery.ts, and after each step the code's state must equal
 * the model's: attempts, delivered, failed, claimed, outbox, reads in flight,
 * held completions, sends and the messages in the session. A difference means the model no
 * longer describes the code, so its checks prove nothing about the code.
 *
 * The real code here: attachDelivery, flush, sendCompletion, noteRunStart,
 * acknowledgeCompletion, settleDeliveries, reconcileDeliveries and parkForReload. The test copies
 * the few lines of finalize, stopJob and the event handlers that feed them.
 * Pi is a fake that follows the model's Pi rules (a send during agent_settled
 * waits, the waiting actions run one at a time, and each starts a run whose
 * before_agent_start names its message). The replay does not check
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

/** The choices of one model step that the code side needs. */
type Step = { j?: string; r?: [string, number]; clear?: boolean; loopRuns?: boolean };

/** The code side of one replay: a runtime, a fake Pi, and controllable tail reads. */
function makeWorld(first: { jobs: Record<string, unknown>; busy: boolean }) {
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
	const pi = {
		busy: Boolean(first.busy), settling: false, aborted: false, abortRequested: false, loopRuns: true, starting: null as string | null,
		deferred: [] as string[], later: [] as string[], loopRun: false, queue: [] as string[], history: [] as any[],
	};
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
			const id = message.details.id;
			if (pi.settling) pi.deferred.push(id);
			else if (pi.busy) pi.queue.push(id);
			else { pi.queue.push(id); pi.busy = true; pi.starting = id; }
			void b;
		},
	});
	const readTailFor = (b: number) => (logPath: string) => new Promise((resolve) => {
		const id = logPath.slice("/log/".length);
		reads.set(`${id}@${b}`, () => resolve({ text: "out", truncated: false, totalLines: 1, notice: null }));
	});
	const ctx = {
		isIdle: () => !pi.busy,
		// agent.signal: defined only while an agent loop runs.
		get signal() {
			return pi.busy && pi.loopRuns ? { aborted: pi.abortRequested } : undefined;
		},
		sessionManager: { getBranch: () => pi.history },
	};
	const attach = () => {
		binding += 1;
		active = true;
		return delivery.attachDelivery(runtime, apiFor(binding) as any, readTailFor(binding) as any, () => ctx.signal as AbortSignal | undefined);
	};
	attach();

	const actions: Record<string, (step: Step) => void> = {
		finishStart({ j: id }) {
			runtime.jobs.set(id, { ...runtime.jobs.get(id), state: "stopping" });
		},
		finishEnd({ j: id }) {
			// The tail of finalize, extensions/shell-jobs.ts:193-214.
			const latest = runtime.jobs.get(id);
			const done = { ...latest, state: "done", code: 0, endedAt: 1 };
			const suppressed = runtime.closing || done.claimed || done.delivered;
			runtime.jobs.set(id, suppressed ? done : { ...done, attempts: done.attempts + 1 });
			if (!suppressed) runtime.outbox.add(id);
			if (!suppressed) void runtime.delivery?.flush();
		},
		killStart({ j: id }) {
			// stopJob before its first await, lib/shell-jobs-manage.ts:148.
			runtime.jobs.set(id, { ...runtime.jobs.get(id), claimed: true, state: "stopping" });
		},
		killAnswer() {},
		killTimeout({ j: id }) {
			// stopJob after KILL_WAIT_MS, lib/shell-jobs-manage.ts:160-161.
			const pending = runtime.jobs.get(id);
			if (pending.state !== "done") runtime.jobs.set(id, { ...pending, claimed: false });
		},
		readSome({ r, loopRuns }) {
			const [id, b] = r!;
			pi.loopRuns = loopRuns ?? true;
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
		abortRequest({ clear }) {
			// Esc clears the queue first (clearQueue); other aborts keep it for the next run.
			if (clear) pi.queue = [];
			pi.abortRequested = true;
		},
		runEnds() {
			// _emitAgentSettled starts; `aborted` is _agentRunAbortRequested.
			pi.aborted = pi.abortRequested;
			pi.abortRequested = false;
			pi.busy = false;
			pi.settling = true;
		},
		settleHandler() {
			// The agent_settled handler (extensions/shell-jobs.ts).
			if (!active) return;
			settleHandlerDone = false;
			settleHandler = delivery.settleDeliveries(runtime, ctx as any, { aborted: pi.aborted }).then(() => { settleHandlerDone = true; });
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
			pi.starting = head === PROMPT ? null : head;
			pi.later = rest;
		},
		beforeAgentStart() {
			// The before_agent_start handler (extensions/shell-jobs.ts) for the run of a deferred send.
			const id = pi.starting!;
			pi.starting = null;
			const message = { customType: delivery.COMPLETION_CUSTOM_TYPE, details: { id, runtimeId: RUNTIME_ID } };
			if (active) delivery.noteRunStart(runtime, { messageType: "custom", message });
		},
		// Not a model action: _prepareRun throws after before_agent_start. The
		// run never takes its starting message and emits no agent_settled.
		startFails() {
			pi.queue.pop();
			pi.busy = false;
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
		held: Object.fromEntries(jobs.map((id) => [id, runtime.held?.get(id) ?? "none"])),
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
		held: s.held,
		binding: s.binding,
	};
}

/** The choices that a model step made, for the code side. */
function stepOf(state: Record<string, any>): Step {
	return { j: picked(state, "j"), r: picked(state, "r"), clear: state.queue.length === 0, loopRuns: picked(state, "loopRuns") };
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
		run(stepOf(states[i]));
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

/**
 * One schedule of model actions, run against the code. Each step names an
 * action of delivery.qnt and its choices. Returns the code's final state.
 */
async function runSchedule(start: { jobs: string[]; busy: boolean }, schedule: Array<[string, Step?]>) {
	const world = makeWorld({ jobs: Object.fromEntries(start.jobs.map((id) => [id, {}])), busy: start.busy });
	for (const [action, step] of schedule) {
		world.actions[action](step ?? {});
		await settle();
		await settle();
	}
	return world.codeState();
}

const ended = (j: string): Array<[string, Step]> => [["finishStart", { j }], ["finishEnd", { j }]];
const read = (j: string, b = 1): [string, Step] => ["readSome", { r: [j, b] }];
const runEnds = (): [string, Step?] => ["runEnds"];
const abort = (clear: boolean): Array<[string, Step?]> => [["abortRequest", { clear }], ["runEnds"]];
/** A deferred send runs: Pi starts its run, the message lands, and the run settles. */
const deferredRun: Array<[string, Step?]> = [["settleEnds"], ["beforeAgentStart"], ["piDeliver"], runEnds(), ["settleHandler"]];

// Finding F in formal/shell-jobs-delivery/README.md: before the fix, each of
// these schedules delivered one completion two times. Each test follows the
// numbered steps of its path there.
test("path F4: an abort that keeps the queue (the RPC abort, /compact in the TUI) does not send the kept completion again", async () => {
	const final = await runSchedule({ jobs: ["j1"], busy: true }, [
		...ended("j1"), read("j1"), ...abort(false), ["settleHandler"], ["settleEnds"],
		["userPrompt"], ["piDeliver"], runEnds(), ["settleHandler"], ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1 });
	assert.deepEqual(final.sends, { j1: 1 });
	assert.equal(final.jobs.j1.delivered, true);
});

test("path F5: a send after a TUI abort started stays in the queue and is not sent again", async () => {
	// Esc cleared the queue before the job ended, so the steer stays in the queue for the next run.
	const final = await runSchedule({ jobs: ["j1"], busy: true }, [
		...ended("j1"), ["abortRequest", { clear: true }], read("j1"), ["runEnds"], ["settleHandler"], ["settleEnds"],
		["userPrompt"], ["piDeliver"], runEnds(), ["settleHandler"], ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1 });
	assert.deepEqual(final.sends, { j1: 1 });
	assert.equal(final.jobs.j1.delivered, true);
});

test("path F2a: two deferred sends land once each", async () => {
	const final = await runSchedule({ jobs: ["j1", "j2"], busy: true }, [
		...ended("j1"), ...ended("j2"), runEnds(), ["settleHandler"], read("j1"), read("j2"),
		...deferredRun, ...deferredRun, ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1, j2: 1 });
	assert.deepEqual(final.sends, { j1: 1, j2: 1 });
});

test("path F2a through Esc: the dropped completions are sent again after the next run settles, once each", async () => {
	const final = await runSchedule({ jobs: ["j1", "j2"], busy: true }, [
		...ended("j1"), ...ended("j2"), read("j1"), read("j2"), ...abort(true), ["settleHandler"], ["settleEnds"],
		["userPrompt"], runEnds(), ["settleHandler"], read("j1"), read("j2"), ...deferredRun, ...deferredRun, ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1, j2: 1 });
	assert.deepEqual(final.sends, { j1: 2, j2: 2 });
});

test("path F2b: a prompt deferred ahead of the send does not cause a second send", async () => {
	const final = await runSchedule({ jobs: ["j1"], busy: true }, [
		...ended("j1"), runEnds(), ["settleHandler"], ["userPrompt"], read("j1"),
		["settleEnds"], runEnds(), ["settleHandler"], ...deferredRun, ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1 });
	assert.deepEqual(final.sends, { j1: 1 });
});

test("path F1: a reload while agent_settled handlers run does not send again", async () => {
	const final = await runSchedule({ jobs: ["j1"], busy: true }, [
		...ended("j1"), runEnds(), ["settleHandler"], read("j1"),
		["reloadRequest"], ["reloadPark"], ["sessionStart"], ...deferredRun, ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1 });
	assert.deepEqual(final.sends, { j1: 1 });
	assert.equal(final.jobs.j1.delivered, true);
	// Before the fix, the new binding's session_start counted a second attempt.
	assert.equal(final.jobs.j1.attempts, 1);
});

test("path F3: a send deferred before the shell-jobs handler runs is not sent again", async () => {
	const final = await runSchedule({ jobs: ["j1"], busy: true }, [
		...ended("j1"), runEnds(), read("j1"), ["settleHandler"], ...deferredRun, ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1 });
	assert.deepEqual(final.sends, { j1: 1 });
});

test("a deferred send whose run fails to start is sent again after the next settled run", async () => {
	const final = await runSchedule({ jobs: ["j1"], busy: true }, [
		...ended("j1"), runEnds(), ["settleHandler"], read("j1"), ["settleEnds"], ["beforeAgentStart"], ["startFails"],
		["userPrompt"], runEnds(), ["settleHandler"], read("j1"), ...deferredRun, ["settleEnds"],
	]);
	assert.deepEqual(final.history, { j1: 1 });
	assert.deepEqual(final.sends, { j1: 2 });
	assert.deepEqual(final.held, { j1: "none" });
});

test("three dropped sends reach the attempt cap and mark the job as not delivered", async () => {
	// Each Esc drops the copy in the queue; the next run that settles with no abort releases it.
	const dropThenRun: Array<[string, Step?]> = [...abort(true), ["settleHandler"], ["settleEnds"], ["userPrompt"], runEnds(), ["settleHandler"]];
	const resentRunStarts: Array<[string, Step?]> = [read("j1"), ["settleEnds"], ["beforeAgentStart"]];
	const final = await runSchedule({ jobs: ["j1"], busy: true }, [
		...ended("j1"), read("j1"), ...dropThenRun, ...resentRunStarts, ...dropThenRun, ...resentRunStarts, ...dropThenRun, ["settleEnds"],
	]);
	assert.deepEqual(final.sends, { j1: 3 });
	assert.deepEqual(final.history, { j1: 0 });
	assert.equal(final.jobs.j1.attempts, 3);
	assert.equal(final.jobs.j1.failed, true);
});
