import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function app(baseUrl = "https://api.anthropic.com") {
	const handlers = new Map();
	let component;
	const branch = [{ type: "message", id: "r1", timestamp: new Date(NOW - 1000).toISOString(), message: {
		role: "assistant", provider: "anthropic", model: "claude", timestamp: NOW - 3000, content: [],
		usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
	} }];
	const ctx = {
		mode: "tui", model: { id: "claude", provider: "anthropic", baseUrl },
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

test("a proxy answer without its OAuth source keeps the recent windows another process polled", async (t) => {
	const fetchedAt = NOW - 60_000;
	const good = [
		{ label: "5h", key: "five_hour", usedPct: 46, windowSeconds: 18_000, resetMs: NOW + 3_600_000, sampledMs: fetchedAt },
		{ label: "7d", key: "seven_day", usedPct: 37, windowSeconds: 604_800, resetMs: NOW + 86_400_000, sampledMs: fetchedAt },
	];
	share({ atMs: fetchedAt, entries: good, triedAtMs: NOW - 120_000, failures: 0 });
	respond = () => new Response(JSON.stringify({
		buckets: [{ type: "seven_day", status: "allowed_warning", utilization: 0.96, resetsAt: NOW + 86_400_000, observedAt: Date.now() - 120_000 }],
		extraUsage: null, sources: { oauth: null, sdk: { entryCount: 1 } }, asOf: Date.now(),
	}));
	const footer = app("http://127.0.0.1:3456");
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.equal(requests, 1);
	const row = footer.row();
	assert.match(row, /5h 46%/);
	assert.match(row, /7d 37%/);
	const shared = JSON.parse(readFileSync(join(SHARE, "anthropic.json"), "utf8"));
	assert.deepEqual(shared.entries.map((entry) => [entry.key, entry.usedPct]), [["seven_day", 37], ["five_hour", 46]]);
});

test("a Retry-After holds this process's polls when the shared poll file cannot be written", async (t) => {
	// A file where the folder should be: every shared write fails.
	writeFileSync(SHARE, "not a folder");
	t.after(() => rmSync(SHARE, { force: true }));
	respond = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
	const footer = app();
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.equal(requests, 1);
	const realNow = Date.now;
	Date.now = () => realNow() + 10_000;
	t.after(() => { Date.now = realNow; });
	await globalThis[STORE].refresh("anthropic", true);
	assert.equal(requests, 1);
});

test("every polled entry in the shared file carries its sample time", async (t) => {
	respond = () => new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(NOW + 3_600_000).toISOString() } }));
	const footer = app();
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.equal(requests, 1);
	const shared = JSON.parse(readFileSync(join(SHARE, "anthropic.json"), "utf8"));
	assert.ok(shared.entries.length > 0);
	assert.ok(shared.entries.every((entry) => entry.sampledMs === shared.atMs), JSON.stringify(shared.entries));
});

test("windows that an older installed copy shared, with no sample time, show as approximate", async (t) => {
	// An older copy shared a Claude Code reading as it was: no mark, no sample time.
	share({ atMs: NOW - 60_000, entries: [{ label: "7d", key: "seven_day", usedPct: 96, windowSeconds: 604_800, resetMs: NOW + 86_400_000 }, budget], triedAtMs: NOW - 60_000, failures: 0 });
	const footer = app();
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.equal(requests, 0);
	const row = footer.row();
	assert.match(row, /7d ~96%/);
	assert.match(row, /\$1106\.83\/\$2000\.00 left/, "a budget keeps its dollar figures");
});

test("an approximate reading far from the last usage-endpoint reading is logged with both, one time", async (t) => {
	const fetchedAt = NOW - 60_000;
	share({ atMs: fetchedAt, entries: [
		{ label: "5h", key: "five_hour", usedPct: 46, windowSeconds: 18_000, resetMs: NOW + 3_600_000, sampledMs: fetchedAt },
		{ label: "7d", key: "seven_day", usedPct: 37, windowSeconds: 604_800, resetMs: NOW + 86_400_000, sampledMs: fetchedAt },
	], triedAtMs: NOW - 120_000, failures: 0 });
	const observedAt = NOW - 120_000;
	respond = () => new Response(JSON.stringify({
		buckets: [{ type: "seven_day", status: "allowed_warning", utilization: 0.96, surpassedThreshold: 0.75, resetsAt: NOW + 86_400_000, observedAt }],
		extraUsage: null, sources: { oauth: null, sdk: { entryCount: 1 } }, asOf: Date.now(),
	}));
	const log = join(agentDir, "status-plus.log");
	const before = existsSync(log) ? readFileSync(log, "utf8").length : 0;
	const footer = app("http://127.0.0.1:3456");
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.equal(requests, 1);
	const realNow = Date.now;
	Date.now = () => realNow() + 61_000;
	t.after(() => { Date.now = realNow; });
	await globalThis[STORE].refresh("anthropic", true);
	assert.equal(requests, 2, "the same reading came a second time");
	const lines = readFileSync(log, "utf8").slice(before).split("\n").filter((line) => line.includes("reading differs"));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], /approximate anthropic seven_day reading differs from the usage endpoint: 96% \(status allowed_warning, surpassed 0\.75, reset \S+, sampled 120 s ago\) vs 37% \(reset \S+, sampled 60 s ago\)/);
});
