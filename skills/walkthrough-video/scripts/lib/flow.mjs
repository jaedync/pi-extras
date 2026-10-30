/**
 * The flow API that a capture script receives. Every action moves the real
 * mouse first (so hover states are real), wraps the step in the page
 * instrument, waits for the DOM to be quiet, and records one event with its
 * start, end and settle frames on the capture clock.
 */
import { boxCenter, clipToViewport, normalizeBox, roundBox, unionRects } from "./geometry.mjs";
import { beginAction, caretOf, fontPxOf, inkOf, rectOf, settleAction, textsOf } from "./instrument.mjs";
import { sleep } from "./proc.mjs";
import { isNavigationError } from "./vclock.mjs";

const ACTION_TIMEOUT_MS = 20000;
const MOVE_STEPS = 10;
const TYPE_DELAY_MS = 70;

/** A navigation destroyed the page context: the action's settle read is skipped, not failed. */
const isNavigation = isNavigationError;

/**
 * The wall time a wait of `frames` may take under the virtual clock: four
 * times the measured cost of a frame (the median of the last 30), at least
 * 120 s. film2's software WebGL took 1.5 s a frame, so a fixed 120 s cut a
 * 5.4 s wait to 3.07 s with no warning.
 */
export function waitBudgetMs({ frames, maxMs = 0, frameMs = [] }) {
	const recent = [...frameMs.slice(-30)].sort((a, b) => a - b);
	const cost = recent.length ? recent[Math.floor(recent.length / 2)] : 0;
	return Math.max(maxMs, 120000, Math.round(frames * cost * 4));
}

/**
 * Races `work` with the pump: when the pump stops, the step fails at once with
 * the pump's error. Under the virtual clock a settle never ends by itself, so
 * without this each step waits its whole cap (60 s) before the real error shows.
 */
export async function racePumpError(pump, work, { pollMs = 50 } = {}) {
	// The promise that loses the race must not become an unhandled rejection.
	work.catch(() => {});
	let watching = true;
	const watch = (async () => {
		while (watching) {
			if (pump.error) throw pump.error;
			await sleep(pollMs);
		}
	})();
	try {
		return await Promise.race([work, watch]);
	} finally {
		watching = false;
	}
}

export function createFlowApi({ page, pump, fps, viewport, dir, launchSecondary, beforeNavigate = async () => {}, log = (_line) => {} }) {
	const events = [];
	const cues = [];
	/** The page's text after each settled step: { f, items }. */
	const texts = [];
	const cursor = [{ f: 0, x: viewport.width / 2, y: viewport.height / 2 }];
	const mouse = { x: viewport.width / 2, y: viewport.height / 2 };
	let counter = 0;
	let secondaryBrowser = null;

	const viewportBox = () => ({ x: 0, y: 0, width: viewport.width, height: viewport.height });

	function step(label, fn) {
		return (async () => {
			let result;
			try {
				result = await fn();
			} catch (error) {
				const first = String(error?.message ?? error).split("\n")[0];
				const wrapped = new Error(`flow step "${label}" failed: ${first}`);
				wrapped.cause = error;
				throw wrapped;
			}
			// The settled page holds from the settle frame on; a read that a navigation breaks is skipped.
			if (Number.isFinite(result?.settleFrame)) {
				const items = await textsOf(page).catch(() => null);
				if (items) texts.push({ f: result.settleFrame, items });
			}
			return result;
		})();
	}

	function record(event) {
		const id = `e${++counter}`;
		const normalise = (box) => roundBox(normalizeBox(box), 2);
		events.push({
			id,
			kind: event.kind,
			name: event.name,
			startFrame: event.startFrame,
			endFrame: event.endFrame,
			settleFrame: event.settleFrame,
			target: normalise(event.target),
			caret: normalise(event.caret),
			changed: normalise(event.changed),
			fontPx: Number.isFinite(event.fontPx) ? event.fontPx : null,
			text: event.text ?? null,
			label: event.label ?? null,
			caption: event.caption ?? null,
			// The time the flow asked for, not the time the host gave it: compose protects the
			// planned part of a wait and compresses the lag after it.
			plannedMs: Number.isFinite(event.plannedMs) ? event.plannedMs : null,
		});
		return events[events.length - 1];
	}

	/** A keyframe, or a hold when the cursor has not moved yet; only an exact repeat is dropped. */
	function pushCursor(frame, x, y) {
		const last = cursor[cursor.length - 1];
		const at = Math.max(frame, last?.f ?? 0);
		if (last && last.f === at && Math.abs(last.x - x) < 0.5 && Math.abs(last.y - y) < 0.5) return;
		cursor.push({ f: at, x, y });
	}

	// Under the virtual clock app time is frame time: waits count frames, never wall time.
	const virtual = Boolean(pump.virtual);
	const settleCapMs = virtual ? 60000 : undefined;

	/**
	 * Waits until the capture clock has advanced by `frames`, so a mouse move is
	 * visible in the video. A pump that stopped fails the step at once: its
	 * error is the real one, and waiting the whole budget hides it for minutes.
	 */
	async function advanceFrames(frames, maxMs = 800) {
		if (pump.error) throw pump.error;
		const target = pump.frame() + Math.max(1, frames);
		const budget = virtual ? waitBudgetMs({ frames, maxMs, frameMs: pump.frameMs ?? [] }) : maxMs;
		const deadline = performance.now() + budget;
		while (pump.frame() < target && performance.now() < deadline) {
			if (pump.error) throw pump.error;
			await sleep(virtual ? 2 : 8);
		}
		if (virtual && pump.frame() < target) log(`warning: a wait of ${frames} frames ended after ${frames - (target - pump.frame())} frames, when its ${Math.round(budget / 1000)} s of wall time ran out; the take is shorter than the flow asked`);
	}

	/** Lets `ms` of app time pass: frames under the virtual clock, the wall clock otherwise. */
	async function letTimePass(ms) {
		if (!virtual) return sleep(ms);
		const frames = Math.round((Math.max(0, ms) * fps) / 1000);
		if (frames > 0) await advanceFrames(frames, 0);
	}

	async function moveTo(x, y, { pauseFrames = Math.max(2, Math.round(fps * 0.12)), steps = MOVE_STEPS } = {}) {
		const from = { x: mouse.x, y: mouse.y };
		const startFrame = pump.frame();
		await page.mouse.move(x, y, { steps });
		if (pauseFrames > 0) await advanceFrames(pauseFrames);
		pushCursor(startFrame, from.x, from.y);
		pushCursor(pump.frame(), x, y);
		mouse.x = x;
		mouse.y = y;
	}

	async function boxOf(locator) {
		return normalizeBox(await rectOf(locator));
	}

	/**
	 * The union of the changed rectangles, clipped to the viewport; null if
	 * nothing changed. A type event falls back to the target box because a new
	 * input value is not a DOM mutation.
	 */
	function changedFrom(settle) {
		if (!settle || settle.navigated) return null;
		const union = unionRects(settle.rects);
		return union ? clipToViewport(union, viewport) : null;
	}

	/** The settle call runs after a navigation sometimes; then the page itself is the change. */
	async function measureSettle() {
		try {
			return await racePumpError(pump, settleAction(page, settleCapMs));
		} catch (error) {
			if (!isNavigation(error)) throw error;
			await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
			await letTimePass(400);
			return { rects: [], navigated: true };
		}
	}

	async function hoverPoint(locator) {
		const box = await boxOf(locator);
		if (!box) throw new Error("target has no visible box");
		const centre = boxCenter(box);
		return { box, centre };
	}

	const api = {
		page,
		fps,
		viewport: { ...viewport },
		dir,
		/** The frame on screen now; the composer uses the same clock. */
		frames: () => pump.frame(),
		/** Lets app time pass in frame time under the virtual clock (use it instead of page.waitForTimeout). */
		sleep: (ms) => letTimePass(ms),
		events: () => events,
		cues: () => cues,

		goto(url, options = {}) {
			return step(`goto ${url}`, async () => {
				// The next document starts at the capture time of the next frame: the controller
				// writes it into the clock install script before the navigation begins.
				await beforeNavigate();
				const startFrame = pump.frame();
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
				await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
				await beginAction(page).catch(() => {});
				await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
				const endFrame = pump.frame();
				const settle = await measureSettle();
				return record({
					kind: "goto",
					name: options.name ?? "goto",
					startFrame,
					endFrame,
					settleFrame: pump.frame(),
					target: null,
					caret: null,
					changed: settle.navigated ? viewportBox() : (changedFrom(settle) ?? viewportBox()),
					fontPx: null,
					label: options.label ?? null,
					caption: options.caption ?? null,
				});
			});
		},

		click(selector, options = {}) {
			return step(`click ${selector}`, async () => {
				const locator = page.locator(selector).first();
				await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
				// Measure after the scroll that Playwright would do during the action.
				await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
				const { box, centre } = await hoverPoint(locator);
				const fontPx = await fontPxOf(locator).catch(() => null);
				await moveTo(centre.x, centre.y);
				await beginAction(page);
				const startFrame = pump.frame();
				await locator.click({ timeout: ACTION_TIMEOUT_MS });
				const endFrame = pump.frame();
				const settle = await measureSettle();
				const settleFrame = pump.frame();
				return record({
					kind: "click",
					name: options.name ?? `click ${selector}`,
					startFrame,
					endFrame,
					settleFrame,
					target: box,
					caret: null,
					changed: changedFrom(settle),
					fontPx,
					label: options.label ?? null,
					caption: options.caption ?? null,
				});
			});
		},

		type(selector, text, options = {}) {
			return step(`type ${selector}`, async () => {
				const locator = page.locator(selector).first();
				await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
				// Measure after the scroll that Playwright would do during the action.
				await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
				const { box, centre } = await hoverPoint(locator);
				await moveTo(centre.x, centre.y);
				await beginAction(page);
				const startFrame = pump.frame();
				await locator.click({ timeout: ACTION_TIMEOUT_MS });
				if (virtual) {
					// One key, then the delay in frames, so the keys land at even frame times however slow the host is.
					for (const char of text) {
						await page.keyboard.type(char);
						await letTimePass(options.delayMs ?? TYPE_DELAY_MS);
					}
				} else await locator.pressSequentially(text, { delay: options.delayMs ?? TYPE_DELAY_MS, timeout: ACTION_TIMEOUT_MS });
				const caret = await caretOf(locator).catch(() => null);
				// A password never goes to disk; events.json keeps only its length.
				const secret = options.secret || (await locator.evaluate((el) => el.type === "password", undefined, { timeout: 1500 }).catch(() => false));
				const fontPx = await fontPxOf(locator).catch(() => null);
				const endFrame = pump.frame();
				const settle = await measureSettle();
				return record({
					kind: "type",
					name: options.name ?? `type ${selector}`,
					startFrame,
					endFrame,
					settleFrame: pump.frame(),
					target: box,
					caret,
					changed: changedFrom(settle) ?? box,
					fontPx,
					text: secret ? `[${text.length} characters hidden]` : text,
					label: options.label ?? null,
					caption: options.caption ?? null,
				});
			});
		},

		hover(selector, options = {}) {
			return step(`hover ${selector}`, async () => {
				const locator = page.locator(selector).first();
				await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
				// Measure after the scroll that Playwright would do during the action.
				await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
				const { box, centre } = await hoverPoint(locator);
				const fontPx = await fontPxOf(locator).catch(() => null);
				await beginAction(page);
				const startFrame = pump.frame();
				await moveTo(centre.x, centre.y, { pauseFrames: options.pauseFrames });
				const endFrame = pump.frame();
				const settle = await measureSettle();
				const settleFrame = pump.frame();
				return record({
					kind: "hover",
					name: options.name ?? `hover ${selector}`,
					startFrame,
					endFrame,
					settleFrame,
					target: box,
					caret: null,
					changed: changedFrom(settle),
					fontPx,
					label: options.label ?? null,
					caption: options.caption ?? null,
				});
			});
		},

		scroll(target, options = {}) {
			const dy = typeof target === "number" ? target : Number(target?.y ?? options.y ?? 0);
			const where = typeof target === "string" ? target : `y=${dy}`;
			return step(`scroll ${where}`, async () => {
				await beginAction(page);
				const startFrame = pump.frame();
				let targetBox = viewportBox();
				if (typeof target === "string") {
					const locator = page.locator(target).first();
					await locator.waitFor({ state: "attached", timeout: ACTION_TIMEOUT_MS });
					await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
					targetBox = (await boxOf(locator).catch(() => null)) ?? viewportBox();
				} else {
					await page.mouse.wheel(0, dy);
				}
				const endFrame = pump.frame();
				const settle = await measureSettle();
				return record({
					kind: "scroll",
					name: options.name ?? `scroll ${where}`,
					startFrame,
					endFrame,
					settleFrame: pump.frame(),
					target: targetBox,
					caret: null,
					changed: changedFrom(settle) ?? viewportBox(),
					fontPx: null,
					label: options.label ?? null,
					caption: options.caption ?? null,
				});
			});
		},

		/** A key press on the focused element; the mouse does not move (safe for pointer-lock apps). */
		key(key, options = {}) {
			return step(`key ${key}`, async () => {
				await beginAction(page);
				const startFrame = pump.frame();
				if (virtual && options.holdMs) {
					await page.keyboard.down(key);
					await letTimePass(options.holdMs);
					await page.keyboard.up(key);
				} else await page.keyboard.press(key, { delay: options.holdMs ?? 0 });
				const endFrame = pump.frame();
				const settle = await measureSettle();
				return record({
					kind: "key",
					name: options.name ?? `key ${key}`,
					startFrame,
					endFrame,
					settleFrame: pump.frame(),
					target: null,
					caret: null,
					changed: changedFrom(settle),
					fontPx: null,
					text: key,
					label: options.label ?? key,
					caption: options.caption ?? null,
				});
			});
		},

		wait(ms, options = {}) {
			return step(`wait ${ms} ms`, async () => {
				const startFrame = pump.frame();
				await letTimePass(Number(ms) || 0);
				const frame = pump.frame();
				return record({
					kind: "wait",
					name: options.name ?? `wait ${ms} ms`,
					startFrame,
					endFrame: frame,
					settleFrame: frame,
					plannedMs: Number(ms) || 0,
					target: null,
					caret: null,
					changed: null,
					fontPx: null,
					label: options.label ?? null,
					caption: options.caption ?? null,
				});
			});
		},

		waitFor(target, options = {}) {
			const label = typeof target === "function" ? "waitFor function" : `waitFor ${target}`;
			return step(label, async () => {
				await beginAction(page);
				const startFrame = pump.frame();
				if (typeof target === "function") await page.waitForFunction(target, undefined, { timeout: options.timeoutMs ?? ACTION_TIMEOUT_MS });
				else await page.waitForSelector(target, { state: options.state ?? "visible", timeout: options.timeoutMs ?? ACTION_TIMEOUT_MS });
				const endFrame = pump.frame();
				const settle = await measureSettle();
				return record({
					kind: "wait",
					name: options.name ?? "waitFor",
					startFrame,
					endFrame,
					settleFrame: pump.frame(),
					target: null,
					caret: null,
					changed: changedFrom(settle),
					fontPx: null,
					label: options.label ?? (typeof target === "function" ? "condition" : target),
					caption: options.caption ?? null,
				});
			});
		},

		mark(name, options = {}) {
			return step(`mark ${name}`, async () => {
				// With no selector the mark is only a point in time: the camera stays.
				let box = null;
				let fontPx = null;
				if (options.selector) {
					const locator = page.locator(options.selector).first();
					await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
					// The text itself: a short line in a full-width block must still get a close-up.
					box = normalizeBox(await inkOf(locator)) ?? viewportBox();
					fontPx = await fontPxOf(locator).catch(() => null);
				}
				const frame = pump.frame();
				return record({
					kind: "mark",
					name,
					startFrame: frame,
					endFrame: frame,
					settleFrame: frame,
					target: box,
					caret: null,
					changed: null,
					fontPx,
					label: options.label ?? null,
					caption: options.caption ?? null,
				});
			});
		},

		say(text) {
			cues.push({ f: pump.frame(), text: String(text) });
			return cues[cues.length - 1];
		},

		/** A second page for another user: a normal browser, never captured. */
		async secondary() {
			if (!launchSecondary) throw new Error("this capture cannot open a second browser");
			secondaryBrowser ??= await launchSecondary();
			const context = await secondaryBrowser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
			const guest = await context.newPage();
			return guest;
		},

		async close() {
			await secondaryBrowser?.close().catch(() => {});
			secondaryBrowser = null;
		},
	};

	return { api, events, cues, cursor, texts };
}
