import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-catch-up-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");

const START = 1_750_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

/** A child session whose read tool output makes it 7 MB; its one reply costs $0.50. */
function child(dir, i) {
	const file = join(dir, `child-${i}.jsonl`);
	// Children never share a reply; identical ones would count once, as copies.
	const start = START + i * 10_000;
	const entries = [
		{ type: "message", id: `task-${i}`, timestamp: iso(start), message: { role: "user", timestamp: start, content: `task ${i}` } },
		{ type: "message", id: `out-${i}`, timestamp: iso(start), message: { role: "toolResult", toolCallId: `read-${i}`, toolName: "read", content: [{ type: "text", text: "x".repeat(7 * 1024 * 1024) }] } },
		{ type: "message", id: `reply-${i}`, timestamp: iso(start + 2000), message: {
			role: "assistant", provider: "anthropic", model: "m", timestamp: start, content: [],
			usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
		} },
	];
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return { type: "message", timestamp: iso(START), message: { role: "toolResult", toolName: "subagent", toolCallId: `spawn-${i}`, details: { name: `child-${i}`, sessionFile: file } } };
}

function app(branch, sessionDir) {
	const handlers = new Map();
	let component;
	const ctx = {
		mode: "tui", model: { id: "m", provider: "anthropic" },
		modelRegistry: { getAll: () => [], find: () => undefined },
		sessionManager: {
			getBranch: () => branch, getLeafId: () => null,
			getSessionDir: () => sessionDir, getSessionFile: () => undefined, getCwd: () => "~", getSessionName: () => undefined,
		},
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} }, appendEntry() {} });
	return { emit: (name, event = {}) => handlers.get(name)(event, ctx), lines: () => component.render(200).map(stripAnsi) };
}

test("after a walk that could not read every child, the footer catches up at once and does not show it as a charge", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "status-plus-catch-up-children-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const branch = Array.from({ length: 10 }, (_, i) => child(dir, i));
	const footer = app(branch, dir);
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	// The first walk reads 63 of the 70 MB; the last child is read by the next walk, not 30 s later.
	assert.match(footer.lines().find((line) => line.startsWith("Ant")), /^Ant {2}\$4\.50/);
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const lines = footer.lines();
	assert.match(lines.find((line) => line.startsWith("Ant")), /^Ant {2}\$5\.00/);
	assert.doesNotMatch(lines.join("\n"), /\+\$/);
});

after(() => rmSync(agentDir, { recursive: true, force: true }));
