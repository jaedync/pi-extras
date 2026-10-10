import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	advanceMeterDay,
	fetchOpenRouterKey,
	fetchTokenfold,
	normalizeDollarsConfig,
	parseOpenRouterKey,
	parseTokenfoldHa,
	readKeyFile,
} from "../lib/usage-dollars/sources.ts";

const TZ = "America/Chicago";
const NOW = Date.UTC(2026, 9, 10, 17);
const HA = {
	cost_today_usd: 455.9,
	cost_total_usd: 63607.77,
	five_hour: { pct_used: 15.0, spend_usd: 115.88, implied_limit_usd: 772.53, resets_at: "2026-10-10T17:30:00+00:00", resets_in_s: 2571 },
	weekly: { pct_used: 57, spend_usd: 2665.05, implied_limit_usd: null, resets_at: "2026-10-15T08:00:00+00:00", resets_in_s: 400371 },
	model_buckets: null,
	updated_at_epoch: 1791650760,
};

test("settings accept https Tokenfold, a home-relative key file and an OpenCode Go plan", () => {
	const config = normalizeDollarsConfig({
		tokenfold: { url: "https://usage.example.com/", keyFile: "~/.config/tokenfold-read-key" },
		opencodeGo: { plan: "go-plus", monthlyCaps: { "glm-5.3": 100, bad: -1, worse: "x" } },
	});
	assert.deepEqual(config, {
		tokenfold: { url: "https://usage.example.com", keyFile: join(homedir(), ".config/tokenfold-read-key") },
		openCodeGo: { plan: "go-plus", caps: { "glm-5.3": 100 } },
	});
});

test("settings refuse plain http except on this machine, and default the plan to Go", () => {
	assert.equal(normalizeDollarsConfig({ tokenfold: { url: "http://usage.example.com", keyFile: "/k" } }).tokenfold, undefined);
	assert.equal(normalizeDollarsConfig({ tokenfold: { url: "http://127.0.0.1:5055", keyFile: "/k" } }).tokenfold?.url, "http://127.0.0.1:5055");
	assert.equal(normalizeDollarsConfig({ tokenfold: { url: "https://x.example" } }).tokenfold, undefined);
	assert.deepEqual(normalizeDollarsConfig(undefined), { openCodeGo: { plan: "go", caps: {} } });
});

test("a key file must hold one plausible token", () => {
	const dir = mkdtempSync(join(tmpdir(), "dollars-key-"));
	writeFileSync(join(dir, "good"), "abcdefghijklmnopqrstuvwxyz012345\n");
	writeFileSync(join(dir, "short"), "abc\n");
	writeFileSync(join(dir, "spaces"), "abc def ghi jkl mno pqr stu vwx\n");
	assert.equal(readKeyFile(join(dir, "good")), "abcdefghijklmnopqrstuvwxyz012345");
	assert.equal(readKeyFile(join(dir, "short")), undefined);
	assert.equal(readKeyFile(join(dir, "spaces")), undefined);
	assert.equal(readKeyFile(join(dir, "missing")), undefined);
});

test("Tokenfold's /api/ha maps to windows; a null implied limit stays absent", () => {
	const snapshot = parseTokenfoldHa(HA, NOW);
	assert.deepEqual(snapshot, {
		fetchedAtMs: NOW,
		updatedAtMs: 1791650760 * 1000,
		costTodayUsd: 455.9,
		fiveHour: { pctUsed: 15, spendUsd: 115.88, impliedLimitUsd: 772.53, resetsAtMs: Date.UTC(2026, 9, 10, 17, 30) },
		weekly: { pctUsed: 57, spendUsd: 2665.05, resetsAtMs: Date.UTC(2026, 9, 15, 8) },
	});
	assert.equal(parseTokenfoldHa("nope", NOW), undefined);
	assert.deepEqual(parseTokenfoldHa({ five_hour: { pct_used: "x" } }, NOW), { fetchedAtMs: NOW });
});

test("the Tokenfold fetch sends the read key and reports a refusal without detail", async () => {
	const seen: Array<{ url: string; key: string | null }> = [];
	const ok = await fetchTokenfold({ url: "https://t.example", keyFile: "/k" }, "secret-key-value-123456", NOW, async (url, init) => {
		seen.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
		return new Response(JSON.stringify(HA));
	});
	assert.equal(seen[0]?.url, "https://t.example/api/ha");
	assert.equal(seen[0]?.key, "secret-key-value-123456");
	assert.equal(ok.snapshot?.costTodayUsd, 455.9);
	const refused = await fetchTokenfold({ url: "https://t.example", keyFile: "/k" }, "secret-key-value-123456", NOW, async () => new Response("no", { status: 401 }));
	assert.equal(refused.snapshot, undefined);
	assert.equal(refused.error, "Tokenfold refused the request (HTTP 401).");
	assert.doesNotMatch(refused.error ?? "", /secret/);
});

test("OpenRouter's key endpoint gives today's spend, the key limit and the binding budget", async () => {
	const body = { data: {
		usage_daily: 3.2, limit_remaining: 20,
		effective_budget: { limit_usd: 50, spend_usd: 40, remaining_usd: 10, reset_interval: "weekly", resets_at: "2026-10-12T00:00:00.000Z", scope: "member" },
	} };
	assert.deepEqual(parseOpenRouterKey(body), {
		usageDailyUsd: 3.2,
		limitRemainingUsd: 20,
		effectiveBudget: { limitUsd: 50, spendUsd: 40, remainingUsd: 10, resetInterval: "weekly", resetsAt: "2026-10-12T00:00:00.000Z" },
	});
	assert.deepEqual(parseOpenRouterKey({ data: { usage_daily: 1, limit_remaining: null, effective_budget: null } }), { usageDailyUsd: 1 });
	const fetched = await fetchOpenRouterKey("or-key", async () => new Response(JSON.stringify(body)));
	assert.equal(fetched?.usageDailyUsd, 3.2);
	assert.equal(await fetchOpenRouterKey("or-key", async () => new Response("", { status: 500 })), undefined);
});

test("the meter anchor starts each local day at the first reading", () => {
	const first = advanceMeterDay(undefined, 1100, NOW, TZ);
	assert.deepEqual(first, { date: "2026-10-10", usedUsd: 1100, atMs: NOW });
	// Same day: the anchor stays.
	assert.equal(advanceMeterDay(first, 1130, NOW + 3_600_000, TZ), first);
	// Next local day: a new anchor.
	assert.deepEqual(advanceMeterDay(first, 1150, NOW + 24 * 3_600_000, TZ), { date: "2026-10-11", usedUsd: 1150, atMs: NOW + 24 * 3_600_000 });
	// The meter rolled over to a new month during the day: count from zero.
	assert.deepEqual(advanceMeterDay(first, 20, NOW + 3_600_000, TZ), { date: "2026-10-10", usedUsd: 0, atMs: NOW });
});
