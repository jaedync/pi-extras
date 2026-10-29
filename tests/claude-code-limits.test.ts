import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodePaths, readClaudeCodeLogin } from "../lib/claude-code-login.ts";
import { LIMIT_POLLERS, limitFamily, parseLimitHeaders, pollAnthropicUsage } from "../lib/status-plus-limits.ts";

const NOW = Date.parse("2026-10-29T15:00:00Z");

function home(credentials: unknown, account?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "cc-login-"));
	mkdirSync(join(dir, ".claude"));
	if (credentials !== undefined) writeFileSync(join(dir, ".claude", ".credentials.json"), JSON.stringify(credentials));
	if (account !== undefined) writeFileSync(join(dir, ".claude.json"), JSON.stringify(account));
	return dir;
}

const login = (expiresAt = NOW + 3_600_000) => ({ claudeAiOauth: { accessToken: "cc-test-token", expiresAt, subscriptionType: "enterprise" } });
const account = { oauthAccount: { accountUuid: "acct-1", organizationUuid: "org-1" } };

test("Claude Code's login is read from its own files, with the account it names", (t) => {
	const dir = home(login(), account);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const found = readClaudeCodeLogin(claudeCodePaths({}, dir), NOW);
	assert.deepEqual(found, { token: "cc-test-token", expiresAtMs: NOW + 3_600_000, accountUuid: "acct-1", organizationUuid: "org-1" });
});

test("an expired, missing or unreadable Claude Code login reads as none", (t) => {
	const expired = home(login(NOW - 1), account);
	const missing = home(undefined, account);
	const broken = home({ claudeAiOauth: { accessToken: 7 } });
	t.after(() => [expired, missing, broken].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
	assert.equal(readClaudeCodeLogin(claudeCodePaths({}, expired), NOW), undefined);
	assert.equal(readClaudeCodeLogin(claudeCodePaths({}, missing), NOW), undefined);
	assert.equal(readClaudeCodeLogin(claudeCodePaths({}, broken), NOW), undefined);
});

test("PI_CLAUDE_CODE_CONFIG_DIR, then CLAUDE_CONFIG_DIR, moves both of Claude Code's files", () => {
	assert.deepEqual(claudeCodePaths({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), { credentials: "/cfg/.credentials.json", account: "/cfg/.claude.json" });
	// pi-claude-code runs the CLI with PI_CLAUDE_CODE_CONFIG_DIR as its config directory when it is set.
	assert.deepEqual(claudeCodePaths({ PI_CLAUDE_CODE_CONFIG_DIR: "/pi-cfg", CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), { credentials: "/pi-cfg/.credentials.json", account: "/pi-cfg/.claude.json" });
	assert.deepEqual(claudeCodePaths({}, "/home/u"), { credentials: "/home/u/.claude/.credentials.json", account: "/home/u/.claude.json" });
});

test("pollers are keyed by family: claude-code and openai poll their family's plan, not a second time", () => {
	assert.deepEqual(Object.keys(LIMIT_POLLERS).sort(), ["anthropic", "openai-codex", "opencode-go", "openrouter"]);
	assert.equal(limitFamily("claude-code"), "anthropic");
	assert.equal(limitFamily("meridian"), "anthropic");
	assert.equal(limitFamily("openai-codex"), "openai-codex");
	assert.equal(limitFamily("kimi-coding"), undefined);
});

test("an openai login asks for the Codex plan poll only when it is Sign in with ChatGPT", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "openai-family-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const authFile = join(dir, "auth.json");
	writeFileSync(authFile, JSON.stringify({ openai: { type: "oauth" } }));
	assert.equal(limitFamily("openai", authFile), "openai-codex");
	// An API key bills per token and has no plan windows: the Codex meter must not stand in for it.
	writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key" } }));
	assert.equal(limitFamily("openai", authFile), undefined);
});

test("headers from any member parse with the family's parser", () => {
	const headers = { "anthropic-ratelimit-unified-5h-utilization": "0.31", "anthropic-ratelimit-unified-5h-reset": String(Math.round(NOW / 1000) + 3600) };
	assert.deepEqual(parseLimitHeaders("claude-code", headers, NOW), parseLimitHeaders("anthropic", headers, NOW));
	assert.ok(parseLimitHeaders("claude-code", headers, NOW).length > 0);
});

const SPEND = { spend: { enabled: true, used: { amount_minor: 263104, exponent: 2 }, limit: { amount_minor: 300000 } } };

function recorder() {
	const seen: Array<{ url: string; auth: string | null }> = [];
	const fetchImpl = async (url: string, init?: RequestInit) => {
		seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify(url.includes("quota") ? { extraUsage: { isEnabled: true, monthlyLimit: 3000, usedCredits: 2631.04 } } : SPEND));
	};
	return { seen, fetchImpl };
}

const anthropicCtx = (piToken: string | undefined, baseUrl?: string) => ({ modelRegistry: {
	getApiKeyForProvider: async (provider: string) => (provider === "anthropic" ? piToken : undefined),
	getProvider: (provider: string) => (provider === "anthropic" && baseUrl ? { baseUrl } : undefined),
} });

test("with no Pi anthropic login, the anthropic family polls once with Claude Code's own login", async () => {
	const { seen, fetchImpl } = recorder();
	let reads = 0;
	const entries = await pollAnthropicUsage(anthropicCtx(undefined), fetchImpl, () => { reads++; return { token: "cc-test-token" }; });
	assert.deepEqual(seen, [{ url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer cc-test-token" }]);
	assert.equal(entries?.find((entry) => entry.kind === "budget")?.remainingText, "$369/$3000");
	assert.equal(reads, 1);
	// No login anywhere: no poll.
	assert.equal(await pollAnthropicUsage(anthropicCtx(undefined), fetchImpl, () => undefined), undefined);
	assert.equal(seen.length, 1);
});

test("Pi's anthropic OAuth login comes first; an API key, which the usage endpoint refuses, gives way to Claude Code's", async () => {
	const { seen, fetchImpl } = recorder();
	await pollAnthropicUsage(anthropicCtx("pi-oauth-token"), fetchImpl, () => ({ token: "cc-test-token" }));
	await pollAnthropicUsage(anthropicCtx("sk-ant-api03-test"), fetchImpl, () => ({ token: "cc-test-token" }));
	assert.deepEqual(seen.map((call) => call.auth), ["Bearer pi-oauth-token", "Bearer cc-test-token"]);
});

test("a proxy quota route on the anthropic provider wins over both logins", async () => {
	const { seen, fetchImpl } = recorder();
	let reads = 0;
	const entries = await pollAnthropicUsage(anthropicCtx("pi-oauth-token", "http://127.0.0.1:3456"), fetchImpl, () => { reads++; return { token: "cc-test-token" }; });
	assert.equal(seen.length, 1);
	assert.match(seen[0]!.url, /^http:\/\/127\.0\.0\.1:3456\//);
	assert.equal(seen[0]!.auth, null);
	assert.equal(reads, 0);
	assert.ok(entries?.length);
});
