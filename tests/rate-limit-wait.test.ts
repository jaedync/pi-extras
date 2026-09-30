import assert from "node:assert/strict";
import { test } from "node:test";
import { isCancelKey, waitForDelay, waitUI } from "../lib/rate-limit-recovery/wait.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { captureLimit } from "../lib/rate-limit-recovery/core.ts";

for (const key of ["\x1b", "\x03", "\x1b[27u", "\x1b[99;5u"]) test(`accepts cancellation key ${JSON.stringify(key)}`, () => assert.equal(isCancelKey(key), true));
for (const key of ["\x1b[99;5:3u", "x", "\x1b[A", "\x1b[200~\x03\x1b[201~"]) test(`ignores non-cancel input ${JSON.stringify(key)}`, () => assert.equal(isCancelKey(key), false));

test("countdown renders remaining time at narrow widths and owns exactly one cleanup", () => {
	let now = Date.parse("2026-09-30T02:00:00Z");
	const pausedAtMs = now;
	let renders = 0; let unsubscribed = 0; let removed = 0;
	let widget: { render(width: number): string[] } | undefined;
	const ctx = { ui: {
		setWidget(_key: string, factory: any) {
			if (factory) widget = factory({ requestRender: () => renders++ }, { fg: (_key: string, text: string) => text });
			else { widget = undefined; removed++; }
		},
		onTerminalInput: () => () => { unsubscribed++; },
	} };
	const limit = captureLimit({ provider: "anthropic", id: "claude-opus" }, { retryAfterSeconds: 25 }, now);
	const ui = waitUI(ctx as never, limit, { delayMs: 25_000, pausedAtMs, resumeAtMs: now + 25_000 }, () => now, () => {});
	assert.match(widget!.render(120)[0]!, /Hibernating anthropic.*25.*Esc \/ Ctrl\+C/);
	now += 20_000; ui.tick();
	assert.match(widget!.render(120)[0]!, /5.*remaining/);
	for (const width of [1, 2, 8, 18, 100]) assert.ok(widget!.render(width).every((line) => visibleWidth(line) <= width));
	ui.close(); ui.close(); ui.tick();
	assert.equal(renders, 1); assert.equal(unsubscribed, 1); assert.equal(removed, 1);
});

test("timer waits the full delay, updates once per second and removes all resources", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const controller = new AbortController();
	let ticks = 0;
	let finished = false;
	const pending = waitForDelay(2500, controller.signal, () => ticks++).then((value) => { finished = value; });
	assert.equal(ticks, 1);
	t.mock.timers.tick(2000);
	await Promise.resolve();
	assert.equal(finished, false);
	assert.equal(ticks, 3);
	t.mock.timers.tick(500); await pending;
	assert.equal(finished, true);
	t.mock.timers.tick(10_000);
	assert.equal(ticks, 3);
});

test("abort clears the timer and ticker, and already-aborted waits allocate nothing", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const controller = new AbortController();
	let ticks = 0;
	const pending = waitForDelay(20_000, controller.signal, () => ticks++);
	controller.abort();
	assert.equal(await pending, false);
	t.mock.timers.tick(30_000);
	assert.equal(ticks, 1);
	assert.equal(await waitForDelay(20_000, controller.signal, () => ticks++), false);
	assert.equal(ticks, 1);
});

test("a rendering failure rejects once and leaves no timer behind", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	let ticks = 0;
	const pending = waitForDelay(20_000, new AbortController().signal, () => { ticks++; throw new Error("draw failed"); });
	await assert.rejects(pending, /draw failed/);
	t.mock.timers.tick(30_000);
	assert.equal(ticks, 1);
});
