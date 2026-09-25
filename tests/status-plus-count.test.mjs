import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The saved choice goes to pi-extras.json, so it must land in a scratch agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "status-plus-count-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");
const { CHAIN_ENTRY, CHAIN_EVENT } = await import("../lib/chain/run.ts");
const { TOOL_COUNT_EVENT } = await import("../lib/tool-count.ts");

const START = 1_750_000_000_000;
const step = { at: 1, ms: 5 };

function assistant(toolCalls) {
	return { type: "message", timestamp: new Date(START).toISOString(), message: {
		role: "assistant", provider: "test-provider", model: "test", timestamp: START - 1000,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		content: Array.from({ length: toolCalls }, () => ({ type: "toolCall" })),
	} };
}

function app(branch) {
	const handlers = new Map();
	const listeners = new Map();
	let component;
	const ctx = {
		mode: "tui", model: { id: "test", provider: "test-provider" },
		sessionManager: { getBranch: () => branch, getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~", getSessionName: () => undefined },
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on: (name, handler) => listeners.set(name, handler), emit() {} } });
	return {
		start: () => handlers.get("session_start")({}, ctx),
		stop: () => handlers.get("session_shutdown")({}, ctx),
		emit: (name, data) => listeners.get(name)(data),
		tools: () => /(\d+) tools/.exec(stripAnsi(component.render(200).join("\n")))[1],
		click(offset = 0) {
			const lines = component.render(200).map(stripAnsi);
			const y = lines.findIndex((line) => line.includes(" tools"));
			const x = lines[y].indexOf(`${this.tools()} tools`) + offset;
			return component.handleMouse({ type: "click", button: "left", x, y, width: 200, height: lines.length });
		},
	};
}

test("a click on the tool figure counts chain steps, is saved, and a second click counts calls again", async (t) => {
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const branch = [assistant(3), { type: "custom", timestamp: new Date(START).toISOString(), customType: CHAIN_ENTRY, data: { v: 1, toolCallId: "c1", steps: [step, step, step] } }];
	const first = app(branch);
	await first.start();
	try {
		assert.equal(first.tools(), "3");
		assert.deepEqual(first.click(), { handled: true });
		assert.equal(first.tools(), "5");
		assert.equal(JSON.parse(readFileSync(join(agentDir, "pi-extras.json"), "utf8")).statusPlus.toolCount, "steps");
		// A chain that finished this turn counts before it reaches the transcript.
		first.emit(CHAIN_EVENT, { toolCallId: "c2", ran: 4 });
		assert.equal(first.tools(), "8");
		// Elsewhere on the footer, or not a left click: nothing.
		assert.equal(first.click(-5), undefined);
		assert.equal(first.click(0) && first.tools(), "3");
	} finally {
		await first.stop();
	}
	// The choice outlives the session; /tool-display count switches it without a click.
	const second = app(branch);
	await second.start();
	try {
		assert.equal(second.tools(), "3");
		second.emit(TOOL_COUNT_EVENT, "steps");
		assert.equal(second.tools(), "5");
		second.emit(TOOL_COUNT_EVENT, "sideways");
		assert.equal(second.tools(), "5");
	} finally {
		await second.stop();
	}
});
