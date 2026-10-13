import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-virtual-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.STATUS_PLUS_POLL_LIMITS = "0";
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const NOW = Date.now();
const SONNET = { provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages", contextWindow: 200_000 };

function app() {
	const handlers = new Map();
	let component;
	const branch = [{ type: "message", id: "r1", timestamp: new Date(NOW - 1000).toISOString(), message: {
		role: "assistant", provider: "anthropic", model: "claude-sonnet-5", stopReason: "stop", timestamp: NOW - 3000, content: [],
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
	} }];
	const ctx = {
		mode: "tui", model: { id: "auto", provider: "router", api: "pi-virtual" },
		modelRegistry: { getAll: () => [], find: (provider, id) => (provider === "anthropic" && id === SONNET.id ? SONNET : undefined), getApiKeyForProvider: async () => undefined, getProvider: () => undefined },
		sessionManager: {
			getBranch: () => branch, getLeafId: () => "r1",
			getSessionDir: () => "/nonexistent-status-plus-test", getSessionFile: () => undefined, getCwd: () => "~", getSessionName: () => undefined,
		},
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, setFooter(factory) {
			component = factory({ requestRender() {} }, { fg: (_tone, text) => text }, {
				getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		} },
	};
	statusPlus({ on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} }, appendEntry() {} });
	return {
		emit: (name, event = {}) => handlers.get(name)(event, ctx),
		lines: () => component.render(240).map(stripAnsi),
	};
}

test("under a virtual selection, header limits go to the routed provider and the footer shows the route", async (t) => {
	const footer = app();
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await footer.emit("after_provider_response", { status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.3" } });
	await footer.emit("message_end", { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5", stopReason: "stop", timestamp: NOW, content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	const lines = footer.lines();
	assert.match(lines.find((line) => line.startsWith("Ant")) ?? "", /5h 30%/);
	assert.ok(lines.some((line) => line.includes("auto → claude-sonnet-5")), lines.join("\n"));
});
