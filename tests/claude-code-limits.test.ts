import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodePaths, readClaudeCodeLogin } from "../lib/claude-code-login.ts";
import { setPlanAuthFile } from "../lib/plan-billing.ts";
import "./support/plan-login.ts";
import { LIMIT_POLLERS, limitFamily, parseLimitHeaders, pollAnthropicUsage } from "../lib/status-plus-limits.ts";

const NOW = Date.parse("2026-10-29T15:00:00Z");

function home(credentials: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "cc-login-"));
	mkdirSync(join(dir, ".claude"));
	if (credentials !== undefined) writeFileSync(join(dir, ".claude", ".credentials.json"), typeof credentials === "string" ? credentials : JSON.stringify(credentials));
	return dir;
}

const login = (expiresAt = NOW + 3_600_000) => ({ claudeAiOauth: { accessToken: "cc-test-token", expiresAt, subscriptionType: "enterprise" } });

test("Claude Code's login is read from its credentials file alone", (t) => {
	const dir = home(login());
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// No account file is read: the token is all the poll needs.
	writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-1" } }));
	assert.deepEqual(readClaudeCodeLogin(claudeCodePaths({}, dir), NOW), { token: "cc-test-token", expiresAtMs: NOW + 3_600_000 });
});

test("an expired, nearly expired, missing, unreadable or oversized Claude Code login reads as none", (t) => {
	const expired = home(login(NOW - 1));
	const expiring = home(login(NOW + 59_000));
	const missing = home(undefined);
	const broken = home({ claudeAiOauth: { accessToken: 7 } });
	const huge = home(JSON.stringify({ ...login(), pad: "x".repeat(64 * 1024) }));
	const fresh = home(login(NOW + 61_000));
	t.after(() => [expired, expiring, missing, broken, huge, fresh].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
	for (const dir of [expired, expiring, missing, broken, huge]) assert.equal(readClaudeCodeLogin(claudeCodePaths({}, dir), NOW), undefined, dir);
	assert.ok(readClaudeCodeLogin(claudeCodePaths({}, fresh), NOW), "a token with more than a minute left is a login");
});

test("PI_CLAUDE_CODE_CONFIG_DIR, then CLAUDE_CONFIG_DIR, moves Claude Code's credentials file", () => {
	assert.deepEqual(claudeCodePaths({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), { credentials: "/cfg/.credentials.json" });
	// pi-claude-code runs the CLI with PI_CLAUDE_CODE_CONFIG_DIR as its config directory when it is set.
	assert.deepEqual(claudeCodePaths({ PI_CLAUDE_CODE_CONFIG_DIR: "/pi-cfg", CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), { credentials: "/pi-cfg/.credentials.json" });
	assert.deepEqual(claudeCodePaths({}, "/home/u"), { credentials: "/home/u/.claude/.credentials.json" });
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
	const previous = setPlanAuthFile(authFile);
	t.after(() => setPlanAuthFile(previous));
	writeFileSync(authFile, JSON.stringify({ openai: { type: "oauth" } }));
	assert.equal(limitFamily("openai"), "openai-codex");
	// An API key bills per token and has no plan windows: the Codex meter must not stand in for it.
	writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key" } }));
	setPlanAuthFile(authFile);
	assert.equal(limitFamily("openai"), undefined);
});

test("headers from any member parse with the family's parser", () => {
	const headers = { "anthropic-ratelimit-unified-5h-utilization": "0.31", "anthropic-ratelimit-unified-5h-reset": String(Math.round(NOW / 1000) + 3600) };
	assert.deepEqual(parseLimitHeaders("claude-code", headers, NOW), parseLimitHeaders("anthropic", headers, NOW));
	assert.ok(parseLimitHeaders("claude-code", headers, NOW).length > 0);
});

const SPEND = { spend: { enabled: true, used: { amount_minor: 263104, exponent: 2 }, limit: { amount_minor: 300000 } } };

function recorder() {
	const seen: Array<{ url: string; auth: string | null }> = [];
	const redirects: Array<RequestInit["redirect"]> = [];
	const fetchImpl = async (url: string, init?: RequestInit) => {
		seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
		redirects.push(init?.redirect);
		return new Response(JSON.stringify(url.includes("quota") ? { extraUsage: { isEnabled: true, monthlyLimit: 3000, usedCredits: 2631.04 } } : SPEND));
	};
	return { seen, redirects, fetchImpl };
}

const anthropicCtx = (piToken: string | undefined, baseUrl?: string) => ({ modelRegistry: {
	getApiKeyForProvider: async (provider: string) => (provider === "anthropic" ? piToken : undefined),
	getProvider: (provider: string) => (provider === "anthropic" && baseUrl ? { baseUrl } : undefined),
} });

test("with no Pi anthropic login, the anthropic family polls once with Claude Code's own login", async () => {
	const { seen, redirects, fetchImpl } = recorder();
	let reads = 0;
	const entries = await pollAnthropicUsage(anthropicCtx(undefined), fetchImpl, () => { reads++; return { token: "cc-test-token" }; });
	assert.deepEqual(seen, [{ url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer cc-test-token" }]);
	assert.equal(entries?.find((entry) => entry.kind === "budget")?.remainingText, "$369/$3000");
	assert.equal(reads, 1);
	assert.deepEqual(redirects, ["error"], "the token never follows a redirect to another host");
	// No login anywhere: no poll.
	assert.equal(await pollAnthropicUsage(anthropicCtx(undefined), fetchImpl, () => undefined), undefined);
	assert.equal(seen.length, 1);
});

test("Pi's anthropic OAuth login comes first; an API key, which the usage endpoint refuses, gives way to Claude Code's", async () => {
	const { seen, fetchImpl } = recorder();
	await pollAnthropicUsage(anthropicCtx("pi-oauth-token"), fetchImpl, () => ({ token: "cc-test-token" }));
	await pollAnthropicUsage(anthropicCtx("sk-ant-api03-test"), fetchImpl, () => ({ token: "cc-test-token" }));
	// A registry that cannot answer for anthropic is no Pi login either.
	const failing = { modelRegistry: { getApiKeyForProvider: async () => { throw new Error("no provider"); }, getProvider: () => undefined } };
	await pollAnthropicUsage(failing, fetchImpl, () => ({ token: "cc-test-token" }));
	assert.deepEqual(seen.map((call) => call.auth), ["Bearer pi-oauth-token", "Bearer cc-test-token", "Bearer cc-test-token"]);
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
