import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "status-plus-family-"));
const claudeDir = join(agentDir, "claude-config");
process.env.PI_CODING_AGENT_DIR = agentDir;
// Claude Code's login comes from this temp directory, never from the real home.
process.env.PI_CLAUDE_CODE_CONFIG_DIR = claudeDir;
delete process.env.PI_OFFLINE;
delete process.env.STATUS_PLUS_POLL_LIMITS;
const { default: statusPlus } = await import("../extensions/status-plus.ts");
const { stripAnsi } = await import("../lib/ansi.ts");
const { noteAnthropicApiKey, planBilled, setPlanAuthFile } = await import("../lib/plan-billing.ts");

const SHARE = join(agentDir, "status-plus-limits");
const STORE = Symbol.for("pi-extras.limit-store");
const NOW = Date.now();
const SPEND = { spend: { enabled: true, used: { amount_minor: 263104, exponent: 2 }, limit: { amount_minor: 300000 } } };
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const CLAUDE_CODE = { id: "claude-opus-5-5", provider: "claude-code", baseUrl: "process://claude-code", cost: PRICE };
const CLAUDE = { id: "claude-opus-5-5", provider: "anthropic", baseUrl: "https://api.anthropic.com", cost: PRICE };

const realFetch = globalThis.fetch;
let calls = [];
globalThis.fetch = async (url, init) => {
	calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
	return new Response(JSON.stringify(SPEND), { status: 200 });
};
after(() => {
	globalThis.fetch = realFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

beforeEach(() => {
	delete globalThis[STORE];
	rmSync(SHARE, { recursive: true, force: true });
	rmSync(claudeDir, { recursive: true, force: true });
	calls = [];
	rmSync(AUTH, { force: true });
	setPlanAuthFile(undefined);
	noteAnthropicApiKey(false);
});

const AUTH = join(agentDir, "auth.json");
/** Sign in with ChatGPT for openai, and an openai-codex login kept as the plan's meter. */
function chatgptLogins() {
	writeFileSync(AUTH, JSON.stringify({ openai: { type: "oauth" }, "openai-codex": { type: "oauth", access: "codex-test-token", accountId: "acct-test" } }));
	setPlanAuthFile(undefined);
}

function share(provider, entries) {
	mkdirSync(SHARE, { recursive: true });
	writeFileSync(join(SHARE, `${provider}.json`), JSON.stringify({ atMs: NOW - 5_000, entries, triedAtMs: NOW - 5_000, failures: 0 }));
}

function claudeCodeLogin() {
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "cc-test-token", expiresAt: NOW + 3_600_000 } }));
}

const reply = (id, provider, cost) => ({ type: "message", id, timestamp: new Date(NOW - 1000).toISOString(), message: {
	role: "assistant", provider, model: "claude-opus-5-5", timestamp: NOW - 3000, content: [],
	usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
} });

function app({ model = CLAUDE_CODE, branch, piToken }) {
	const handlers = new Map();
	let component;
	const ctx = {
		mode: "tui", model,
		modelRegistry: {
			getAll: () => [CLAUDE_CODE, CLAUDE], find: () => undefined,
			getApiKeyForProvider: async (provider) => (provider === "anthropic" ? piToken : undefined),
			getProvider: () => undefined,
		},
		sessionManager: {
			getBranch: () => branch, getLeafId: () => branch.at(-1)?.id,
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
const rows = (lines, tag) => lines.filter((line) => line.startsWith(tag));

test("a claude-code session adopts the anthropic family's shared poll and shows its budget on one Ant row", async (t) => {
	share("anthropic", [{ label: "", kind: "budget", remainingText: "$369/$3000", usedUsd: 2631.04, limitUsd: 3000 }]);
	const footer = app({ branch: [reply("r1", "claude-code", 0.5)] });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	const ant = rows(footer.lines(), "Ant");
	assert.equal(ant.length, 1, footer.lines().join("\n"));
	assert.match(ant[0], /\$369\/\$3000/);
	assert.match(ant[0], /\$0\.50/);
	assert.deepEqual(calls, [], "a fresh shared poll stands in for one of our own");
});

test("anthropic and claude-code spend sum into one Ant row, polled once for the family", async (t) => {
	const footer = app({ branch: [reply("r1", "anthropic", 0.5), reply("r2", "claude-code", 0.25)], piToken: "pi-oauth-token" });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	const ant = rows(footer.lines(), "Ant");
	assert.equal(ant.length, 1, footer.lines().join("\n"));
	assert.match(ant[0], /\$0\.75/);
	assert.match(ant[0], /\$369\/\$3000/);
	assert.deepEqual(calls.map((call) => call.url), ["https://api.anthropic.com/api/oauth/usage"]);
	assert.ok(existsSync(join(SHARE, "anthropic.json")));
	assert.ok(!existsSync(join(SHARE, "claude-code.json")));
});

test("with no Pi anthropic login, a claude-code session polls with Claude Code's own login", async (t) => {
	claudeCodeLogin();
	const footer = app({ branch: [reply("r1", "claude-code", 0.5)] });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.deepEqual(calls, [{ url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer cc-test-token" }]);
	assert.match(rows(footer.lines(), "Ant")[0] ?? "", /\$369\/\$3000/);
});

test("a selected claude-code model with no requests yet shows the family's limits", async (t) => {
	share("anthropic", [{ label: "", kind: "budget", remainingText: "$369/$3000", usedUsd: 2631.04, limitUsd: 3000 }]);
	const footer = app({ branch: [] });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await footer.emit("model_select", { model: CLAUDE_CODE, source: "set" });
	await settle();
	const ant = rows(footer.lines(), "Ant");
	assert.equal(ant.length, 1, footer.lines().join("\n"));
	assert.match(ant[0], /\$369\/\$3000/);
	assert.deepEqual(calls, []);
});

test("openai and openai-codex spend share one Cdx row", async (t) => {
	chatgptLogins();
	share("openai-codex", [{ label: "5h", key: "primary", usedPct: 30, windowSeconds: 18_000, resetMs: NOW + 3_600_000 }]);
	const footer = app({ model: CLAUDE, branch: [reply("r1", "openai", 0.5), reply("r2", "openai-codex", 0.25)] });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	const cdx = rows(footer.lines(), "Cdx");
	assert.equal(cdx.length, 1, footer.lines().join("\n"));
	assert.match(cdx[0], /\$0\.75/);
	assert.match(cdx[0], /5h ~?30%/);
});

test("openai with Sign in with ChatGPT and openai-codex poll the Codex plan once, under openai-codex", async (t) => {
	chatgptLogins();
	const footer = app({ model: CLAUDE, branch: [reply("r1", "openai", 0.5), reply("r2", "openai-codex", 0.25)] });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await footer.emit("model_select", { model: { ...CLAUDE, provider: "openai", id: "gpt-6.1-sol" }, source: "set" });
	await settle();
	assert.deepEqual(calls.map((call) => call.url), ["https://chatgpt.com/backend-api/wham/usage"]);
	assert.ok(existsSync(join(SHARE, "openai-codex.json")));
	assert.ok(!existsSync(join(SHARE, "openai.json")));
});

test("an anthropic API key is no plan login: its spend stays off the plan's row, even when another process polled", async (t) => {
	share("anthropic", [{ label: "", kind: "budget", remainingText: "$369/$3000", usedUsd: 2631.04, limitUsd: 3000 }]);
	const footer = app({ branch: [reply("r1", "anthropic", 0.5), reply("r2", "claude-code", 0.25)], piToken: "sk-ant-api03-test" });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.equal(planBilled("anthropic"), false);
	assert.deepEqual(calls, [], "the fresh shared poll stands in for one of our own");
	// The API key's row has a label of its own, so the two Anthropic rows can be told apart.
	const key = rows(footer.lines(), "Ant key");
	const plan = rows(footer.lines(), "Ant").filter((line) => !line.startsWith("Ant key"));
	assert.equal(key.length, 1, footer.lines().join("\n"));
	assert.equal(plan.length, 1, footer.lines().join("\n"));
	assert.match(key[0], /\$0\.50/);
	assert.doesNotMatch(key[0], /\$369/);
	assert.match(plan[0], /\$0\.25/);
	assert.match(plan[0], /\$369\/\$3000/);
});

test("concurrent reads for anthropic and claude-code make one poll", async (t) => {
	// A local model at the start: nothing of the Anthropic family is polled yet.
	const footer = app({ model: { id: "local", provider: "fw01", baseUrl: "http://127.0.0.1:1" }, branch: [], piToken: "pi-oauth-token" });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.deepEqual(calls, []);
	const store = globalThis[STORE];
	await Promise.all([store.refresh("anthropic", false), store.refresh("claude-code", false), store.refresh("meridian", false)]);
	assert.deepEqual(calls.map((call) => call.url), ["https://api.anthropic.com/api/oauth/usage"]);
	assert.ok(existsSync(join(SHARE, "anthropic.json")));
	assert.ok(!existsSync(join(SHARE, "claude-code.json")));
	assert.ok(!existsSync(join(SHARE, "meridian.json")));
});

test("offline, Status Plus asks Pi for no anthropic credential", async (t) => {
	process.env.PI_OFFLINE = "1";
	t.after(() => { delete process.env.PI_OFFLINE; });
	const footer = app({ branch: [reply("r1", "anthropic", 0.5)], piToken: "sk-ant-api03-test" });
	const asked = [];
	footer.ctx.modelRegistry.getApiKeyForProvider = async (provider) => { asked.push(provider); };
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	await settle();
	assert.deepEqual(asked, []);
	assert.deepEqual(calls, []);
});

test("an anthropic API-key session polls no plan and reads no Claude Code login; its row shows at once", async (t) => {
	claudeCodeLogin();
	const footer = app({ model: CLAUDE, branch: [reply("r1", "anthropic", 0.5)], piToken: "sk-ant-api03-test" });
	await footer.emit("session_start");
	t.after(() => footer.emit("session_shutdown"));
	// The first frame already knows the credential is an API key.
	assert.equal(planBilled("anthropic"), false);
	assert.equal(rows(footer.lines(), "Ant key").length, 1, footer.lines().join("\n"));
	await settle();
	assert.deepEqual(calls, []);
	assert.ok(!existsSync(join(SHARE, "anthropic.json")));
	// claude-code bills the plan: selecting it polls the plan with Claude Code's login.
	footer.ctx.model = CLAUDE_CODE;
	await footer.emit("model_select", { model: CLAUDE_CODE, source: "set" });
	await settle();
	assert.deepEqual(calls, [{ url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer cc-test-token" }]);
});
