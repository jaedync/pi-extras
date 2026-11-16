import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ReloadGuard, errorLine, processReloadGuard } from "../lib/auto-update/reload-guard.ts";

interface Timer { at: number; fn: () => void; live: boolean }

function fake() {
	const target = new EventEmitter();
	const clock = { now: 0, timers: [] as Timer[] };
	const guard = new ReloadGuard(target, {
		now: () => clock.now,
		setOnce: (fn, ms) => {
			const timer = { at: clock.now + ms, fn, live: true };
			clock.timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
	});
	const advance = (ms: number) => {
		clock.now += ms;
		for (const timer of clock.timers.filter((t) => t.live && t.at <= clock.now)) {
			timer.live = false;
			timer.fn();
		}
	};
	const listeners = () => target.listenerCount("unhandledRejection");
	const reject = (reason: unknown) => target.emit("unhandledRejection", reason, Promise.resolve());
	return { guard, advance, listeners, reject };
}

test("arm adds one listener; a second arm extends the window and adds none", () => {
	const f = fake();
	assert.equal(f.listeners(), 0);
	f.guard.arm(1000, () => {});
	f.guard.arm(1000, () => {});
	assert.equal(f.listeners(), 1);
	f.advance(900);
	f.guard.arm(1000, () => {});
	f.advance(900);
	assert.equal(f.listeners(), 1, "the later arm moved the end of the window");
	f.advance(200);
	assert.equal(f.listeners(), 0, "after the window, Node's own handling is back");
	assert.equal(f.guard.armed, false);
});

test("a rejection in the window goes to the reporter and the log; a later reporter gets the ones before it", () => {
	const f = fake();
	const logs: string[] = [];
	const seen: string[] = [];
	f.guard.arm(1000, (line) => logs.push(line));
	f.reject(new TypeError("x is not a function"));
	assert.equal(seen.length, 0);
	f.guard.setReporter((text) => seen.push(text));
	assert.deepEqual(seen, ["TypeError: x is not a function"]);
	f.reject("plain reason");
	assert.deepEqual(seen, ["TypeError: x is not a function", "plain reason"]);
	assert.equal(logs.length, 2);
	assert.match(logs[0] ?? "", /unhandled rejection after the update reload: TypeError: x is not a function/);
	f.guard.setReporter(undefined);
	f.reject(new Error("later"));
	assert.equal(seen.length, 2, "a removed reporter gets nothing");
	f.guard.setReporter((text) => seen.push(text));
	assert.equal(seen.at(-1), "Error: later");
});

test("a reporter that throws does not end the listener", () => {
	const f = fake();
	const logs: string[] = [];
	f.guard.arm(1000, (line) => logs.push(line));
	f.guard.setReporter(() => {
		throw new Error("stale context");
	});
	assert.doesNotThrow(() => f.reject(new Error("boom")));
	assert.ok(logs.some((line) => line.includes("could not tell the user: Error: stale context")));
});

test("disarm removes the listener at once", () => {
	const f = fake();
	f.guard.arm(1000, () => {});
	f.guard.disarm();
	assert.equal(f.listeners(), 0);
	f.advance(2000);
	assert.equal(f.listeners(), 0);
});

test("errorLine: name and message on one line", () => {
	assert.equal(errorLine(new TypeError("a\nb")), "TypeError: a b");
	assert.equal(errorLine({ toString: () => "obj" }), "obj");
	assert.equal(errorLine(undefined), "undefined");
});

test("processReloadGuard is one object per process, kept across module loads", () => {
	assert.equal(processReloadGuard(), processReloadGuard());
});

/**
 * Events in random order: the listener exists exactly while a window is open; each rejection in a window reaches a
 * reporter once and in order, unless the window closed while no reporter was set (then only the log has it).
 */
test("random orders of arm, reject, reporter and time keep the invariants", () => {
	for (let seed = 1; seed <= 300; seed++) {
		let s = seed;
		const rand = (n: number) => {
			s = (s * 1103515245 + 12345) % 2 ** 31;
			return s % n;
		};
		const f = fake();
		let until = -1;
		let now = 0;
		let caught = 0;
		const seen: string[] = [];
		const expected: string[] = [];
		let waiting: string[] = [];
		let reporter = false;
		for (let step = 0; step < 40; step++) {
			const event = rand(5);
			if (event === 0) {
				f.guard.arm(500, () => {});
				until = now + 500;
			} else if (event === 1) {
				const open = now < until;
				if (open) {
					caught++;
					f.reject(new Error(`e${caught}`));
					(reporter ? expected : waiting).push(`Error: e${caught}`);
				}
			} else if (event === 2) {
				reporter = !reporter;
				f.guard.setReporter(reporter ? (text) => seen.push(text) : undefined);
				if (reporter) {
					expected.push(...waiting);
					waiting = [];
				}
			} else {
				const ms = rand(400);
				if (now < until && now + ms >= until) waiting = [];
				now += ms;
				f.advance(ms);
			}
			assert.equal(f.listeners(), now < until ? 1 : 0, `seed ${seed} step ${step}: listener while open only`);
		}
		f.guard.setReporter((text) => seen.push(text));
		expected.push(...waiting);
		assert.deepEqual(seen, expected, `seed ${seed}: each once, in order`);
		f.guard.disarm();
	}
});

test("disarm drops errors that no reporter took: the log has them, and a later session must not show them as new (review 6)", () => {
	const f = fake();
	const seen: string[] = [];
	f.guard.arm(1000, () => {});
	f.reject(new Error("old"));
	f.advance(1000);
	f.guard.setReporter((text) => seen.push(text));
	assert.equal(seen.length, 0);
});
