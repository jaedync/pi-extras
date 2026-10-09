import { test } from "node:test";
import assert from "node:assert/strict";
import {
	STATUS_TIME_ZONE,
	estimateUsageCost,
	formatDuration,
	formatMoney,
	formatMoneyLike,
	freeProviders,
	orderLimits,
	shownLimits,
	hhmm,
	parseProxyQuota,
	proxyQuotaUrl,
	toEpochMs,
	windowLabel,
} from "../lib/status-plus-logic.ts";

test("the clock renders in Central time regardless of the host zone", () => {
	assert.equal(STATUS_TIME_ZONE, "America/Chicago");
	assert.equal(hhmm(Date.parse("2026-07-01T17:05:00Z")), "12:05"); // CDT
	assert.equal(hhmm(Date.parse("2026-01-15T17:05:00Z")), "11:05"); // CST
	assert.equal(hhmm(Date.parse("2026-01-16T05:30:00Z")), "23:30"); // no 24:xx
	assert.equal(hhmm(Date.parse("2026-01-15T17:05:00Z"), "Pacific/Kiritimati"), "07:05");
});

test("formatDuration scales from seconds to days", () => {
	assert.equal(formatDuration(4200, true), "4.2s");
	assert.equal(formatDuration(45_000, true), "45s");
	assert.equal(formatDuration(45_000, false), "0m");
	assert.equal(formatDuration(125_000, true), "2m05s");
	assert.equal(formatDuration(125_000, false), "2m");
	assert.equal(formatDuration(3_600_000 * 3 + 60_000 * 7, false), "3h7m");
	assert.equal(formatDuration(86_400_000 * 2 + 3_600_000 * 5, false), "2d5h");
	assert.equal(formatDuration(-5, false), "0m");
});

test("windowLabel and toEpochMs", () => {
	assert.equal(windowLabel(45), "45m");
	assert.equal(windowLabel(300), "5h");
	assert.equal(windowLabel(10080), "7d");
	assert.equal(toEpochMs(1_750_000_000), 1_750_000_000_000);
	assert.equal(toEpochMs(1_750_000_000_000), 1_750_000_000_000);
});

test("formatMoney keeps small amounts legible", () => {
	assert.equal(formatMoney(123.4), "123");
	assert.equal(formatMoney(0.5), "0.50");
	assert.equal(formatMoney(0.00042), "0.00042");
	assert.equal(formatMoney(0.05), "0.050");
	assert.equal(formatMoney(0.0012), "0.0012");
	assert.equal(formatMoney(0.012), "0.012");
	assert.equal(formatMoney(0), "0.00");
	// Two significant figures, zeros kept: width only moves with magnitude.
	assert.equal(formatMoney(0.003), "0.0030");
	assert.equal(formatMoney(0.01), "0.010");
});

test("formatMoneyLike borrows the reference's digit count so a moving figure keeps its width", () => {
	assert.equal(formatMoneyLike(0.0028, 0.003), "0.0028");
	assert.equal(formatMoneyLike(0.0031, 0.003), "0.0031");
	assert.equal(formatMoneyLike(0.09, 0.11), "0.09");
	assert.equal(formatMoneyLike(2.7, 2.82), "2.70");
	assert.equal(formatMoneyLike(99.6, 123), "100");
});

test("Proxy quota maps fractional utilization and extra usage", () => {
	const entries = parseProxyQuota({
		buckets: [
			{ type: "five_hour", utilization: 0.47, resetsAt: 1_788_372_000_073, status: "allowed" },
			{ type: "seven_day_fable", utilization: 0.08, resetsAt: 1_788_422_400_073, status: "rejected" },
		],
		extraUsage: { isEnabled: true, monthlyLimit: 100, usedCredits: 12.5, currency: "USD" },
	});
	assert.deepEqual(entries, [
		{ label: "5h", key: "five_hour", usedPct: 47, windowSeconds: 18000, resetMs: 1_788_372_000_073, exhausted: false, allowed: true },
		{ label: "7d-fable", key: "seven_day_fable", modelFamily: "fable", usedPct: 8, windowSeconds: 604800, resetMs: 1_788_422_400_073, exhausted: true, proxyRejected: true },
		{ label: "", kind: "budget", remainingText: "$87.50/$100" },
	]);
});

test("proxy quota url never rewrites Anthropic's own origin", () => {
	assert.equal(proxyQuotaUrl("http://127.0.0.1:3456/v1"), "http://127.0.0.1:3456/v1/usage/quota");
	assert.equal(proxyQuotaUrl("https://api.anthropic.com"), undefined);
	assert.equal(proxyQuotaUrl("file:///tmp/not-http"), undefined);
	assert.equal(proxyQuotaUrl(undefined), undefined);
});

test("catalog cost recovery uses every token bucket", () => {
	const cost = estimateUsageCost(
		{ input: 2, output: 1_256, cacheRead: 53_335, cacheWrite: 2_665 },
		{ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	);
	assert.ok(Math.abs(cost - 0.1494675) < 1e-8);
});

test("recovered cost prices one-hour cache writes at twice the input rate, as Pi does", () => {
	const rates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
	const usage = { input: 2, output: 1_256, cacheRead: 53_335, cacheWrite: 2_665 };
	const hour = estimateUsageCost({ ...usage, cacheWrite1h: 2_665 }, rates);
	assert.ok(Math.abs(hour - (0.1494675 - 2_665 * 12.5 / 1e6 + 2_665 * 20 / 1e6)) < 1e-8);
	const split = estimateUsageCost({ ...usage, cacheWrite1h: 665 }, rates);
	assert.ok(Math.abs(split - (0.1494675 - 665 * 12.5 / 1e6 + 665 * 20 / 1e6)) < 1e-8);
});

test("limit windows have one fixed order: shortest window first, its model-family window next, then rates, budgets and credits", () => {
	// Meridian lists the window it saw last first, and header parses sort by pressure.
	const arrived = [
		{ label: "", kind: "budget" as const, remainingText: "$87/$100" },
		{ label: "7d-fable", key: "seven_day_fable", modelFamily: "fable", windowSeconds: 604_800, usedPct: 0 },
		{ label: "req", kind: "rate" as const, usedPct: 4 },
		{ label: "7d", key: "seven_day", windowSeconds: 604_800, usedPct: 17 },
		{ label: "5h", key: "five_hour", windowSeconds: 18_000, usedPct: 29 },
	];
	assert.deepEqual(orderLimits(arrived).map((entry) => entry.label || entry.kind), ["5h", "7d", "7d-fable", "req", "budget"]);
	assert.deepEqual(orderLimits([...arrived].reverse()).map((entry) => entry.label || entry.kind), ["5h", "7d", "7d-fable", "req", "budget"]);
	// Labels alone are enough: header parses and Go's fixed windows carry no duration.
	assert.deepEqual(orderLimits([{ label: "mo" }, { label: "7d" }, { label: "7d_fable" }, { label: "5h" }, { label: "45m" }]).map((entry) => entry.label),
		["45m", "5h", "7d", "7d_fable", "mo"]);
	// A copy: the snapshot in the shared store is left as it was.
	assert.equal(arrived[0].kind, "budget");
});

test("a provider is free when every model it lists costs nothing", () => {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const free = freeProviders([
		{ provider: "redarch-bonsai", cost: zero },
		{ provider: "fw01", cost: zero },
		{ provider: "fw01", cost: zero },
		{ provider: "anthropic", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
		// One priced model makes the whole provider metered.
		{ provider: "openrouter", cost: zero },
		{ provider: "openrouter", cost: { ...zero, output: 0.6 } },
		{ provider: "tiered", cost: { ...zero, tiers: [{ inputTokensAbove: 200_000, ...zero, input: 1 }] } },
		{ provider: "no-cost-field" },
	]);
	assert.deepEqual([...free].sort(), ["fw01", "no-cost-field", "redarch-bonsai"]);
});

test("a model-family window shows only once it has a real percent", () => {
	const shown = (entries: Parameters<typeof shownLimits>[0]) => shownLimits(entries).map((entry) => entry.label);
	const hours = { label: "5h", key: "five_hour", windowSeconds: 18_000, usedPct: 0 };
	const fable = (usedPct: number, extra = {}) => ({ label: "7d-fable", key: "seven_day_fable", modelFamily: "fable", windowSeconds: 604_800, usedPct, ...extra });
	// A plain window at 0% still says something; a family window at 0% (as shown, so 0.4 too) does not.
	assert.deepEqual(shown([fable(0), hours]), ["5h"]);
	assert.deepEqual(shown([fable(0.4), hours]), ["5h"]);
	assert.deepEqual(shown([fable(1), hours]), ["5h", "7d-fable"]);
	// A blocked window always shows, and so do family windows the header parser names by label alone.
	assert.deepEqual(shown([fable(0, { exhausted: true }), hours]), ["5h", "7d-fable"]);
	assert.deepEqual(shown([{ label: "7d_fable", usedPct: 0 }, { label: "7d", usedPct: 3 }]), ["7d"]);
});
