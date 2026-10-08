import { test } from "node:test";
import assert from "node:assert/strict";
import statusPlus from "../extensions/status-plus.ts";
import { stripAnsi } from "../lib/ansi.ts";
import { TWEEN_MS, HOLD_MS, FALL_MS } from "../lib/status-plus-tween.ts";

const START = 1_750_000_000_000;
/** Pi saves a reply after extensions see its message_end; Status Plus counts it on the next tick. */
const saved = () => new Promise((resolve) => setImmediate(resolve));
function entry(cost, timestamp) {
	return { type: "message", timestamp: new Date(timestamp).toISOString(), message: {
		role: "assistant", provider: "test-provider", model: "test", timestamp,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, content: [],
	} };
}

test("message charges render immediately, expire on scheduled frames, and reset with sessions", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
	const handlers = new Map();
	let branch = [entry(0.59, START)];
	let component;
	let line;
	const render = () => { line = stripAnsi(component.render(160)[0]); };
	const ctx = {
		mode: "tui", model: { id: "test", provider: "test-provider" },
		sessionManager: { getBranch: () => branch, getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~", getSessionName: () => undefined },
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender: render }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler) });
	const fire = (name, event = {}) => handlers.get(name)(event, ctx);
	try {
		await fire("session_start");
		assert.match(line, /\$0\.59 · 0m/);
		assert.ok(!line.includes("+$"));
		for (const [cost, label] of [[0.043, "+$0.043"], [0.00093, "+$0.00093"]]) {
			t.mock.timers.tick(100);
			const added = entry(cost, Date.now());
			await fire("message_end", { message: added.message });
			branch = [...branch, added];
			await saved();
			assert.ok(line.includes(label), line);
			assert.ok(!line.includes("· 0m"), line);
			await fire("turn_end");
			await saved();
			assert.ok(line.includes(label), "unchanged totals retain the delta");
		}
		t.mock.timers.tick(TWEEN_MS + HOLD_MS + FALL_MS + 50);
		assert.ok(!line.includes("+$"), line);
		assert.match(line, /\$0\.63 · 0m/);
		await fire("session_shutdown");
		branch = [entry(10, Date.now())];
		await fire("session_start");
		assert.ok(!line.includes("+$"), "resumed totals are not charges");
	} finally {
		await fire("session_shutdown");
		component?.dispose();
	}
});

test("a provider request outside a turn, like a cache refresh, never ticks airtime", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
	const handlers = new Map();
	let branch = [];
	let component;
	let line;
	const render = () => { line = stripAnsi(component.render(160)[0]); };
	const ctx = {
		mode: "tui", model: { id: "test", provider: "test-provider" },
		sessionManager: { getBranch: () => branch, getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~", getSessionName: () => undefined },
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender: render }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler) });
	const fire = (name, event = {}) => handlers.get(name)(event, ctx);
	try {
		await fire("session_start");
		await fire("turn_start");
		await fire("before_provider_request");
		t.mock.timers.tick(2 * 60_000);
		render();
		assert.match(line, /\$0\.00 · 2m/, "a turn's request ticks while it runs");
		const reply = entry(0.5, Date.now());
		await fire("message_end", { message: reply.message });
		branch = [reply];
		await saved();
		// A long tool call: Pi refreshes the prompt cache with a request of its own.
		await fire("before_provider_request");
		t.mock.timers.tick(5 * 60_000);
		render();
		assert.match(line, /\$0\.50 · 0m/, line);
	} finally {
		await fire("session_shutdown");
		component?.dispose();
	}
});
