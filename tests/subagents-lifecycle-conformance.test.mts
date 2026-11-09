/**
 * Conformance of the subagent run lifecycle with its Quint model
 * (formal/subagents-lifecycle/lifecycle.qnt). Each trace that the model made
 * (`fv.mjs traces`) is replayed step by step against the real Team
 * (lib/subagents/team.ts with slots.ts, routing.ts, sessions.ts,
 * resume-prompts.ts and mailbox.ts), and after each step the code's state must
 * equal the model's: each child's state, launch number, place in line, held
 * session, inbox, resume prompt, unread steering, the stops that await an
 * abort, the reports handed up and the prompts in flight. A difference means
 * the model no longer describes the code, so its checks prove nothing about it.
 *
 * The child's handle runs the real prompt gate (lib/subagents/child-prompt.ts)
 * and the real disposer (child.ts childDisposer) over a fake Pi session that
 * follows the model's Pi rules: an abort in the pre-run window is lost, an
 * abort in _prepareRun stops the prompt at agent_start while the listener is
 * there, Pi's dispose takes the listener away and stops only an active loop,
 * and a steer reaches the queue only when its input handlers end. The replay
 * does not check those rules against Pi: probe-pi-abort.mts and the repro
 * scripts in formal/subagents-lifecycle do that in a real AgentSession. The
 * quiet-spell timer of sessions.ts:140-143 is called by hand.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { Team } from "../lib/subagents/team.ts";
import { childDisposer } from "../lib/subagents/child.ts";
import { promptGate } from "../lib/subagents/child-prompt.ts";
import { stillUnread } from "../lib/subagents/mailbox.ts";
import type { AgentRecord, ChildHandle, ChildHooks, MainDelivery } from "../lib/subagents/types.ts";

const TRACES = new URL("../formal/subagents-lifecycle/traces.itf.jsonl.gz", import.meta.url);
const CHILDREN = ["c1", "c2"];
const PRIMARY = "openai/gpt-primary";
const FALLBACK = "anthropic/claude-fallback";
// planFallback (fallback.ts) takes this as a provider failure that a fallback model can serve.
const MODEL_ERROR = "503 service unavailable";
const MAX_MSGS = 2;

type Itf = { states: Array<Record<string, any>>; "#meta"?: Record<string, any> };

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
const sorted = <T,>(items: T[]): T[] => [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

/**
 * A prompt in the fake Pi session. `abortSeen`: an abort came while it was in
 * its pre or prep window (sticky, as the model's abortReq there); `piAbort`:
 * Pi's _agentRunAbortRequested, which _startRun resets; `loopAborted`: an
 * abort of its active loop; `disposed`: the handle's dispose began.
 */
interface FakePrompt {
	c: string; s: number; r: number; phase: string; out: string; abortSeen: boolean; piAbort: boolean; loopAborted: boolean; disposed: boolean;
	started?: (disposition: string) => void; resolve(): void;
}
interface FakeSession {
	c: string; l: number; disposing: boolean; piDisposed: boolean; listener: boolean; queue: string[]; hooks: ChildHooks;
	aborts: Array<() => void>; steers: Array<{ id: number; text: string; land(): void }>; failed: boolean;
}

/** The code side of one replay: a real Team, a fake launcher and fake Pi sessions. */
function makeWorld() {
	const pendingLaunches: Array<{ c: string; l: number; resolve(handle: ChildHandle): void; reject(error: Error): void; hooks: ChildHooks }> = [];
	const sessions: FakeSession[] = [];
	const prompts: FakePrompt[] = [];
	const transcripts = new Map<string, unknown[]>(CHILDREN.map((c) => [c, []]));
	const main: MainDelivery[] = [];
	const stops: Array<{ c: string; l: number; s: number; done: boolean }> = [];
	const sent = new Map<string, string[]>(CHILDREN.map((c) => [c, []]));
	const waiting = new Set<string>();
	let refusedLive = false;
	let msgs = 0;
	let stopsMade = 0;
	let team: Team;
	const launchOf = (c: string): number => ((team as any).launches.get(c) ?? 0);
	const mine = (session: FakeSession) => prompts.filter((p) => p.c === session.c && p.s === session.l);
	// Pi's waitForIdle (agent-session.js:1984-1989): no run is active; a prompt in its pre window has none yet.
	const piIdle = (session: FakeSession) => mine(session).every((p) => p.phase === "pre" || p.phase === "steers");
	const wakeAborts = (session: FakeSession) => { if (piIdle(session)) for (const resolve of session.aborts.splice(0)) resolve(); };

	/** The parts of Pi's AgentSession that the gate and the disposer use, by the model's Pi rules. */
	const piSession = (session: FakeSession) => ({
		prompt(text: string, options?: { preflightResult?: (disposition: string) => void }) {
			if (!session.piDisposed) transcripts.get(session.c)!.push(user(text));
			return new Promise<void>((resolve) => {
				prompts.push({ c: session.c, s: session.l, r: launchOf(session.c), phase: "pre", out: "", abortSeen: false, piAbort: false, loopAborted: false,
					disposed: session.disposing, resolve, ...(options?.preflightResult ? { started: options.preflightResult } : {}) });
			});
		},
		// AgentSession.abort (agent-session.js:1971-1989): the flag only while a run exists; it resolves when no run is active.
		abort() {
			for (const p of mine(session)) {
				if (p.phase === "pre" || p.phase === "prep") p.abortSeen = true;
				if (p.phase === "prep") p.piAbort = true;
				if (p.phase === "active") p.loopAborted = true;
			}
			if (piIdle(session)) return Promise.resolve();
			return new Promise<void>((resolve) => session.aborts.push(resolve));
		},
		// agent-session.js:1752-1766: the message is queued once the input handlers end (the replay's steerLands).
		steer(text: string) {
			const id = MAX_MSGS + 1 - Number(/<m(\d+)>/.exec(text)?.[1] ?? 0);
			return new Promise<void>((resolve) => session.steers.push({ id, text, land: () => { session.queue.push(text); resolve(); } }));
		},
		extensionRunner: undefined,
		// AgentSession.dispose (:1011-1030): agent.abort() stops an active loop; the listener goes. The fake also drops the queue.
		dispose() {
			session.piDisposed = true;
			session.listener = false;
			session.queue.splice(0);
			for (const p of mine(session)) if (p.phase === "active") p.loopAborted = true;
		},
	});

	const handleFor = (session: FakeSession): ChildHandle & { session: FakeSession } => {
		const pi = piSession(session);
		const gate = promptGate(pi);
		const disposer = childDisposer(pi as never, () => undefined, { dispose() {} }, gate);
		return {
			session,
			// child.ts handleFor `prompt`: the gate, then a reply that ended with an error throws.
			async prompt(text) {
				const running = gate.prompt(text);
				const p = prompts.at(-1)!;
				try { await running; } finally { prompts.splice(prompts.indexOf(p), 1); }
				if (session.failed) { session.failed = false; throw new Error(MODEL_ERROR); }
			},
			steer: (text) => gate.steer(text),
			abort: () => gate.abort(),
			lastText: () => undefined,
			messages: () => transcripts.get(session.c)!,
			// child.ts takeQueued: what is left in Pi's queue.
			takeQueued: () => session.queue.splice(0),
			dispose: () => {
				if (!session.disposing) for (const p of mine(session)) p.disposed = true;
				session.disposing = true;
				return disposer();
			},
		};
	};

	team = new Team({
		maxConcurrent: 1, maxDepth: 2, replyTimeoutMs: 60_000, idleReleaseMs: 1e9,
		fallbackModels: [FALLBACK],
		deliverToMain: (delivery) => main.push(delivery),
		messagesFor: (record) => transcripts.get(record.name) ?? [],
		warn: () => undefined,
		launcher: {
			launch: (record: AgentRecord, hooks: ChildHooks) => new Promise<ChildHandle>((resolve, reject) => {
				pendingLaunches.push({ c: record.name, l: launchOf(record.name), resolve, reject, hooks });
			}),
		},
	});

	for (const c of CHILDREN) {
		const result = team.spawn({ name: c, task: `task ${c}`, parent: "main", model: PRIMARY, readOnly: false, fork: false, blocking: false });
		assert.ok(result.ok, !result.ok ? result.error : "");
		waiting.add(c);
		void team.whenDone(c).then(() => waiting.delete(c));
	}

	const heldOf = (c: string) => (team as any).sessions.get(c) as (ChildHandle & { session: FakeSession }) | undefined;
	/** A prompt as the model shows it. */
	const shown = (p: FakePrompt) => ({
		abortReq: p.phase === "active" ? p.loopAborted : p.phase === "steers" ? false : p.abortSeen,
		c: p.c, disposed: p.disposed, out: p.out, phase: p.phase, r: p.r, s: p.s,
	});
	const promptOf = (pick: any) => {
		const found = prompts.find((p) => JSON.stringify(shown(p)) === JSON.stringify(shown({ ...pick, abortSeen: pick.abortReq, loopAborted: pick.abortReq })));
		assert.ok(found, `the code has no prompt ${JSON.stringify(pick)}`);
		return found;
	};
	const sessionOf = (p: FakePrompt) => sessions.find((one) => one.c === p.c && one.l === p.s)!;
	// Pi's prompt() returns: the gate goes on, and an abort that waits resolves once no run is active
	// (waitForIdle, resolved at the end of _emitAgentSettled, agent-session.js:683-707).
	const promptReturns = (p: FakePrompt, outcome: string) => {
		p.phase = "steers";
		p.out = outcome;
		wakeAborts(sessionOf(p));
		p.resolve();
	};
	const say = (c: string, text: string) => transcripts.get(c)!.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
	const ids = (texts: readonly string[] | undefined, c: string) => (sent.get(c) ?? []).filter((id) => (texts ?? []).some((text) => text.includes(`<${id}>`)));
	const userTexts = (c: string) => transcripts.get(c)!.flatMap((m: any) => (m.role === "user" ? [m.content[0].text as string] : []));

	const actions: Record<string, (next: Record<string, any>) => void> = {
		launchDone(next) {
			const [c, l] = picked(next, "o");
			const at = pendingLaunches.findIndex((p) => p.c === c && p.l === l);
			assert.ok(at >= 0, `no launch of ${c} ${l} in flight`);
			const [launch] = pendingLaunches.splice(at, 1);
			const session: FakeSession = { c, l, disposing: false, piDisposed: false, listener: true, queue: [], hooks: launch!.hooks, aborts: [], steers: [], failed: false };
			sessions.push(session);
			launch!.resolve(handleFor(session));
		},
		launchFails(next) {
			const [c, l] = picked(next, "o");
			const at = pendingLaunches.findIndex((p) => p.c === c && p.l === l);
			assert.ok(at >= 0, `no launch of ${c} ${l} in flight`);
			const [launch] = pendingLaunches.splice(at, 1);
			launch!.reject(new Error(MODEL_ERROR));
		},
		// _startRun resets Pi's abort flag (agent-session.js:1423-1425).
		piPrepare(next) { const p = promptOf(picked(next, "p")); p.phase = "prep"; p.piAbort = false; },
		piAgentStart(next) {
			const p = promptOf(picked(next, "p"));
			// preflightResult("started") (agent-session.js:1442): the gate may abort again.
			p.started?.("started");
			if (p.piAbort && sessionOf(p).listener) promptReturns(p, "aborted");
			else { p.phase = "active"; p.loopAborted = false; }
		},
		piEnds(next) {
			const p = promptOf(picked(next, "p"));
			const outcome = picked(next, "out");
			const session = sessionOf(p);
			if (outcome === "error") session.failed = true;
			if (!session.piDisposed && outcome === "ok") say(p.c, `report from ${p.c}`);
			promptReturns(p, outcome);
		},
		steerLands(next) {
			const [c, s, id] = picked(next, "t");
			const session = sessions.find((one) => one.c === c && one.l === s)!;
			const at = session.steers.findIndex((one) => one.id === id);
			assert.ok(at >= 0, `no steer ${id} in flight in ${c}'s session ${s}`);
			session.steers.splice(at, 1)[0]!.land();
		},
		piReadsSteer(next) {
			const c = picked(next, "c");
			const session = heldOf(c)!.session;
			const inbox = team.get(c)?.inbox ?? [];
			// The model reads a message that was not copied to the inbox first.
			const at = Math.max(0, session.queue.findIndex((text) => !inbox.includes(text)));
			const [text] = session.queue.splice(at, 1);
			transcripts.get(c)!.push(user(text!));
			session.hooks.update({ activity: "thinking" });
		},
		stop(next) {
			const c = picked(next, "c");
			stopsMade += 1;
			const before = team.get(c)!.state;
			const live = ["queued", "starting", "running", "asking", "waiting"].includes(before);
			const held = heldOf(c)?.session.l ?? 0;
			const entry = { c, l: launchOf(c) + 1, s: held, done: false };
			void team.stop(c, picked(next, "byMain") ? { by: "main" } : {}).then((result) => {
				entry.done = true;
				if (result === undefined && live) refusedLive = true;
			});
			if (live || before === "interrupted") stops.push(entry);
		},
		message(next) {
			const c = picked(next, "c");
			msgs += 1;
			const id = `m${msgs}`;
			sent.get(c)!.push(id);
			void team.send("main", c, `<${id}>`);
		},
		idleRelease(next) {
			// sessions.ts:140-143, the quiet-spell timer.
			const c = picked(next, "c");
			if (team.get(c)?.state === "idle") void (team as any).sessions.release(c);
		},
	};

	/** The code's state in the model's shape. */
	function codeState() {
		const record = (c: string) => team.get(c)!;
		const per = <T,>(f: (c: string) => T) => Object.fromEntries(CHILDREN.map((c) => [c, f(c)]));
		const unread = (c: string) => stillUnread(record(c).unread ?? [], (team as any).sessions.runMessages(c));
		const resumeOf = (c: string) => (team as any).resumePrompts.prompts.get(c) as { message?: string } | undefined;
		const texts = (c: string) => [...userTexts(c)];
		const occurrences = (c: string) => (sent.get(c) ?? []).reduce((n, id) => n + texts(c).filter((t) => t.includes(`<${id}>`)).length, 0);
		const heldSession = (c: string) => heldOf(c)?.session;
		const inFlight = (c: string) => sessions.filter((one) => one.c === c).flatMap((one) => one.steers.map((steer) => steer.text));
		const lostOf = (c: string) => (sent.get(c) ?? []).filter((id) => {
			const tag = `<${id}>`;
			const places = [...texts(c), ...(record(c).inbox ?? []), resumeOf(c)?.message ?? "", ...(record(c).unread ?? []), ...(heldSession(c)?.queue ?? [])];
			return !places.some((text) => text.includes(tag));
		}).length;
		return {
			state: per((c) => record(c).state),
			launches: per(launchOf),
			ending: per((c) => (team as any).ending.get(c) ?? 0),
			byParent: per((c) => (team as any).stoppedByParent.get(c) ?? 0),
			line: [...(team as any).slots.line] as string[],
			goingOn: sorted([...(team as any).slots.goingOn.keys()] as string[]),
			opening: sorted(pendingLaunches.map((p) => [p.c, p.l])),
			held: per((c) => heldSession(c)?.l ?? 0),
			inbox: per((c) => ids(record(c).inbox, c).length),
			resume: per((c) => (resumeOf(c) ? ids(resumeOf(c)!.message ? [resumeOf(c)!.message!] : [], c).length : -1)),
			continuing: sorted([...(team as any).continuing.keys()] as string[]),
			fallbacksLeft: per((c) => 1 - (record(c).fallbacks?.length ?? 0)),
			prompts: sorted(prompts.map(shown)),
			stops: sorted(stops.filter((one) => !one.done).map((one) => [one.c, one.l, one.s])),
			// Unread steering that is in Pi's queue; a steer still in its input handlers is in flight.
			sq: per((c) => ids(unread(c).filter((text) => !inFlight(c).includes(text)), c).length),
			steersInFlight: per((c) => inFlight(c).length),
			sqCopy: per((c) => (heldSession(c)?.queue ?? []).filter((text) => !unread(c).includes(text)).length),
			sent: per((c) => sent.get(c)!.length),
			readPlusDup: per(occurrences),
			lost: CHILDREN.reduce((n, c) => n + lostOf(c), 0),
			reportsTotal: per((c) => main.filter((d) => d.kind === "report" && d.record.name === c).length),
			waiters: sorted([...waiting]),
			refusedLive,
			// team.ts:669-672 and sessions.ts:161-166: a session that is not held was disposed.
			stray: sessions.filter((one) => !one.disposing && heldSession(one.c) !== one).length,
			msgsLeft: 2 - msgs,
			stopsLeft: 2 - stopsMade,
		};
	}

	return { actions, codeState, team };
}

/** The model's state in the same shape. */
function modelState(state: Record<string, any>) {
	const w = state.w;
	const per = (f: (c: string) => any) => Object.fromEntries(CHILDREN.map((c) => [c, f(c)]));
	return {
		state: w.state, launches: w.launches, ending: w.ending, byParent: w.byParent, line: w.line, goingOn: sorted(w.goingOn),
		opening: sorted(w.opening), held: w.held, inbox: w.inbox, resume: w.resume, continuing: sorted(w.continuing),
		fallbacksLeft: w.fallbacksLeft, prompts: sorted(w.prompts.map((p: any) => ({ abortReq: p.abortReq, c: p.c, disposed: p.disposed, out: p.out, phase: p.phase, r: p.r, s: p.s }))), stops: sorted(w.stops), sq: w.sq, steersInFlight: per((c) => w.sp.filter((t: any) => t[0] === c).length), sqCopy: w.sqCopy,
		sent: w.sent, readPlusDup: per((c) => w.read[c] + w.dup[c]), lost: w.lost,
		reportsTotal: w.reportsTotal, waiters: sorted(w.waiters), refusedLive: w.refusedLive, stray: 0, msgsLeft: w.msgsLeft, stopsLeft: w.stopsLeft,
	};
}

/** Replay one trace; returns the code's final state. */
async function replay(trace: Itf, index: number) {
	const states = trace.states.map((s) => ({ ...plain(s), "mbt::actionTaken": s["mbt::actionTaken"], "mbt::nondetPicks": s["mbt::nondetPicks"] }));
	const world = makeWorld();
	await settle();
	assert.deepEqual(world.codeState(), modelState(states[0]!), `trace ${index}: initial state`);
	for (let i = 1; i < states.length; i++) {
		const action = states[i]!["mbt::actionTaken"];
		const run = world.actions[action];
		assert.ok(run, `trace ${index}: the replay has no mapping for action ${action}`);
		run(states[i]!);
		await settle();
		await settle();
		assert.deepEqual(world.codeState(), modelState(states[i]!), `trace ${index}, step ${i} (${action} ${JSON.stringify(states[i]!["mbt::nondetPicks"])}): the code and the model differ`);
	}
	return { steps: states.length - 1, final: world.codeState() };
}

test("the team's lifecycle code follows every step of the model traces", async () => {
	const traces = loadTraces();
	assert.ok(traces.length >= 200, `expected the committed traces, found ${traces.length}`);
	let steps = 0;
	for (const [index, trace] of traces.entries()) steps += (await replay(trace, index)).steps;
	assert.ok(steps > 2000, `expected over 2000 replayed steps, replayed ${steps}`);
});

// The paths of findings F1 to F5 (formal/subagents-lifecycle/README.md), where
// the code was wrong before the fix: each one has a witness trace, so a new
// trace set can't drop the path without this test failing.
const FINDING_PATHS: Array<[string, string]> = [
	["F1: a stop waits for a prompt in its pre window", "witnessNoStopInPre"],
	["F2: a dispose of a prompt before its agent loop", "witnessNoDisposedBeforeRun"],
	["F3 and F4: two stops of one child wait at the same time", "witnessNoTwoStops"],
	["F4: the newer of two stops is by the parent", "witnessNoParentStopOverStop"],
	["F4: the older stop goes on while the newer one waits", "witnessNoStaleStopOverStop"],
	["F4: the older stop goes on while a newer stop by the parent waits", "witnessNoStaleStopOverParentStop"],
	["F5: the prompt waits for a steer in flight", "witnessNoSteerWait"],
];
for (const [path, witness] of FINDING_PATHS) {
	test(`the code follows the model on the path of finding ${path}`, async () => {
		const traces = loadTraces();
		const index = traces.findIndex((t) => t["#meta"]?.witness === witness);
		assert.ok(index >= 0, `the traces hold no ${witness} witness; run fv.mjs traces`);
		assert.ok((await replay(traces[index]!, index)).steps > 0);
	});
}
