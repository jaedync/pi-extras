import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodePaths, readClaudeCodeLogin } from "../lib/claude-code-login.ts";
import { LIMIT_POLLERS, pollClaudeCodeUsage } from "../lib/status-plus-limits.ts";

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

test("CLAUDE_CONFIG_DIR moves both of Claude Code's files", () => {
	assert.deepEqual(claudeCodePaths({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), { credentials: "/cfg/.credentials.json", account: "/cfg/.claude.json" });
	assert.deepEqual(claudeCodePaths({}, "/home/u"), { credentials: "/home/u/.claude/.credentials.json", account: "/home/u/.claude.json" });
});

test("the claude-code reading polls the Anthropic meter with Claude Code's own token", async () => {
	const seen: Array<{ url: string; auth: string | null }> = [];
	const fetchImpl = async (url: string, init?: RequestInit) => {
		seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify({ spend: { enabled: true, used: { amount_minor: 263104, exponent: 2 }, limit: { amount_minor: 300000 } } }));
	};
	const entries = await pollClaudeCodeUsage({ token: "cc-test-token" }, fetchImpl);
	assert.deepEqual(seen, [{ url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer cc-test-token" }]);
	const budget = entries?.find((entry) => entry.kind === "budget");
	assert.equal(budget?.remainingText, "$369/$3000");
	assert.equal(await pollClaudeCodeUsage(undefined, fetchImpl), undefined);
	assert.equal(seen.length, 1);
});

test("claude-code has a limit poller, so its row is not reported as having no endpoint", () => {
	assert.ok(Object.hasOwn(LIMIT_POLLERS, "claude-code"));
});
