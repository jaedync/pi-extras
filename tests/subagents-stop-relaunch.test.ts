/**
 * Stops whose abort waits while a message relaunches the child: findings F3
 * and F4 of formal/subagents-lifecycle/README.md (repro-f3.mts, repro-f4.mts,
 * repro-f4-byparent.mts), on fake sessions whose abort ends when the test says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import type { ChildHandle, MainDelivery } from "../lib/subagents/types.ts";

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await tick(); };

/** A team of one child "kid"; each launch's prompt runs until `end(launch)`, and its abort waits for `endAbort(launch)`. */
function stopTeam() {
	const main: MainDelivery[] = [];
	const sessions: Array<{ end(): void; endAbort(): void }> = [];
	const team = new Team({
		maxConcurrent: 1, maxDepth: 2, replyTimeoutMs: 60_000, idleReleaseMs: 1e9, deliverToMain: (delivery) => main.push(delivery),
		launcher: {
			async launch(): Promise<ChildHandle> {
				const transcript: unknown[] = [];
				let endPrompt: (() => void) | undefined;
				let aborting: Promise<void> | undefined;
				const session = {
					end: () => { transcript.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }); endPrompt?.(); },
					endAbort: () => undefined as void,
				};
				sessions.push(session);
				return {
					prompt: (text) => { transcript.push({ role: "user", content: [{ type: "text", text }] }); return new Promise<void>((resolve) => { endPrompt = resolve; }); },
					steer: () => undefined,
					// Pi's abort waits for the loop to wind down: here, until the test ends it (an agent_end handler that awaits I/O).
					abort: () => aborting ??= new Promise<void>((resolve) => { session.endAbort = () => { endPrompt?.(); resolve(); }; }),
					lastText: () => undefined, messages: () => transcript, takeQueued: () => [], dispose: async () => undefined,
				};
			},
		},
	});
	assert.ok(team.spawn({ name: "kid", task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false }).ok);
	const reports = () => main.flatMap((delivery) => (delivery.kind === "report" ? [delivery.record.state] : []));
	return { team, sessions, reports };
}

test("a second stop of a child that a message relaunched during the first stop's abort stops it (F3)", async () => {
	const { team, sessions, reports } = stopTeam();
	await flush();
	const first = team.stop("kid");
	await flush();
	assert.equal((await team.send("main", "kid", "Go on.")).ok, true);
	await flush();
	assert.equal(team.get("kid")!.state, "running", "the message relaunched it in a new session");
	const second = team.stop("kid");
	assert.equal(team.get("kid")!.state, "stopped", "the second stop is not refused");
	sessions[1]!.endAbort();
	assert.equal((await second)?.state, "stopped");
	sessions[0]!.endAbort();
	await first;
	await flush();
	assert.equal(team.get("kid")!.state, "stopped");
	assert.deepEqual(reports(), ["stopped"], "the second stop reports once; the first one's run was taken over");
});

/** Stop 1 waits on session 1; a message relaunches the child into session 2, whose run ends idle; a second message runs it again. */
async function relaunchedTwice(firstBy: string | undefined) {
	const world = stopTeam();
	const { team, sessions } = world;
	await flush();
	const first = team.stop("kid", firstBy ? { by: firstBy } : {});
	await flush();
	assert.equal((await team.send("main", "kid", "Go on.")).ok, true);
	await flush();
	sessions[1]!.end();
	await flush();
	assert.equal(team.get("kid")!.state, "idle");
	assert.equal((await team.send("main", "kid", "One more thing.")).ok, true);
	await flush();
	assert.equal(team.get("kid")!.state, "running");
	return { ...world, first };
}

test("an old stop whose abort ends late leaves the newer stop's ending mark: the team still says a stop is under way (F4)", async () => {
	const { team, sessions, reports, first } = await relaunchedTwice(undefined);
	const second = team.stop("kid");
	await flush();
	sessions[0]!.endAbort();
	await first;
	await flush();
	assert.equal(team.stopping(), true, "stop 2 still aborts the child, and its report is not up yet");
	assert.equal(team.quiet(), false);
	sessions[1]!.endAbort();
	await second;
	await flush();
	assert.equal(team.stopping(), false);
	assert.deepEqual(reports(), ["idle", "stopped"]);
});

test("an old stop whose abort ends late leaves the newer stop by the parent silent (F4)", async () => {
	const { team, sessions, reports, first } = await relaunchedTwice(undefined);
	const second = team.stop("kid", { by: "main" });
	await flush();
	sessions[0]!.endAbort();
	await first;
	sessions[1]!.endAbort();
	await second;
	await flush();
	assert.equal(team.get("kid")!.state, "stopped");
	assert.deepEqual(reports(), ["idle"], "main stopped it and has the record; no stopped report goes up");
});

test("a run that a message started during a stop by the parent reports when it ends (F4)", async () => {
	const { sessions, reports, first } = await relaunchedTwice("main");
	assert.deepEqual(reports(), ["idle"], "the relaunched run's report is news to main, though main stopped the run before it");
	sessions[1]!.end();
	await flush();
	sessions[0]!.endAbort();
	await first;
	await flush();
	assert.deepEqual(reports(), ["idle", "idle"]);
});
