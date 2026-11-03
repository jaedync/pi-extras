import assert from "node:assert/strict";
import { test } from "node:test";
import { dropOldResumes, LOCAL_RESUME_TYPE, LocalIdleWait, openWait, RESTORE_MAX_AGE_MS, resumeText, type LocalWaitEntry } from "../lib/rate-limit-recovery/idle-wait.ts";
import { FALLBACK_RESEND_MS } from "../lib/rate-limit-recovery/local.ts";

function fixture(answers: boolean[] = [true], fault: "ui" | "tick" | undefined = undefined) {
	let clock = 1_000_000;
	const records: LocalWaitEntry[] = [];
	const resumed: string[] = [];
	const ended: string[] = [];
	const lines: string[] = [];
	let cancelFromUi: (() => void) | undefined;
	let release: (() => void) | undefined;
	let held = false;
	const idle = new LocalIdleWait({
		resume: (content) => resumed.push(content),
		record: (entry) => records.push(entry),
		probe: async () => answers.shift() ?? true,
		// The real wait calls tick on each second, and a throw there rejects the wait.
		wait: async (ms, signal, tick) => {
			tick?.();
			if (held) await new Promise<void>((resolve) => { release = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
			if (signal.aborted) return false;
			clock += ms;
			return true;
		},
		now: () => clock,
		ui: (_ctx, who, since, cancel) => {
			if (fault === "ui") throw new Error("synthetic UI failure");
			cancelFromUi = cancel; lines.push(`${who} since ${since}`);
			return { tick() { if (fault === "tick") throw new Error("synthetic tick failure"); }, close() { lines.push("closed"); } };
		},
		ended: (who, end) => ended.push(`${who}:${end}`),
	});
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	return { idle, records, resumed, ended, lines, settle, hold: () => { held = true; }, release: () => release?.(), esc: () => cancelFromUi?.(), now: () => clock };
}
const ctx = {} as never;
const WAIT = { who: "fw01/qwen", baseUrl: "http://fw01:8000/v1", delayMs: 5_000, sinceMs: 900_000 };

test("the wait records an open entry, checks the server while idle, and starts the run again when it answers", async () => {
	const f = fixture([false, false, true]);
	f.idle.start(ctx, WAIT);
	assert.equal(f.records[0].state, "open", "the entry is written first, so a reload finds it");
	assert.equal(f.idle.waiting, true);
	for (let i = 0; i < 10 && !f.resumed.length; i++) await f.settle();
	assert.deepEqual(f.resumed, [resumeText("fw01/qwen")]);
	assert.deepEqual(f.ended, ["fw01/qwen:answered"]);
	assert.equal(f.records.at(-1)!.state, "closed");
	assert.equal(f.records.at(-1)!.end, "answered");
	assert.deepEqual(f.lines, ["fw01/qwen since 900000", "closed"]);
	assert.equal(f.idle.waiting, false);
});

test("Esc ends the wait: no run starts, and the entry is closed", async () => {
	const f = fixture();
	f.hold();
	f.idle.start(ctx, WAIT);
	await f.settle();
	f.esc();
	for (let i = 0; i < 5; i++) await f.settle();
	assert.deepEqual(f.resumed, []);
	assert.equal(f.records.at(-1)!.end, "cancelled");
	assert.equal(f.idle.waiting, false);
});

test("a stop (reload or shutdown) leaves the entry open for the next module and starts nothing", async () => {
	const f = fixture();
	f.hold();
	f.idle.start(ctx, WAIT);
	await f.settle();
	f.idle.stop();
	for (let i = 0; i < 5; i++) await f.settle();
	assert.deepEqual(f.resumed, []);
	assert.deepEqual(f.records.map((r) => r.state), ["open"]);
});

test("a restored wait checks at once and resumes; an old, closed or foreign entry is not restored", async () => {
	const f = fixture([true]);
	const open: LocalWaitEntry = { kind: "local-wait", state: "open", who: "fw01/qwen", baseUrl: "http://fw01:8000/v1", sinceMs: 1, at: f.now() - 60_000 };
	const entry = (data: unknown, customType = "rate-limit-recovery") => ({ type: "custom", customType, data });
	assert.deepEqual(openWait([entry(open)], "rate-limit-recovery", f.now()), open);
	assert.equal(openWait([entry(open), entry({ ...open, state: "closed" })], "rate-limit-recovery", f.now()), undefined);
	assert.equal(openWait([entry({ ...open, at: f.now() - RESTORE_MAX_AGE_MS })], "rate-limit-recovery", f.now()), undefined);
	assert.equal(openWait([entry(open, "other")], "rate-limit-recovery", f.now()), undefined);
	// Other kinds of entry of the same type do not hide the wait.
	assert.deepEqual(openWait([entry(open), entry({ kind: "connection-failure" })], "rate-limit-recovery", f.now()), open);
	f.idle.restore(ctx, open);
	for (let i = 0; i < 10 && !f.resumed.length; i++) await f.settle();
	assert.equal(f.resumed.length, 1);
});

test("a check that never answers still starts the run after the fallback time", async () => {
	const f = fixture(Array(200).fill(false));
	f.idle.start(ctx, WAIT);
	for (let i = 0; i < 400 && !f.resumed.length; i++) await f.settle();
	assert.equal(f.resumed.length, 1);
	assert.match(f.resumed[0], /still does not answer after 10 min/, "the text must not claim that the server answers");
	assert.doesNotMatch(f.resumed[0], /answers again/);
	assert.deepEqual(f.ended, ["fw01/qwen:timer"]);
	assert.ok(f.now() - 1_000_000 >= FALLBACK_RESEND_MS);
});

test("a second start replaces the first wait, which then starts nothing", async () => {
	const f = fixture();
	f.hold();
	f.idle.start(ctx, WAIT);
	await f.settle();
	f.idle.start(ctx, { ...WAIT, who: "fw01/other" });
	f.release();
	for (let i = 0; i < 10; i++) { f.release(); await f.settle(); }
	assert.ok(f.resumed.every((text) => text.includes("fw01/other")));
});

test("a restored wait writes a fresh open entry, so a long outage with reloads stays under the age limit", async () => {
	const f = fixture([false, true]);
	const old: LocalWaitEntry = { kind: "local-wait", state: "open", who: "fw01/qwen", baseUrl: "http://fw01:8000/v1", sinceMs: 1, at: f.now() - 47 * 3600_000 };
	f.idle.restore(ctx, old);
	assert.equal(f.records[0].state, "open");
	assert.equal(f.records[0].at, f.now());
	assert.equal(f.records[0].sinceMs, 1, "the outage clock goes on");
});

test("a stop for a shutdown writes the stop time; a plain stop writes nothing", async () => {
	const f = fixture();
	f.hold();
	f.idle.start(ctx, WAIT);
	await f.settle();
	f.idle.stop(true);
	assert.deepEqual(f.records.map((r) => r.state), ["open", "open"]);
	assert.equal(f.records[1].at, f.now());
	f.idle.stop(true);
	assert.equal(f.records.length, 2, "no wait, no entry");
});

for (const fault of ["ui", "tick"] as const) {
	test(`a failure of the live line (${fault}) does not stop the wait: the run still starts again`, async () => {
		const f = fixture([false, false, true], fault);
		f.idle.start(ctx, WAIT);
		for (let i = 0; i < 20 && !f.resumed.length; i++) await f.settle();
		assert.deepEqual(f.resumed, [resumeText("fw01/qwen")]);
		assert.equal(f.records.at(-1)!.state, "closed");
	});
}

test("only the last resume message stays in the model's context", () => {
	const resume = (n: number) => ({ role: "custom", customType: LOCAL_RESUME_TYPE, content: `r${n}` });
	const user = { role: "user", content: "task" };
	const other = { role: "custom", customType: "other", content: "x" };
	assert.equal(dropOldResumes([user, resume(1), other]), undefined, "one resume: nothing to drop");
	assert.equal(dropOldResumes([user, other]), undefined);
	assert.deepEqual(dropOldResumes([user, resume(1), other, resume(2), resume(3)]), [user, other, resume(3)]);
});
