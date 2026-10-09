import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-share-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_OFFLINE;
delete process.env.STATUS_PLUS_POLL_LIMITS;
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");

const SHARE = join(agentDir, "status-plus-limits");
const STORE = Symbol.for("pi-extras.limit-store");
const NOW = Date.now();
const today = new Date(NOW);
const budget = { label: "", kind: "budget", remainingText: "$1106.83/$2000.00", resetMs: Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1), resetApprox: true };

const realFetch = globalThis.fetch;
let requests = 0;
let respond = () => new Response("{}", { status: 500 });
globalThis.fetch = async (url, options) => { requests++; return respond(url, options); };
after(() => {
	globalThis.fetch = realFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

beforeEach(() => {
	// Each test is a new Pi process: no snapshots in memory, and no shared file unless the test writes one.
	delete globalThis[STORE];
	rmSync(SHARE, { recursive: true, force: true });
	requests = 0;
});

function share(poll) {
	mkdirSync(SHARE, { recursive: true });
	writeFileSync(join(SHARE, "anthropic.json"), JSON.stringify(poll));
}

function app() {
	const handlers = new Map();
	let component;
	const branch = [{ type: "message", id: "r1", timestamp: new Date(NOW - 1000).toISOString(), message: {
		role: "assistant", provider: "anthropic", model: "claude", timestamp: NOW - 3000, content: [],
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
	} }];
	const ctx = {
		mode: "tui", model: { id: "claude", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
		modelRegistry: { getAll: () => [], find: () => undefined, getApiKeyForProvider: async () => "test-token", getProvider: () => undefined },
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
		row: () => component.render(240).map(stripAnsi).find((line) => line.startsWith("Ant")) ?? "",
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a new session shows the budget another Pi process polled, without asking Anthropic again", async (t) => {
	share({ atMs: NOW - 60_000, entries: [{ label: "5h", key: "five_hour", usedPct: 12 }, budget], triedAtMs: NOW - 60_000, failures: 0 });
	const footer = app();
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.match(footer.row(), /\$1106\.83\/\$2000\.00 left/);
	assert.equal(requests, 0);
});

test("response headers update the windows and keep the budget", async (t) => {
	// The poll is older than 15 minutes, so headers replace its windows; a recent failed try holds off a new poll.
	share({ atMs: NOW - 20 * 60_000, entries: [{ label: "5h", key: "five_hour", usedPct: 12 }, budget], triedAtMs: NOW - 60_000, failures: 1 });
	const footer = app();
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	// An old shared poll lends its budget, not windows that may have moved since.
	assert.match(footer.row(), /\$1106\.83\/\$2000\.00 left/);
	assert.doesNotMatch(footer.row(), /5h 12%/);
	await footer.emit("after_provider_response", { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.3" } });
	const row = footer.row();
	assert.match(row, /5h 30%/);
	assert.match(row, /\$1106\.83\/\$2000\.00 left/);
	assert.equal(requests, 0);
});

test("a refused poll is logged, and the next Pi process waits instead of asking again", async (t) => {
	respond = () => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "120" } });
	const first = app();
	await first.emit("session_start");
	t.after(() => first.emit("session_shutdown"));
	await settle();
	assert.equal(requests, 1);
	assert.match(readFileSync(join(agentDir, "status-plus.log"), "utf8"), /anthropic limit poll failed: HTTP 429/);
	const shared = JSON.parse(readFileSync(join(SHARE, "anthropic.json"), "utf8"));
	assert.equal(shared.failures, 1);
	assert.ok(shared.retryAtMs >= Date.now() + 110_000);

	delete globalThis[STORE];
	const second = app();
	await second.emit("session_start");
	t.after(() => second.emit("session_shutdown"));
	await settle();
	assert.equal(requests, 1);
});
