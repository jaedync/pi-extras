/**
 * The virtual clock that frame-exact capture installs in the page: app time
 * moves only when the capture advances it, one frame per captured frame.
 * Tested on a plain object that stands in for window.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { advancePageClock, installVirtualClock } from "../skills/walkthrough-video/scripts/lib/vclock.mjs";

function fakeWindow() {
	return { Date, performance: { now: () => 123456 } };
}

/** A window with a sessionStorage that survives a same-origin navigation, as a browser's does. */
function sharedStorage() {
	const data = new Map();
	return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key) };
}

test("a document installed with a start time reads it at load, not 0", async () => {
	const win = fakeWindow();
	const before = { now: win.performance.now(), date: win.Date.now() };
	// The capture's install script carries the time of the last advance.
	const clock = installVirtualClock(win, 1_000_000, { startNow: 5250 });
	assert.equal(win.performance.now(), 5250, `a load-time performance.now() is the capture time, not 0 (was ${before.now})`);
	assert.equal(win.Date.now(), 1_005_250, "and Date.now is the capture time, not the epoch");
	const fired = [];
	win.setTimeout(() => fired.push({ now: win.performance.now(), date: win.Date.now() }), 300);
	await clock.advanceTo(5300, 5250);
	assert.deepEqual(fired, [], "the load timer is not due yet");
	await clock.advanceTo(5550, 5400);
	assert.deepEqual(fired, [{ now: 5550, date: 1_005_550 }], "the timer fires 300 ms after the document loaded");
	assert.ok(clock.now() >= 5250, "the clock never goes back");
});

test("the install script carries the start time, and a document that starts with none rebases", async () => {
	const { virtualClockScript } = await import("../skills/walkthrough-video/scripts/lib/vclock.mjs");
	assert.match(virtualClockScript(1_000_000, 5250), /startNow: 5250/);
	assert.match(virtualClockScript(1_000_000), /startNow: 0/);
	const win = fakeWindow();
	const clock = installVirtualClock(win, 1_000_000);
	assert.equal(win.performance.now(), 0, "no start time: the document's own clock starts at 0");
	const fired = [];
	win.setTimeout(() => fired.push(win.performance.now()), 300);
	await clock.advanceTo(5000, 5000);
	await clock.advanceTo(5300, 5250);
	assert.deepEqual(fired, [5300], "the first-advance rebase still puts the load timer at its offset");
});

test("the clock writes no app storage: the capture controller owns the start time", async () => {
	const written = [];
	const win = fakeWindow();
	win.sessionStorage = { removeItem: () => {}, setItem: (key) => written.push(key), getItem: () => { throw new Error("not read"); } };
	const clock = installVirtualClock(win, 1_000_000, { startNow: 250 });
	await clock.advanceTo(500);
	assert.deepEqual(written, [], "an app that clears or replaces its storage cannot move the clock");
	assert.equal(win.performance.now(), 500);
});

test("time stands still until the capture advances it", async () => {
	const win = fakeWindow();
	const clock = installVirtualClock(win, 1_000_000);
	assert.equal(win.performance.now(), 0);
	assert.equal(win.Date.now(), 1_000_000);
	assert.equal(new win.Date().getTime(), 1_000_000);
	assert.equal(new win.Date(5).getTime(), 5);
	await clock.advanceTo(1000 / 60);
	assert.equal(win.performance.now(), 1000 / 60);
	assert.equal(win.Date.now(), 1_000_000 + 1000 / 60);
	assert.ok(new win.Date() instanceof Date);
});

test("the clock installs only in the top frame: a child frame keeps real time", () => {
	const top = fakeWindow();
	top.top = top;
	const main = installVirtualClock(top, 1_000_000);
	assert.ok(main, "the top frame gets the clock");
	const child = fakeWindow();
	child.top = top;
	const childDate = child.Date;
	assert.equal(installVirtualClock(child, 1_000_000), undefined, "a child frame gets no clock");
	assert.equal(child.Date, childDate, "a child frame keeps the real Date");
	assert.equal(child.__wvClock, undefined);
	assert.equal(child.performance.now(), 123456, "and real time");
	assert.equal(top.top, top, "a window is its own top");
});

test("a document that loads at capture time 5000 runs its load timers at their real offset, not all at once", async () => {
	const win = fakeWindow();
	const clock = installVirtualClock(win, 1_000_000);
	const fired = [];
	// The document's own script, run at load: one timer 300 ms out, one animation frame.
	win.setTimeout(() => fired.push(["timer", win.performance.now(), win.Date.now()]), 300);
	win.requestAnimationFrame(() => fired.push(["raf", win.performance.now()]));
	// The pump advances: the document became visible at 5000, so the clock starts there.
	await clock.advanceTo(5000, 5000);
	assert.deepEqual(fired.map(([what]) => what), ["raf"], "the first advance draws the document, and the 300 ms timer is not due yet");
	await clock.advanceTo(5300, 5250);
	assert.deepEqual(fired, [["raf", 5000], ["timer", 5300, 1_005_300]], "the timer fires 300 ms after the document's start, and Date.now continues from the old document");
	await clock.advanceTo(5400, 5300);
	assert.equal(win.Date.now(), 1_005_400, "Date.now never goes back");
});

test("a page between documents asks the clock to rebase from the previous frame's time", async () => {
	const calls = [];
	const cdp = { send: async (method, params) => calls.push([method, params.expression]) };
	await advancePageClock(cdp, 5016.7, 5000);
	assert.equal(calls[0][0], "Runtime.evaluate");
	assert.match(calls[0][1], /advanceTo\(5016\.7, 5000\)/);
});

test("a clock that never answers is a timeout error, and a page between documents is skipped", async () => {
	const silent = { send: () => new Promise(() => {}) };
	await assert.rejects(() => advancePageClock(silent, 100, 83.3, { timeoutMs: 50 }), /did not answer/);
	const navigating = { send: async () => { throw new Error("Execution context was destroyed, most likely because of a navigation"); } };
	assert.equal(await advancePageClock(navigating, 100, 83.3), undefined, "a navigation is not an error");
	const broken = { send: async () => { throw new Error("Runtime.evaluate: Cannot read properties of undefined"); } };
	await assert.rejects(() => advancePageClock(broken, 100, 83.3), /Cannot read properties of undefined/);
});

test("one animation frame per advance, with the frame time as its timestamp", async () => {
	const win = fakeWindow();
	const clock = installVirtualClock(win, 0);
	const stamps = [];
	const loop = (t) => {
		stamps.push(t);
		win.requestAnimationFrame(loop);
	};
	win.requestAnimationFrame(loop);
	for (let i = 1; i <= 120; i++) await clock.advanceTo((i * 1000) / 60);
	assert.equal(stamps.length, 120);
	assert.deepEqual(stamps.slice(0, 3), [1000 / 60, 2000 / 60, 3000 / 60]);
	const id = win.requestAnimationFrame(() => assert.fail("cancelled"));
	win.cancelAnimationFrame(id);
	await clock.advanceTo(121 * (1000 / 60));
});

test("timers fire in time order at their own time, and intervals repeat", async () => {
	const win = fakeWindow();
	const clock = installVirtualClock(win, 0);
	const log = [];
	win.setTimeout(() => log.push(["b", win.performance.now()]), 30);
	win.setTimeout(() => log.push(["a", win.performance.now()]), 10);
	const iv = win.setInterval(() => log.push(["i", win.performance.now()]), 20);
	const gone = win.setTimeout(() => log.push(["x"]), 5);
	win.clearTimeout(gone);
	await clock.advanceTo(50);
	win.clearInterval(iv);
	await clock.advanceTo(100);
	assert.deepEqual(log, [["a", 10], ["i", 20], ["b", 30], ["i", 40]]);
});

test("a timer set by a timer inside the same advance still fires on time", async () => {
	const win = fakeWindow();
	const clock = installVirtualClock(win, 0);
	const log = [];
	win.setTimeout(() => {
		log.push(win.performance.now());
		Promise.resolve().then(() => win.setTimeout(() => log.push(win.performance.now()), 5));
	}, 4);
	await clock.advanceTo(16);
	assert.deepEqual(log, [4, 9]);
});

test("an error in one callback does not stop the clock", async () => {
	const win = fakeWindow();
	const errors = [];
	const clock = installVirtualClock(win, 0, { onError: (e) => errors.push(e.message) });
	let later = false;
	win.setTimeout(() => {
		throw new Error("app bug");
	}, 1);
	win.setTimeout(() => {
		later = true;
	}, 2);
	await clock.advanceTo(10);
	assert.equal(later, true);
	assert.deepEqual(errors, ["app bug"]);
});

/** A minimal Web Animations stand-in: a running animation keeps its own (wall) time unless paused. */
function fakeAnimationWindow() {
	class Animation {
		constructor(end = Infinity) {
			this.playState = "running";
			this.playbackRate = 1;
			this._t = 0;
			this.end = end;
			this.finished = false;
			this.effect = { getComputedTiming: () => ({ endTime: this.end }) };
		}
		get currentTime() {
			return this._t;
		}
		set currentTime(v) {
			this._t = v;
		}
		pause() {
			this.playState = "paused";
		}
		play() {
			this.playState = "running";
		}
		finish() {
			this._t = this.end;
			this.playState = "finished";
			this.finished = true;
		}
	}
	const list = [];
	return { win: { Date, performance: { now: () => 0 }, Animation, document: { getAnimations: () => list.filter((a) => a.playState !== "idle") } }, Animation, list };
}

test("a chain of zero-delay timers is clamped to 4 ms after five levels, as a browser does", async () => {
	const win = fakeWindow();
	const clock = installVirtualClock(win, 0);
	const times = [];
	const tick = () => {
		times.push(win.performance.now());
		if (times.length < 9) win.setTimeout(tick, 0);
	};
	win.setTimeout(tick, 0);
	await clock.advanceTo(1000);
	// Nesting levels 0 to 5 run at once; the next level is clamped to 4 ms, then 4 ms more each time.
	assert.deepEqual(times, [0, 0, 0, 0, 0, 0, 4, 8, 12]);
	// A timer with a longer delay keeps it, however deep the chain.
	const late = [];
	const chain = (n) => {
		if (n === 0) return;
		win.setTimeout(() => {
			late.push(win.performance.now());
			chain(n - 1);
		}, 10);
	};
	chain(8);
	await clock.advanceTo(1100);
	assert.deepEqual(late, [1000 + 10 * 1, 1000 + 10 * 2, 1000 + 10 * 3, 1000 + 10 * 4, 1000 + 10 * 5, 1000 + 10 * 6, 1000 + 10 * 7, 1000 + 10 * 8]);
});

test("CSS and Web Animations move on frame time, and finish on time", async () => {
	const { win, Animation, list } = fakeAnimationWindow();
	const clock = installVirtualClock(win, 0);
	const spin = new Animation();
	spin._t = 40; // it ran 40 ms of wall time before the capture saw it
	list.push(spin);
	await clock.advanceTo(10);
	assert.equal(spin.playState, "paused");
	assert.equal(spin.currentTime, 40);
	await clock.advanceTo(30);
	assert.equal(spin.currentTime, 60);
	const fade = new Animation(25);
	list.push(fade);
	await clock.advanceTo(50);
	assert.equal(fade.currentTime, 0, "a new animation starts at the frame it appears in");
	assert.equal(spin.currentTime, 80);
	await clock.advanceTo(80);
	assert.equal(fade.finished, true, "it finishes, so animationend still fires");
	spin.playbackRate = 2;
	await clock.advanceTo(90);
	assert.equal(spin.currentTime, 130);
});

test("the app keeps control of the animations it pauses, seeks or plays", async () => {
	const { win, Animation, list } = fakeAnimationWindow();
	const clock = installVirtualClock(win, 0);
	const a = new Animation();
	list.push(a);
	await clock.advanceTo(10);
	a.pause();
	await clock.advanceTo(20);
	assert.equal(a.currentTime, 0, "an animation that the app paused stays paused");
	a.currentTime = 500;
	a.play();
	await clock.advanceTo(30);
	assert.equal(a.currentTime, 500);
	await clock.advanceTo(40);
	assert.equal(a.currentTime, 510);
	a.currentTime = 100;
	await clock.advanceTo(50);
	assert.equal(a.currentTime, 110, "a seek by the app moves the base");
});

test("a second install script in the same document moves the start forward, never back", async () => {
	const win = fakeWindow();
	const clock = installVirtualClock(win, 1_000_000, { startNow: 5000 });
	const fired = [];
	win.setTimeout(() => fired.push(win.performance.now()), 300);
	// The capture moved the script on while this document loaded; the second copy runs before page scripts.
	const same = installVirtualClock(win, 1_000_000, { startNow: 5250 });
	assert.equal(same, clock, "the document keeps its one clock");
	assert.equal(win.performance.now(), 5250, "the start moved forward");
	await clock.advanceTo(5550, 5250);
	assert.deepEqual(fired, [5550], "the timer kept its offset from the new start");
	// An older value never moves a clock back.
	installVirtualClock(win, 1_000_000, { startNow: 2400 });
	assert.equal(win.performance.now(), 5550, "a smaller start time is ignored");
});
