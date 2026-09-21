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

function harness(t) {
	let now = 0;
	let idle = false;
	t.mock.method(performance, "now", () => now);
	const handlers = new Map();
	phaseSpinner({ on: (name, handler) => handlers.set(name, handler) });
	const base = { render: width => ["─".repeat(width), "input"], getText: () => "", invalidate() {} };
	let factory = () => base;
	const ctx = {
		isIdle: () => idle,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: value => { factory = value; },
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
	return { emit, update, finish, render: () => editor.render(120), settle: () => { idle = true; emit("agent_settled"); } };
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
