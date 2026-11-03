/**
 * The page instrument keeps one window per action. An old settle that the Node
 * cap gave up on must not stop the window that a later action opened.
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installInstrument, settleAction } from "../skills/walkthrough-video/scripts/lib/instrument.mjs";

/** A page stub whose globals the instrument runs against, with a clock the test drives. */
function fakePage() {
	const timers = new Map();
	const listeners = new Map();
	const observers = [];
	let nextTimer = 1;
	let now = 0;

	const schedule = (fn, ms) => {
		const id = nextTimer++;
		timers.set(id, { fn, due: now + (Number(ms) || 0) });
		return id;
	};

	class Element {
		constructor(width = 200, height = 120) {
			this.width = width;
			this.height = height;
		}
		checkVisibility() {
			return true;
		}
		getBoundingClientRect() {
			return { left: 10, top: 20, right: 10 + this.width, bottom: 20 + this.height, width: this.width, height: this.height };
		}
	}
	class MutationObserver {
		constructor(callback) {
			this.callback = callback;
			this.connected = false;
			observers.push(this);
		}
		observe() {
			this.connected = true;
		}
		disconnect() {
			this.connected = false;
		}
		/** A record reaches the callback only while the observer is connected, as in a page. */
		deliver(record) {
			if (this.connected) this.callback([record]);
		}
	}

	let animating = false;
	const document = {
		documentElement: {},
		// A running finite animation keeps the page busy, as a page-side animation does.
		getAnimations: () =>
			animating ? [{ playState: "running", effect: { getComputedTiming: () => ({ iterations: 1 }) } }] : [],
		createElement: () => ({ getContext: () => ({}) }),
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
	};
	const window = {};
	const context = vm.createContext({
		document,
		window,
		Element,
		MutationObserver,
		Node: { TEXT_NODE: 3 },
		NodeFilter: { SHOW_TEXT: 4 },
		performance: { now: () => now },
		setTimeout: schedule,
		clearTimeout: (id) => timers.delete(id),
		getComputedStyle: () => ({}),
	});

	const listenerCount = () => [...listeners.values()].reduce((total, set) => total + set.size, 0);
	const run = (fn, arg) => vm.runInContext(`(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`, context);

	const page = {
		init: null,
		window,
		Element,
		listenerCount,
		observers,
		async addInitScript(fn) {
			page.init = fn;
		},
		evaluate: async (fn, arg) => run(fn, arg),
		start() {
			run(page.init);
		},
		animate(on) {
			animating = on;
		},
		/** Runs the timers due up to `target`, then leaves the clock at `target`. */
		advanceTo(target) {
			for (let guard = 0; guard < 10000; guard += 1) {
				let next = null;
				for (const [id, timer] of timers) {
					if (timer.due <= target && (!next || timer.due < next.timer.due)) next = { id, timer };
				}
				if (!next) break;
				timers.delete(next.id);
				now = Math.max(now, next.timer.due);
				next.timer.fn();
			}
			now = Math.max(now, target);
		},
	};
	return page;
}

test("a settle the Node cap gave up on does not stop the next action's window", async () => {
	const page = fakePage();
	await installInstrument(page);
	page.start();
	const wv = page.window.__wv;
	assert.ok(wv, "the instrument installs its api");

	// Action A opens its window, then Node gives up on it: the page-side settle keeps running.
	wv.begin();
	const capped = await settleAction(page, 5);
	assert.equal(capped.capped, true, "the Node cap ends the wait for action A");

	// Action B opens the next window and its change arrives after A's late tick.
	wv.begin();
	const observerB = page.observers.at(-1);
	assert.equal(page.listenerCount(), 12, "action B adds its activity listeners");
	page.advanceTo(3000); // A's page cap falls due here, in B's window.
	const changed = new page.Element();
	observerB.deliver({ type: "childList", target: changed, addedNodes: [] });

	assert.equal(observerB.connected, true, "action B keeps its observer after the abandoned settle ends");

	const pending = wv.settle();
	page.advanceTo(3400);
	const settle = await pending;
	assert.equal(settle.rects.length, 1, "action B reports the element that changed in its own window");
});

test("an abandoned settle resolves and leaves the next window open", async () => {
	const page = fakePage();
	await installInstrument(page);
	page.start();
	const wv = page.window.__wv;

	// Action A stays busy with an animation, so its page-side settle runs to its own cap.
	wv.begin();
	page.animate(true);
	let first = null;
	const pending = wv.settle().then((result) => {
		first = result;
	});
	page.advanceTo(2900);

	// Action B opens its window while A's settle is still running in the page.
	wv.begin();
	const observerB = page.observers.at(-1);
	page.advanceTo(3100);

	await pending;
	assert.equal(first.abandoned, true, "the abandoned settle returns instead of waiting forever");
	assert.equal(observerB.connected, true, "the abandoned settle leaves the next observer in place");
	assert.equal(page.listenerCount(), 12, "the abandoned settle leaves the next listeners in place");
});
