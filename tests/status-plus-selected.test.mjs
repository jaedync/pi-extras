import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-selected-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_OFFLINE;
delete process.env.STATUS_PLUS_POLL_LIMITS;
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");

const SHARE = join(agentDir, "status-plus-limits");
const STORE = Symbol.for("pi-extras.limit-store");
const NOW = Date.now();
const CLAUDE = { id: "claude", provider: "anthropic", baseUrl: "https://api.anthropic.com" };
const GLM = { id: "glm-5.3", provider: "opencode-go", cost: { input: 1, output: 2 } };
const LOCAL = { id: "local", provider: "fw01", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => { requests++; return new Response("{}", { status: 500 }); };
after(() => {
	globalThis.fetch = realFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

beforeEach(() => {
	delete globalThis[STORE];
	rmSync(SHARE, { recursive: true, force: true });
	requests = 0;
});

/** A fresh poll by another Pi process, so no test reaches the network for these providers. */
function share(provider, entries) {
	mkdirSync(SHARE, { recursive: true });
	writeFileSync(join(SHARE, `${provider}.json`), JSON.stringify({ atMs: NOW - 5_000, entries, triedAtMs: NOW - 5_000, failures: 0 }));
}

function app() {
	const handlers = new Map();
	let component;
	const branch = [{ type: "message", id: "r1", timestamp: new Date(NOW - 1000).toISOString(), message: {
		role: "assistant", provider: "anthropic", model: "claude", timestamp: NOW - 3000, content: [],
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
	} }];
	const ctx = {
		mode: "tui", model: CLAUDE,
		modelRegistry: { getAll: () => [CLAUDE, GLM, LOCAL], find: () => undefined, getApiKeyForProvider: async () => "test-token", getProvider: () => undefined },
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
		ctx,
		emit: (name, event = {}) => handlers.get(name)(event, ctx),
		lines: () => component.render(240).map(stripAnsi),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a switch to a provider with no requests yet shows its limits at once", async (t) => {
	share("anthropic", [{ label: "5h", key: "five_hour", usedPct: 12 }]);
	share("opencode-go", [{ label: "5h", key: "rolling", usedPct: 40, windowSeconds: 18_000, resetMs: NOW + 3_600_000 }]);
	const footer = app();
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.ok(!footer.lines().some((line) => line.startsWith("Go")), "an unselected, unused provider has no row");
	footer.ctx.model = GLM;
	await footer.emit("model_select", { model: GLM, previousModel: CLAUDE, source: "set" });
	await settle();
	const row = footer.lines().find((line) => line.startsWith("Go")) ?? "";
	assert.match(row, /\$0\.00/);
	assert.match(row, /5h ~?40%/);
	assert.equal(requests, 0, "the shared poll stands in for one of our own");
	// Once another model is selected, the unused provider's row goes again.
	footer.ctx.model = CLAUDE;
	await footer.emit("model_select", { model: CLAUDE, previousModel: GLM, source: "set" });
	assert.ok(!footer.lines().some((line) => line.startsWith("Go")));
});

test("a selected free provider with no tokens gets no row", async (t) => {
	share("anthropic", [{ label: "5h", key: "five_hour", usedPct: 12 }]);
	const footer = app();
	footer.ctx.model = LOCAL;
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await footer.emit("model_select", { model: LOCAL, previousModel: CLAUDE, source: "set" });
	await settle();
	const lines = footer.lines();
	assert.ok(!lines.some((line) => line.startsWith("fw01")), lines.join("\n"));
	assert.ok(lines.some((line) => line.startsWith("Ant")), "the used provider keeps its row");
});
