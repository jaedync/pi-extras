/**
 * The virtual clock of frame-exact capture. The page's Date, performance.now,
 * setTimeout, setInterval and requestAnimationFrame stop following the wall
 * clock: time moves only when the capture calls advanceTo(t) before it draws a
 * frame, and each advance runs the due timers in time order, then exactly one
 * batch of animation frames. CSS animations follow the same frame time
 * through HeadlessExperimental.beginFrame, so a slow host or a heavy WebGL
 * page makes the capture slower, never the film jerkier.
 *
 * installVirtualClock runs in the page (as an init script), so it must not
 * use anything from this module's scope. Playwright's own page.clock is not
 * used: it ticks animation frames on a fixed 16 ms grid, which gives 62.5
 * frames of app time per 60 captured frames.
 */
import { withTimeout } from "./proc.mjs";

/** An error that means the document is gone (a navigation destroyed its context), not a fault. */
export const isNavigationError = (error) => /Execution context was destroyed|Cannot find context|Target closed|navigat|Session closed/i.test(error?.message ?? String(error ?? ""));

/**
 * Replaces the time functions of `win` and returns the controller. `epoch` is
 * the Date.now() value at virtual time 0. `startNow` is the capture time at
 * which this document starts; the capture controller writes the current time
 * into the install script before each document, so a document that loads in the
 * middle of a film reads the capture time at load, not 0.
 */
export function installVirtualClock(win, epoch, { onError, startNow = 0 } = /** @type {{onError?: (error: any) => void, startNow?: number}} */ ({})) {
	// A second copy of the install script in the same document: the capture moved
	// the start time on, so move this clock forward, never back, before any page
	// script reads it. Timers keep their offset from the document's start.
	if (win.__wvClock?.advanceStart) return win.__wvClock.advanceStart(startNow);
	// Only the top frame: one clock per document would drift, and the capture advances one clock.
	// A child frame (an embedded map, player or form) then runs on real time, as capture.md says.
	if (win !== (win.top ?? win)) return undefined;
	const RealDate = win.Date;
	const nativeFrame = typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : null;
	let now = Number.isFinite(startNow) && startNow > 0 ? startNow : 0;
	let nextId = 1;
	/** The nesting level of the timer that is running now; a browser clamps deep zero delays to 4 ms. */
	let nesting = 0;
	const timers = new Map();
	let frames = new Map();
	const report = (error) => {
		if (onError) onError(error);
		else if (win.console) win.console.error(error);
	};

	function VirtualDate(...args) {
		if (!new.target) return new RealDate(epoch + now).toString();
		return args.length === 0 ? new RealDate(epoch + now) : new RealDate(...args);
	}
	VirtualDate.prototype = RealDate.prototype;
	VirtualDate.now = () => epoch + now;
	VirtualDate.parse = RealDate.parse;
	VirtualDate.UTC = RealDate.UTC;
	win.Date = VirtualDate;

	const perfNow = () => now;
	try {
		Object.defineProperty(win.performance, "now", { value: perfNow, configurable: true, writable: true });
	} catch {
		win.performance.now = perfNow;
	}

	// The HTML timer clamp: after five nested levels a delay under 4 ms becomes 4 ms, so a
	// polling loop of setTimeout(fn, 0) cannot run 100 000 times inside one captured frame.
	const delayOf = (ms, nested) => {
		const n = Number(ms);
		const delay = Number.isFinite(n) && n > 0 ? n : 0;
		return nested > 5 && delay < 4 ? 4 : delay;
	};
	win.setTimeout = (fn, ms, ...args) => {
		const id = nextId++;
		timers.set(id, { at: now + delayOf(ms, nesting), fn, args, every: 0, seq: id, nested: nesting });
		return id;
	};
	win.setInterval = (fn, ms, ...args) => {
		const id = nextId++;
		const every = Math.max(1, delayOf(ms, nesting));
		timers.set(id, { at: now + every, fn, args, every, seq: id, nested: nesting });
		return id;
	};
	win.clearTimeout = (id) => {
		timers.delete(id);
	};
	win.clearInterval = win.clearTimeout;
	win.requestAnimationFrame = (fn) => {
		const id = nextId++;
		frames.set(id, fn);
		return id;
	};
	win.cancelAnimationFrame = (id) => {
		frames.delete(id);
	};

	// CSS animations, CSS transitions and element.animate() run on the compositor's
	// clock, which follows the wall clock. So the clock owns every running
	// animation: it pauses it and sets its time from frame time on each advance.
	// An animation that the app pauses, seeks or plays goes back to the app.
	const owned = new Map();
	const Anim = win.Animation && win.Animation.prototype;
	let setTime = null;
	let pauseIt = null;
	let finishIt = null;
	if (Anim) {
		const timeProp = Object.getOwnPropertyDescriptor(Anim, "currentTime");
		setTime = (anim, value) => timeProp.set.call(anim, value);
		Object.defineProperty(Anim, "currentTime", {
			configurable: true,
			get() {
				return timeProp.get.call(this);
			},
			set(value) {
				const entry = owned.get(this);
				if (entry && value != null) Object.assign(entry, { base: Number(value), at: now });
				timeProp.set.call(this, value);
			},
		});
		pauseIt = Anim.pause;
		finishIt = Anim.finish;
		for (const name of ["pause", "play", "finish", "cancel", "reverse"]) {
			const real = Anim[name];
			if (typeof real !== "function") continue;
			Anim[name] = function (...args) {
				owned.delete(this);
				return real.apply(this, args);
			};
		}
	}
	function syncAnimations() {
		const doc = win.document;
		if (!Anim || !doc || typeof doc.getAnimations !== "function") return;
		let list;
		try {
			list = doc.getAnimations();
		} catch {
			return;
		}
		for (const anim of list) {
			try {
				let entry = owned.get(anim);
				if (entry && anim.playState !== "paused") {
					owned.delete(anim);
					entry = null;
				}
				if (!entry) {
					if (anim.playState !== "running") continue;
					entry = { base: Number(anim.currentTime) || 0, at: now };
					pauseIt.call(anim);
					owned.set(anim, entry);
				}
				const rate = Number(anim.playbackRate);
				// Step by step, so a change of playbackRate keeps the current time, as it does in the browser.
				entry.base += (now - entry.at) * (Number.isFinite(rate) ? rate : 1);
				entry.at = now;
				const t = entry.base;
				const timing = anim.effect && anim.effect.getComputedTiming ? anim.effect.getComputedTiming() : {};
				const end = Number(timing.endTime);
				if ((rate >= 0 && Number.isFinite(end) && t >= end) || (rate < 0 && t <= 0)) {
					owned.delete(anim);
					finishIt.call(anim);
				} else setTime(anim, t);
			} catch (error) {
				report(error);
			}
		}
	}

	// A real animation frame request on every frame, so each beginFrame runs a
	// main frame and draws the DOM that the last advance left, even on a busy host.
	if (nativeFrame) nativeFrame(function keep() {
		nativeFrame(keep);
	});

	function due(limit) {
		let first = null;
		for (const [id, timer] of timers) if (timer.at <= limit && (!first || timer.at < first[1].at || (timer.at === first[1].at && timer.seq < first[1].seq))) first = [id, timer];
		return first;
	}

	let started = false;

	/**
	 * Moves a document that loaded after the capture began onto the capture
	 * clock. Its own clock starts at 0, so without this the first advance runs
	 * every timer that the document set at load in one frame. `from` is the
	 * capture time of the frame before: the document became visible between the
	 * two, and its timers were set at `from`.
	 */
	function rebase(from) {
		if (!Number.isFinite(from) || from <= now) return;
		const offset = from - now;
		now += offset;
		for (const timer of timers.values()) timer.at += offset;
	}

	const controller = {
		now: () => now,
		/** Moves the start time forward, as a later install script in the same document does. */
		advanceStart(ms) {
			const target = Number(ms);
			if (!Number.isFinite(target) || target <= now) return controller;
			const delta = target - now;
			now = target;
			for (const timer of timers.values()) timer.at += delta;
			return controller;
		},
		/**
		 * Runs every timer due by t in time order, then one batch of animation
		 * frames at t. On the first call, `from` (the previous frame's capture
		 * time) sets where this document's clock starts.
		 */
		async advanceTo(t, from = null) {
			if (!started) {
				started = true;
				rebase(from);
			}
			for (let guard = 0; guard < 100000; guard++) {
				const next = due(t);
				if (!next) break;
				const [id, timer] = next;
				now = Math.max(now, timer.at);
				if (timer.every) timer.at += timer.every;
				else timers.delete(id);
				nesting = (timer.nested ?? 0) + 1;
				try {
					if (typeof timer.fn === "function") timer.fn(...timer.args);
					else (0, eval)(String(timer.fn));
				} catch (error) {
					report(error);
				} finally {
					nesting = 0;
				}
				// Let promise chains run, so a timer that a promise sets inside this frame is not late.
				for (let k = 0; k < 4; k++) await null;
			}
			now = Math.max(now, t);
			const batch = frames;
			frames = new Map();
			for (const fn of batch.values()) {
				try {
					fn(now);
				} catch (error) {
					report(error);
				}
			}
			for (let k = 0; k < 4; k++) await null;
			syncAnimations();
			return now;
		},
	};
	win.__wvClock = controller;
	return controller;
}

/**
 * The init script source that runs in every document of the captured page. The
 * clock itself installs only in the top document; see installVirtualClock.
 */
export function virtualClockScript(epoch, startNow = 0) {
	return `(${installVirtualClock.toString()})(window, ${Number(epoch)}, { startNow: ${Number(startNow) || 0} });`;
}

/**
 * Advances the page clock to t ms of capture time. `from` is the capture time of
 * the previous frame, which a document that loaded since then uses as its start
 * (see installVirtualClock). A page between documents has no clock to advance;
 * every other failure is reported, including a page that never answers: a
 * swallowed error used to stop the pump with no message.
 */
export async function advancePageClock(cdp, t, from = null, { timeoutMs = 60_000 } = {}) {
	const args = from === null ? `${t}` : `${t}, ${from}`;
	try {
		await withTimeout(cdp.send("Runtime.evaluate", { expression: `window.__wvClock ? window.__wvClock.advanceTo(${args}) : 0`, awaitPromise: true, returnByValue: true }), timeoutMs, `the page clock did not answer advanceTo(${args})`);
	} catch (error) {
		if (isNavigationError(error)) return undefined;
		throw error;
	}
}
