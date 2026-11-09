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
 * The child's Pi session is a fake that follows the model's Pi rules: an abort
 * in the pre-run window is lost, an abort in _prepareRun stops the prompt at
 * agent_start unless dispose came first, and dispose stops only an active
 * loop. The replay does not check those rules against Pi:
 * formal/subagents-lifecycle/probe-pi-abort.mts does that in a real
 * AgentSession. The quiet-spell timer of sessions.ts:140-143 is called by hand.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { Team } from "../lib/subagents/team.ts";
import { stillUnread } from "../lib/subagents/mailbox.ts";
import type { AgentRecord, ChildHandle, ChildHooks, MainDelivery } from "../lib/subagents/types.ts";

const TRACES = new URL("../formal/subagents-lifecycle/traces.itf.jsonl.gz", import.meta.url);
const CHILDREN = ["c1", "c2"];
const PRIMARY = "openai/gpt-primary";
const FALLBACK = "anthropic/claude-fallback";
// planFallback (fallback.ts) takes this as a provider failure that a fallback model can serve.
const MODEL_ERROR = "503 service unavailable";

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

interface FakePrompt { c: string; s: number; r: number; phase: string; abortReq: boolean; disposed: boolean; resolve(): void; reject(error: Error): void }
interface FakeSession { c: string; l: number; disposed: boolean; queue: string[]; hooks: ChildHooks; aborts: Array<() => void> }

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

	const handleFor = (session: FakeSession): ChildHandle & { session: FakeSession } => ({
		session,
		// child.ts:697-709: a prompt that ends with an error reply throws.
		prompt: (text) => new Promise<void>((resolve, reject) => {
			if (!session.disposed) transcripts.get(session.c)!.push(user(text));
			prompts.push({ c: session.c, s: session.l, r: launchOf(session.c), phase: "pre", abortReq: false, disposed: session.disposed, resolve, reject });
		}),
		// child.ts:710-714: session.steer puts it in Pi's queue.
		steer: (text) => { session.queue.push(text); },
		// AgentSession.abort (agent-session.js:1971-1989): no effect in the pre-run window; it resolves when no run is active.
		abort: () => {
			const mine = prompts.filter((p) => p.c === session.c && p.s === session.l);
			for (const p of mine) if (p.phase !== "pre") p.abortReq = true;
			if (mine.every((p) => p.phase === "pre")) return Promise.resolve();
			return new Promise<void>((resolve) => session.aborts.push(resolve));
		},
		lastText: () => undefined,
		messages: () => transcripts.get(session.c)!,
		// child.ts:719-725: what is left in Pi's queue.
		takeQueued: () => session.queue.splice(0),
		// child.ts:654-672 and AgentSession.dispose (agent-session.js:1011-1030): agent.abort() stops only an active loop.
		dispose: async () => {
			session.disposed = true;
			session.queue.splice(0);
			for (const p of prompts) {
				if (p.c !== session.c || p.s !== session.l) continue;
				p.disposed = true;
				if (p.phase === "active") p.abortReq = true;
			}
		},
	});

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
	const promptOf = (pick: any) => {
		const found = prompts.find((p) => p.c === pick.c && p.s === pick.s && p.r === pick.r && p.phase === pick.phase && p.abortReq === pick.abortReq && p.disposed === pick.disposed);
		assert.ok(found, `the code has no prompt ${JSON.stringify(pick)}`);
		return found;
	};
	// A prompt that ends: an abort that waits for this session resolves once no run is active there
	// (waitForIdle, resolved at the end of _emitAgentSettled, agent-session.js:683-707).
	const removePrompt = (p: FakePrompt) => {
		prompts.splice(prompts.indexOf(p), 1);
		const session = sessions.find((one) => one.c === p.c && one.l === p.s)!;
		if (prompts.some((other) => other.c === p.c && other.s === p.s && other.phase !== "pre")) return;
		for (const resolve of session.aborts.splice(0)) resolve();
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
			const session: FakeSession = { c, l, disposed: false, queue: [], hooks: launch!.hooks, aborts: [] };
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
		piPrepare(next) { promptOf(picked(next, "p")).phase = "prep"; },
		piAgentStart(next) {
			const p = promptOf(picked(next, "p"));
			if (p.abortReq && !p.disposed) { removePrompt(p); p.resolve(); }
			else { p.phase = "active"; p.abortReq = false; }
		},
		piEnds(next) {
			const p = promptOf(picked(next, "p"));
			const outcome = picked(next, "out");
			removePrompt(p);
			if (outcome === "error") return p.reject(new Error(MODEL_ERROR));
			if (!p.disposed && outcome === "ok") say(p.c, `report from ${p.c}`);
			p.resolve();
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
			const ending = (team as any).ending.has(c);
			void team.stop(c).then((result) => {
				entry.done = true;
				if (result === undefined && live) refusedLive = true;
			});
			if (!ending && (live || before === "interrupted")) stops.push(entry);
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
		const lostOf = (c: string) => (sent.get(c) ?? []).filter((id) => {
			const tag = `<${id}>`;
			const places = [...texts(c), ...(record(c).inbox ?? []), resumeOf(c)?.message ?? "", ...(record(c).unread ?? []), ...(heldSession(c)?.queue ?? [])];
			return !places.some((text) => text.includes(tag));
		}).length;
		return {
			state: per((c) => record(c).state),
			launches: per(launchOf),
			ending: sorted([...(team as any).ending] as string[]),
			line: [...(team as any).slots.line] as string[],
			goingOn: sorted([...(team as any).slots.goingOn.keys()] as string[]),
			opening: sorted(pendingLaunches.map((p) => [p.c, p.l])),
			held: per((c) => heldSession(c)?.l ?? 0),
			inbox: per((c) => ids(record(c).inbox, c).length),
			resume: per((c) => (resumeOf(c) ? ids(resumeOf(c)!.message ? [resumeOf(c)!.message!] : [], c).length : -1)),
			continuing: sorted([...(team as any).continuing.keys()] as string[]),
			fallbacksLeft: per((c) => 1 - (record(c).fallbacks?.length ?? 0)),
			prompts: sorted(prompts.map(({ c, s, r, phase, abortReq, disposed }) => ({ abortReq, c, disposed, phase, r, s }))),
			stops: sorted(stops.filter((one) => !one.done).map((one) => [one.c, one.l, one.s])),
			sq: per((c) => ids(unread(c), c).length),
			sqCopy: per((c) => (heldSession(c)?.queue ?? []).filter((text) => !unread(c).includes(text)).length),
			sent: per((c) => sent.get(c)!.length),
			readPlusDup: per(occurrences),
			lost: CHILDREN.reduce((n, c) => n + lostOf(c), 0),
			reportsTotal: per((c) => main.filter((d) => d.kind === "report" && d.record.name === c).length),
			waiters: sorted([...waiting]),
			refusedLive,
			// team.ts:669-672 and sessions.ts:161-166: a session that is not held was disposed.
			stray: sessions.filter((one) => !one.disposed && heldSession(one.c) !== one).length,
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
		state: w.state, launches: w.launches, ending: sorted(w.ending), line: w.line, goingOn: sorted(w.goingOn),
		opening: sorted(w.opening), held: w.held, inbox: w.inbox, resume: w.resume, continuing: sorted(w.continuing),
		fallbacksLeft: w.fallbacksLeft, prompts: sorted(w.prompts), stops: sorted(w.stops), sq: w.sq, sqCopy: w.sqCopy,
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

// Findings F1 and F3 in formal/subagents-lifecycle/README.md. These tests show
// that the code takes each step of the model's path; they are not wishes.
// When the code is fixed, the model and these tests change with it.
test("finding F1: the code follows the model's path to a stopped child whose prompt still runs", async () => {
	const traces = loadTraces();
	const index = traces.findIndex((t) => t["#meta"]?.witness === "stopMeansStopped");
	assert.ok(index >= 0, "the traces hold no stopMeansStopped witness; run fv.mjs traces");
	const { final } = await replay(traces[index]!, index);
	assert.ok(final.prompts.some((p: any) => p.phase === "pre" && p.disposed), "the replay did not end with a disposed prompt that still runs");
});

test("finding F3: the code follows the model's path to a refused stop of a working child", async () => {
	const traces = loadTraces();
	const index = traces.findIndex((t) => t["#meta"]?.witness === "stopHonored");
	assert.ok(index >= 0, "the traces hold no stopHonored witness; run fv.mjs traces");
	const { final } = await replay(traces[index]!, index);
	assert.equal(final.refusedLive, true);
});
