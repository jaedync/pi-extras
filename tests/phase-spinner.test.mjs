import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { agentRoot } from './support/pi-runtime.mjs';
const { createJiti } = createRequire(join(agentRoot, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": fileURLToPath(new URL("./fixtures/phase-editor-api.mjs", import.meta.url)),
		"@earendil-works/pi-tui": createRequire(join(agentRoot, "package.json")).resolve("@earendil-works/pi-tui"),
	},
});
const phaseSpinner = await jiti.import("../extensions/phase-spinner.ts", { default: true });
const { TopBorderLink } = await jiti.import("../lib/top-border.ts");

function harness(t, events) {
	let now = 0;
	let idle = false;
	t.mock.method(performance, "now", () => now);
	const handlers = new Map();
	phaseSpinner({ on: (name, handler) => handlers.set(name, handler), events });
	const forwarded = [];
	const indicators = [];
	const base = {
		render: width => ["─".repeat(width), "input"], getText: () => "", invalidate() {},
		setWorkingStatusIndicator: indicator => forwarded.push(indicator),
	};
	let factory = () => base;
	const ctx = {
		isIdle: () => idle,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: value => { factory = value; },
			setWorkingIndicator: options => indicators.push(options),
			theme: { fg: (_tone, text) => text },
		},
	};
	const emit = (name, event = {}, at = now) => { now = at; handlers.get(name)(event, ctx); };
	emit("session_start");
	const editor = factory({ requestRender() {} }, { borderColor: text => text }, {});
	t.after(() => emit("session_shutdown"));
	const update = (kind, delta, at) => emit("message_update", {
		assistantMessageEvent: { type: kind, delta }, message: { role: "assistant", content: [] },
	}, at);
	const finish = (output, at) => emit("message_end", {
		message: { role: "assistant", usage: { output }, stopReason: "stop" },
	}, at);
	// Pi clears the embedded indicator before showing each replacement.
	const show = (indicator, at = now) => {
		now = at;
		editor.setWorkingStatusIndicator(undefined);
		if (indicator) editor.setWorkingStatusIndicator(indicator);
	};
	return {
		emit, update, finish, show, forwarded, indicators,
		render: (at = now) => { now = at; return editor.render(120); },
		settle: () => { idle = true; emit("agent_settled"); },
	};
}

test("real extension wires stream timing to the live and retained editor border", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("turn_start");
	h.emit("before_provider_request", {}, 100);
	h.emit("after_provider_response", { status: 200 }, 300);
	h.emit("message_start", { message: { role: "assistant" } }, 400);
	h.update("text_start", undefined, 500);
	h.update("thinking_delta", "thinking", 900);
	h.update("text_delta", "answer", 2900);
	h.finish(100, 5000);
	assert.match(h.render()[0], /TPS 20\.4 ─ TTFT 0\.8s ─ Time 00:05\.0/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	assert.equal(h.render()[1], "input");
	h.emit("agent_end");
	h.emit("agent_settled"); // Not idle yet: queued work/retry must keep the span.
	h.emit("agent_start", {}, 10000);
	h.emit("before_provider_request", {}, 11000);
	h.update("toolcall_delta", "{}", 13400);
	h.update("text_delta", "next", 14400);
	h.finish(100, 15000);
	assert.match(h.render()[0], /TPS 22\.5 ─ TTFT 0\.8–2\.4s ─ Time 00:15\.0/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	h.settle();
	assert.match(h.render()[0], /TPS 22\.5 ─ TTFT 0\.8–2\.4s ─ Last 00:15\.0/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	h.emit("agent_start", {}, 20000);
	assert.match(h.render()[0], /Time 00:00\.0/);
	assert.doesNotMatch(h.render()[0], /TTFT|Decode|TPS|•/);
});

test("Pi's working loader is held still only once this row covers it, and moves again after the run", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("turn_start");
	assert.deepEqual(h.indicators, [], "nothing covers the loader yet");
	h.render();
	h.emit("before_provider_request", {}, 100);
	assert.deepEqual(h.indicators, [{ frames: ["⠿"] }]);
	h.update("text_delta", "answer", 900);
	h.render();
	h.emit("message_start", { message: { role: "assistant" } }, 1000);
	assert.equal(h.indicators.length, 1, "held once per run");
	h.settle();
	assert.deepEqual(h.indicators, [{ frames: ["⠿"] }, undefined]);
});

test("reload clears retained timing and tool messages cannot finalize a model sample", t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("before_provider_request", {}, 100);
	h.update("text_delta", "first", 200);
	h.emit("message_end", { message: { role: "toolResult", usage: { output: 999 } } }, 500);
	h.update("text_delta", "last", 1200);
	h.finish(40, 3000);
	h.settle();
	assert.match(h.render()[0], /TPS 13\.8 ─ TTFT 0\.1s ─ Last/);
	assert.doesNotMatch(h.render()[0], /Decode/);
	h.emit("session_start");
	assert.doesNotMatch(h.render()[0], /TTFT|Decode|TPS|Last|Time/);
});

// Pi's indicator paints its own spinner; only its words should reach the border.
function indicator(kind, message) {
	return {
		kind,
		setMessage(next) { message = next; },
		renderInBorder: () => `\x1b[36m⠋\x1b[39m \x1b[2m${message}\x1b[22m`,
		renderSpinnerInBorder: () => "\x1b[36m⠋\x1b[39m",
	};
}

const COMPACT_FRAMES = /[⣿⣶⣤⣀]/;
const RETRY_FRAMES = /[⠃⠆⡄⣀⢠⠰⠘⠉]/;

test("compaction replaces the phase slot with its own spinner, timer, and Pi's label", async t => {
	const h = harness(t);
	h.emit("agent_start");
	h.emit("context", {}, 1000);
	h.show(indicator("compaction", "Auto-compacting... (Esc to cancel)"), 2000);
	const line = h.render(9300)[0];
	assert.match(line, / 00:07\.3 Auto-compacting Esc cancel /);
	assert.match(line, /Time 00:09\.3 ─$/);
	assert.match(line.slice(0, 3), COMPACT_FRAMES);
	assert.doesNotMatch(line, /⠋|Prep|\.\.\./);
	h.show(undefined, 9400);
	await Promise.resolve();
	assert.match(h.render()[0], /Prep/);
});

test("retry keeps one event timer across attempts and yields to live request phases", async t => {
	const h = harness(t);
	h.emit("agent_start");
	const first = indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)");
	h.show(first, 1000);
	first.setMessage("Retrying (1/3) in 2s... (Esc to cancel)");
	let line = h.render(3000)[0];
	assert.match(line, / 00:02\.0 Retrying \(1\/3\) in 2s Esc cancel /);
	assert.match(line.slice(0, 3), RETRY_FRAMES);
	h.emit("before_provider_request", {}, 5000);
	assert.match(h.render(5500)[0], / 00:00\.5 API retry 1\/3 /);
	h.show(indicator("retry", "Retrying (2/3) in 8s... (Esc to cancel)"), 8000);
	await Promise.resolve();
	assert.match(h.render(9000)[0], / 00:08\.0 Retrying \(2\/3\) in 8s /);
	h.show(undefined, 9500);
	await Promise.resolve();
	h.show(indicator("retry", "Retrying (1/3) in 4s... (Esc to cancel)"), 20000);
	assert.match(h.render(20000)[0], / 00:00\.0 Retrying \(1\/3\)/);
});

test("manual compaction shows while idle and the working indicator stays hidden", t => {
	const h = harness(t);
	const working = indicator("working", "Working...");
	h.show(working, 0);
	assert.doesNotMatch(h.render()[0], /Working/);
	const compaction = indicator("compaction", "Compacting context... (Esc to cancel)");
	h.show(compaction, 100);
	assert.match(h.render(1600)[0], / 00:01\.5 Compacting context Esc cancel /);
	assert.equal(h.forwarded.at(-1), compaction);
});

function eventBus() {
	const handlers = new Map();
	return {
		emit: (channel, data) => { for (const handler of handlers.get(channel) ?? []) handler(data); },
		on: (channel, handler) => {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
}

test("a recording borrows the idle top row, but live runs and statuses keep it", async t => {
	const events = eventBus();
	const voice = new TopBorderLink(events, "voice", () => {});
	voice.set(true); // Already recording when the session starts: the spinner's hello must learn it.
	const h = harness(t, events);
	assert.equal(voice.peerActive, false);
	h.emit("agent_start");
	assert.equal(voice.peerActive, true, "a run is busy");
	assert.match(h.render()[0], /Time 00:00\.0/, "the live run keeps the row");
	h.finish(10, 1000);
	h.settle();
	assert.equal(voice.peerActive, false);
	assert.equal(h.render()[0], "─".repeat(120), "the last-run summary steps aside");
	voice.set(false);
	assert.match(h.render()[0], /Last 00:01\.0/, "and comes back afterwards");
	h.show(indicator("compaction", "Compacting context... (Esc to cancel)"), 2000);
	assert.equal(voice.peerActive, true, "an idle status is busy too");
	h.show(undefined, 3000);
	assert.equal(voice.peerActive, true, "Pi clears before each replacement, so a clear waits a tick");
	await Promise.resolve();
	assert.equal(voice.peerActive, false);
});
