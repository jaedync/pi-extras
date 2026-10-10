import { test } from "node:test";
import assert from "node:assert/strict";
import type { LimitEntry } from "../lib/status-plus-logic.ts";
import {
	MIN_PCT_FOR_IMPLIED,
	dollarsSummary,
	entryDollars,
	impliedLimitUsd,
	type DollarInputs,
	type SpendQuery,
} from "../lib/usage-dollars/core.ts";

/** The tests read fields of each union member directly. */
const figures = (...args: Parameters<typeof entryDollars>) => entryDollars(...args) as Record<string, any> | undefined;

const TZ = "America/Chicago";
// Saturday 2026-10-10 12:00 CDT.
const SAT = Date.UTC(2026, 9, 10, 17, 0);
// Monday 2026-10-12 12:00 CDT.
const MON = Date.UTC(2026, 9, 12, 17, 0);
const HOUR = 3_600_000;

const five = (pct: number, resetMs = SAT + HOUR): LimitEntry =>
	({ label: "5h", key: "five_hour", usedPct: pct, windowSeconds: 5 * 3600, resetMs });
const seven = (pct: number, resetMs = SAT + 100 * HOUR): LimitEntry =>
	({ label: "7d", key: "seven_day", usedPct: pct, windowSeconds: 7 * 86400, resetMs });

function inputs(patch: Partial<DollarInputs> = {}): DollarInputs {
	return { now: SAT, timeZone: TZ, ...patch };
}

test("an implied limit needs enough of the window used and some spend", () => {
	assert.equal(impliedLimitUsd(10, MIN_PCT_FOR_IMPLIED - 0.1), undefined);
	assert.equal(impliedLimitUsd(0, 50), undefined);
	assert.equal(impliedLimitUsd(115.88, 15), 772.53);
});

test("tokenfold spend sets the implied limit and the current percent sets what remains", () => {
	const dollars = figures("anthropic", five(20), inputs({
		tokenfold: {
			fetchedAtMs: SAT - 30_000,
			updatedAtMs: SAT - 90_000,
			fiveHour: { pctUsed: 15, spendUsd: 115.88, impliedLimitUsd: 772.53, resetsAtMs: SAT + HOUR - 40_000 },
		},
	}));
	assert.deepEqual(dollars, {
		basis: "implied",
		source: "tokenfold",
		scope: "all personal machines",
		spentUsd: 115.88,
		limitUsd: 772.53,
		remainingUsd: 618.02,
		dataAgeSeconds: 90,
	});
});

test("a tokenfold window with another reset is not this account's window: local spend is used", () => {
	const queries: SpendQuery[] = [];
	const dollars = figures("anthropic", five(20), inputs({
		tokenfold: { fetchedAtMs: SAT, fiveHour: { pctUsed: 15, spendUsd: 115.88, resetsAtMs: SAT + 3 * HOUR } },
		spend: (query) => { queries.push(query); return 50; },
	}));
	assert.equal(queries.length, 1);
	assert.deepEqual(queries[0], { provider: "anthropic", sinceMs: SAT + HOUR - 5 * HOUR, untilMs: SAT });
	assert.equal(dollars?.source, "local");
	assert.equal(dollars?.scope, "this machine");
	assert.equal(dollars?.limitUsd, 250);
	assert.equal(dollars?.remainingUsd, 200);
	assert.match(dollars?.note ?? "", /tokenfold/i);
});

test("local estimates say that other machines make the limit read low", () => {
	const dollars = figures("anthropic", seven(40), inputs({ spend: () => 400 }));
	assert.equal(dollars?.limitUsd, 1000);
	assert.equal(dollars?.remainingUsd, 600);
	assert.match(dollars?.note ?? "", /this machine/);
});

test("a model-family window counts only that family's spend", () => {
	const queries: SpendQuery[] = [];
	const fable: LimitEntry = { ...seven(10), label: "7d-fable", key: "seven_day_fable", modelFamily: "fable" };
	figures("anthropic", fable, inputs({
		tokenfold: { fetchedAtMs: SAT, weekly: { pctUsed: 10, spendUsd: 999, resetsAtMs: fable.resetMs! } },
		spend: (query) => { queries.push(query); return 30; },
	}));
	// Tokenfold's weekly spend covers every model, so a family window never uses it.
	assert.equal(queries[0]?.family, "fable");
});

test("under five percent used there is spend but no limit yet", () => {
	const dollars = figures("anthropic", five(3), inputs({ spend: () => 12.5 }));
	assert.equal(dollars?.spentUsd, 12.5);
	assert.equal(dollars?.limitUsd, undefined);
	assert.equal(dollars?.remainingUsd, undefined);
	assert.match(dollars?.note ?? "", /5%/);
});

test("OpenCode Go windows give exact dollars per model from the plan caps", () => {
	const rolling: LimitEntry = { label: "5h", key: "rolling", usedPct: 40, windowSeconds: 5 * 3600, resetMs: SAT + HOUR };
	const dollars = figures("opencode-go", rolling, inputs({
		openCodeGo: { plan: "go", caps: {}, models: ["deepseek-v4.1-flash", "glm-5.3", "not-a-go-model"] },
	}));
	assert.deepEqual(dollars, {
		basis: "plan cap",
		source: "plan table",
		perModel: {
			"deepseek-v4.1-flash": { limitUsd: 12, remainingUsd: 7.2 },
			"glm-5.3": { limitUsd: 3, remainingUsd: 1.8 },
		},
		note: "No published cap for: not-a-go-model.",
	});
});

test("OpenCode Go settings choose Go Plus and override one cap", () => {
	const monthly: LimitEntry = { label: "mo", key: "monthly", usedPct: 50, windowSeconds: 30 * 86400, resetMs: SAT + 99 * HOUR };
	const dollars = figures("opencode-go", monthly, inputs({
		openCodeGo: { plan: "go-plus", caps: { "glm-5.3": 100 }, models: ["glm-5.3", "kimi-k3"] },
	}));
	assert.deepEqual(dollars?.perModel, {
		"glm-5.3": { limitUsd: 100, remainingUsd: 50 },
		"kimi-k3": { limitUsd: 60, remainingUsd: 30 },
	});
});

const meter: LimitEntry = { label: "", kind: "budget", usedUsd: 1170.83, limitUsd: 2000, resetMs: Date.UTC(2026, 10, 1), resetApprox: true };

test("a monthly meter on a weekend spreads what remains over the business days left", () => {
	const dollars = figures("anthropic", meter, inputs({ meterToday: { anthropic: { spentUsd: 4, sinceMs: SAT - 3 * HOUR } } }));
	assert.equal(dollars?.basis, "meter");
	assert.equal(dollars?.remainingUsd, 829.17);
	assert.equal(dollars?.businessDaysLeft, 15);
	assert.equal(dollars?.calendarDaysLeft, 22);
	assert.equal(dollars?.perBusinessDayUsd, 55.28);
	assert.equal(dollars?.spentTodayUsd, 4);
	// A weekend day has no share of its own.
	assert.equal(dollars?.leftTodayUsd, undefined);
	assert.equal(dollars?.resetApprox, true);
});

test("on a business day, today's share counts from the start of the day", () => {
	const monday: LimitEntry = { ...meter, usedUsd: 1210.83 };
	const dollars = figures("anthropic", monday, inputs({ now: MON, meterToday: { anthropic: { spentUsd: 40, sinceMs: MON - 12 * HOUR } } }));
	// (789.17 + 40) / 15 = 55.28; 55.28 - 40 = 15.28.
	assert.equal(dollars?.perBusinessDayUsd, 55.28);
	assert.equal(dollars?.leftTodayUsd, 15.28);
	assert.equal(dollars?.spentTodaySinceLocal !== undefined, true);
});

test("an overspent day reports a negative amount left", () => {
	const dollars = figures("anthropic", meter, inputs({ now: MON, meterToday: { anthropic: { spentUsd: 100, sinceMs: MON - 12 * HOUR } } }));
	assert.ok((dollars?.leftTodayUsd ?? 0) < 0);
});

test("a meter with no reset uses the next UTC month", () => {
	const dollars = figures("anthropic", { label: "", kind: "budget", usedUsd: 0, limitUsd: 100 }, inputs());
	assert.equal(dollars?.resetsAt, new Date(Date.UTC(2026, 10, 1)).toISOString());
	assert.equal(dollars?.resetApprox, true);
});

test("OpenRouter balances carry the key's UTC-day spend and budget", () => {
	const credits: LimitEntry = { label: "", kind: "credits", balanceUsd: 42.5 };
	const dollars = figures("openrouter", credits, inputs({
		openRouterKey: { usageDailyUsd: 3.2, limitRemainingUsd: 20, effectiveBudget: { limitUsd: 50, spendUsd: 40, remainingUsd: 10, resetInterval: "weekly" } },
	}));
	assert.deepEqual(dollars, {
		basis: "balance",
		source: "provider",
		balanceUsd: 42.5,
		spentTodayUtcUsd: 3.2,
		keyLimitRemainingUsd: 20,
		budget: { limitUsd: 50, spendUsd: 40, remainingUsd: 10, resetInterval: "weekly" },
	});
});

test("rate limits and entries with no dollar data get nothing", () => {
	assert.equal(figures("anthropic", { label: "rpm", kind: "rate", usedPct: 10 }, inputs()), undefined);
	assert.equal(figures("openrouter", { label: "", kind: "credits", remainingText: "$5 credits" }, inputs()), undefined);
});

test("the summary names the tightest window and today's spend per provider", () => {
	const summary = dollarsSummary([
		{ provider: "anthropic", window: "5h", applies: true, dollars: { basis: "implied", source: "local", remainingUsd: 120 } },
		{ provider: "anthropic", window: "7d", applies: true, dollars: { basis: "implied", source: "local", remainingUsd: 90 } },
		{ provider: "anthropic", window: "7d-fable", applies: false, dollars: { basis: "implied", source: "local", remainingUsd: 5 } },
		{ provider: "opencode-go", window: "5h", applies: false, dollars: { basis: "plan cap", source: "plan table", perModel: { "glm-5.3": { limitUsd: 3, remainingUsd: 2 } } } },
		{ provider: "opencode-go", window: "7d", applies: false, dollars: { basis: "plan cap", source: "plan table", perModel: { "glm-5.3": { limitUsd: 7.5, remainingUsd: 1 } } } },
	], inputs({ today: { byProvider: { anthropic: 301.05, "opencode-go": 0.4, fw01: 0 } }, tokenfold: { fetchedAtMs: SAT, costTodayUsd: 455.9 } }));
	assert.equal(summary.date, "2026-10-10");
	assert.equal(summary.timeZone, TZ);
	assert.equal(summary.spentTodayThisMachineUsd, 301.45);
	assert.equal(summary.spentTodayAllPersonalMachinesUsd, 455.9);
	assert.deepEqual(summary.providers.anthropic, { spentTodayUsd: 301.05, remainingUsd: 90, bindingWindow: "7d" });
	assert.deepEqual(summary.providers["opencode-go"], { spentTodayUsd: 0.4, remainingUsdByModel: { "glm-5.3": 1 } });
	assert.equal(summary.providers.fw01, undefined);
	assert.ok(summary.notes.some((note) => /list price/i.test(note)));
});
