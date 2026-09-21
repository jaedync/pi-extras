import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	codexAccessToken,
	codexAccountId,
	codexCredentials,
	parseCodexUsage,
	parseOpenCodeGoUsage,
	planLabel,
	usageWindowLabel,
	pollCodexUsage,
	pollOpenCodeGoUsage,
} from "../lib/provider-limits.ts";

const codexBody = {
	plan_type: "Plus",
	rate_limit: {
		primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 2000000000 },
		secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 2000600000 },
	},
};

const goBody = {
	usage: {
		rolling: { percent: 100, status: "rate-limited", resetsAt: "2033-05-18T03:33:20Z" },
		weekly: { percent: 3, resetsAt: "2033-05-24T03:33:20Z" },
		monthly: { percent: "n/a" },
	},
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("parseCodexUsage normalizes windows to ms resets and lowercases the plan", () => {
	assert.deepEqual(parseCodexUsage(codexBody), {
		provider: "codex",
		plan: "plus",
		windows: [
			{ key: "primary", pct: 42, windowSeconds: 18000, resetsAtMs: 2000000000000 },
			{ key: "secondary", pct: 7, windowSeconds: 604800, resetsAtMs: 2000600000000 },
		],
	});
});

test("parseCodexUsage returns nothing without a numeric window", () => {
	assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "42" } } }), undefined);
	assert.equal(parseCodexUsage(null), undefined);
});

test("window labels follow duration, not the primary or secondary slot", () => {
	assert.equal(usageWindowLabel({ key: "primary", pct: 11, windowSeconds: 604800 }), "Weekly limit");
	assert.equal(usageWindowLabel({ key: "secondary", pct: 11, windowSeconds: 18000 }), "5-hour limit");
	assert.equal(usageWindowLabel({ key: "primary", pct: 11, windowSeconds: 86400 }), "1-day limit");
	assert.equal(usageWindowLabel({ key: "rolling", pct: 11, windowSeconds: 1800 }), "30-minute limit");
	assert.equal(usageWindowLabel({ key: "monthly", pct: 11, windowSeconds: 2592000 }), "Monthly limit");
	for (const windowSeconds of [undefined, 0, -1, NaN, Infinity]) {
		assert.equal(usageWindowLabel({ key: "primary", pct: 11, windowSeconds }), "Primary limit");
	}
	assert.equal(usageWindowLabel({ key: "secondary", pct: 11 }), "Secondary limit");
});

test("planLabel accepts only a short slug", () => {
	assert.equal(planLabel(" Enterprise "), "enterprise");
	assert.equal(planLabel("not a plan!"), undefined);
	assert.equal(planLabel(42), undefined);
});

test("parseOpenCodeGoUsage marks exhausted windows and skips non-numeric ones", () => {
	assert.deepEqual(parseOpenCodeGoUsage(goBody), {
		provider: "opencode-go",
		windows: [
			{ key: "rolling", pct: 100, windowSeconds: 18000, resetsAtMs: Date.parse("2033-05-18T03:33:20Z"), exhausted: true },
			{ key: "weekly", pct: 3, windowSeconds: 604800, resetsAtMs: Date.parse("2033-05-24T03:33:20Z"), exhausted: false },
		],
	});
	assert.equal(parseOpenCodeGoUsage({ usage: {} }), undefined);
});

test("codex credentials come from the auth file when the registry has no api key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "status-plus-"));
	const authFile = join(dir, "auth.json");
	writeFileSync(authFile, JSON.stringify({ "openai-codex": { access: "file-token", accountId: "file-account" } }));
	const savedToken = process.env.PI_CODEX_ACCESS_TOKEN;
	const savedAccount = process.env.PI_CODEX_ACCOUNT_ID;
	delete process.env.PI_CODEX_ACCESS_TOKEN;
	delete process.env.PI_CODEX_ACCOUNT_ID;
	try {
		assert.equal(codexAccessToken(authFile), "file-token");
		assert.equal(codexAccountId(authFile), "file-account");
		assert.equal(codexAccessToken(join(dir, "missing.json")), undefined);
		const registry = { async getApiKeyForProvider() { return undefined; } };
		assert.deepEqual(await codexCredentials(registry, authFile), { token: "file-token", accountId: "file-account" });
		const keyed = { async getApiKeyForProvider() { return "registry-token"; } };
		assert.deepEqual(await codexCredentials(keyed, authFile), { token: "registry-token", accountId: "file-account" });
		process.env.PI_CODEX_ACCESS_TOKEN = "env-token";
		process.env.PI_CODEX_ACCOUNT_ID = "env-account";
		assert.deepEqual(await codexCredentials(undefined, authFile), { token: "env-token", accountId: "env-account" });
	} finally {
		if (savedToken === undefined) delete process.env.PI_CODEX_ACCESS_TOKEN; else process.env.PI_CODEX_ACCESS_TOKEN = savedToken;
		if (savedAccount === undefined) delete process.env.PI_CODEX_ACCOUNT_ID; else process.env.PI_CODEX_ACCOUNT_ID = savedAccount;
	}
});

test("pollCodexUsage sends both credentials and gives up on a non-2xx", async () => {
	const seen: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchOk = async (url: string, init?: RequestInit) => {
		seen.push({ url, headers: init?.headers as Record<string, string> });
		return jsonResponse(codexBody);
	};
	const registry = { async getApiKeyForProvider() { return "tok"; } };
	const dir = mkdtempSync(join(tmpdir(), "status-plus-"));
	const authFile = join(dir, "auth.json");
	writeFileSync(authFile, JSON.stringify({ "openai-codex": { accountId: "acct" } }));
	const savedAccount = process.env.PI_CODEX_ACCOUNT_ID;
	delete process.env.PI_CODEX_ACCOUNT_ID;
	try {
		const usage = await pollCodexUsage(registry, fetchOk, authFile);
		assert.equal(usage?.plan, "plus");
		assert.equal(seen[0].url, "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(seen[0].headers.authorization, "Bearer tok");
		assert.equal(seen[0].headers["chatgpt-account-id"], "acct");
		const fetchDenied = async () => jsonResponse({}, 403);
		assert.equal(await pollCodexUsage(registry, fetchDenied, authFile), undefined);
		const unauthenticated = { async getApiKeyForProvider() { return undefined; } };
		assert.equal(await pollCodexUsage(unauthenticated, fetchOk, join(dir, "missing.json")), undefined);
	} finally {
		if (savedAccount === undefined) delete process.env.PI_CODEX_ACCOUNT_ID; else process.env.PI_CODEX_ACCOUNT_ID = savedAccount;
	}
});

test("pollOpenCodeGoUsage needs a registry api key", async () => {
	const fetchOk = async () => jsonResponse(goBody);
	assert.equal(await pollOpenCodeGoUsage({ async getApiKeyForProvider() { return undefined; } }, fetchOk), undefined);
	const usage = await pollOpenCodeGoUsage({ async getApiKeyForProvider() { return "go-key"; } }, fetchOk);
	assert.equal(usage?.windows.length, 2);
	assert.equal(usage?.windows[0].exhausted, true);
});
