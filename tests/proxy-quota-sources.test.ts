import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LimitSnapshot } from "../lib/limit-store.ts";
import { mergePolled } from "../lib/limit-merge.ts";
import { parseProxyQuota, type LimitEntry } from "../lib/status-plus-logic.ts";
import { DEFAULT_GUARD_CONFIG, hotProviders, pendingWarnings, usageReport } from "../lib/usage-guard-core.ts";
import { createDollarsCollector } from "../lib/usage-dollars/collect.ts";

// 2026-10-12T23:53:12.868Z: Meridian answered without its OAuth source.
const BAD_AT = 1_791_849_192_868;
const MIN = 60_000;
const FIVE_RESET = 1_791_861_599_744;
const WEEK_RESET = 1_792_051_199_744;
const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const ON = { ...DEFAULT_GUARD_CONFIG, enabled: true, bands: [95, 98] };

/** The response Meridian sent while its OAuth source was missing: one Claude Code reading, no 5h. */
function badResponse(asOf = BAD_AT, observedAt = asOf - 2 * MIN) {
	return {
		profile: null,
		buckets: [{
			type: "seven_day", status: "allowed_warning", utilization: 0.96, resetsAt: 1_792_051_200_000,
			isUsingOverage: false, overageStatus: "rejected", overageResetsAt: null, overageDisabledReason: "org_level_disabled",
			surpassedThreshold: 0.75, observedAt,
		}],
		extraUsage: null,
		sources: { oauth: null, sdk: { entryCount: 1 } },
		asOf,
	};
}

function goodResponse(fetchedAt: number, weekly = 0.37) {
	const bucket = (type: string, utilization: number, resetsAt: number, surpassedThreshold: number | null = null) => ({
		type, status: "allowed", utilization, resetsAt, isUsingOverage: false, overageStatus: "rejected", overageResetsAt: null,
		overageDisabledReason: "org_level_disabled", surpassedThreshold, observedAt: fetchedAt,
	});
	return {
		profile: null,
		buckets: [bucket("five_hour", 0.46, FIVE_RESET), bucket("seven_day", weekly, WEEK_RESET, 0.75), bucket("seven_day_fable", 0, 1_792_051_200_000)],
		extraUsage: { isEnabled: false, monthlyLimit: 0, usedCredits: 0, utilization: null, currency: "USD" },
		sources: { oauth: { fetchedAt }, sdk: { entryCount: 2 } },
		asOf: fetchedAt,
	};
}

const byKey = (entries: LimitEntry[], key: string) => entries.find((entry) => entry.key === key);
const snap = (entries: LimitEntry[], atMs: number): LimitSnapshot => ({ entries, atMs, source: "poll" });

/** One poll as Status Plus applies it: parse, then merge over the stored snapshot. */
function poll(stored: LimitSnapshot | undefined, body: unknown, atMs: number): LimitSnapshot {
	return snap(mergePolled(stored, parseProxyQuota(body, atMs), atMs), atMs);
}

test("a proxy reading without the OAuth source is marked approximate", () => {
	const [entry, ...rest] = parseProxyQuota(badResponse(), BAD_AT);
	assert.equal(rest.length, 0);
	assert.equal(entry.key, "seven_day");
	assert.equal(entry.usedPct, 96);
	assert.equal(entry.approximate, true);
	assert.equal(entry.sampledMs, BAD_AT - 2 * MIN);
});

test("an OAuth-backed proxy reading is not approximate, and a legacy body without sources keeps its old meaning", () => {
	const good = parseProxyQuota(goodResponse(BAD_AT - MIN), BAD_AT);
	assert.deepEqual(good.map((entry) => [entry.key, entry.approximate]), [["five_hour", undefined], ["seven_day", undefined], ["seven_day_fable", undefined]]);
	assert.equal(byKey(good, "seven_day")?.sampledMs, BAD_AT - MIN);
	const legacy = parseProxyQuota({ buckets: [{ type: "five_hour", utilization: 0.5, resetsAt: FIVE_RESET }] }, BAD_AT);
	assert.equal(legacy[0].approximate, undefined);
});

test("a bucket only Claude Code reported stays approximate inside an OAuth response", () => {
	const body = goodResponse(BAD_AT - MIN);
	body.buckets.push({ ...body.buckets[0], type: "seven_day_opus", utilization: 0.5, observedAt: BAD_AT - 3 * MIN });
	const opus = byKey(parseProxyQuota(body, BAD_AT), "seven_day_opus");
	assert.equal(opus?.approximate, true);
});

test("an approximate reading does not replace an OAuth reading younger than 30 minutes, and the missing 5h window stays", () => {
	const good = poll(undefined, goodResponse(BAD_AT - MIN), BAD_AT - MIN);
	const after = poll(good, badResponse(), BAD_AT);
	assert.equal(byKey(after.entries, "five_hour")?.usedPct, 46);
	assert.equal(byKey(after.entries, "seven_day")?.usedPct, 37);
	assert.equal(byKey(after.entries, "seven_day")?.approximate, undefined);
	assert.equal(byKey(after.entries, "seven_day_fable")?.usedPct, 0);
	// The kept readings carry their own sample time, so the 30 minutes run from the OAuth fetch, not from this poll.
	assert.equal(byKey(after.entries, "seven_day")?.sampledMs, BAD_AT - MIN);
	const later = poll(after, badResponse(BAD_AT + 31 * MIN), BAD_AT + 31 * MIN);
	assert.equal(byKey(later.entries, "seven_day")?.usedPct, 96);
	assert.equal(byKey(later.entries, "seven_day")?.approximate, true);
	// A window absent from the response keeps its reading until its reset passes.
	assert.equal(byKey(later.entries, "five_hour")?.usedPct, 46);
	const pastReset = poll(later, badResponse(FIVE_RESET + MIN), FIVE_RESET + MIN);
	assert.equal(byKey(pastReset.entries, "five_hour"), undefined);
});

test("a stored snapshot from an older version (no sample times) still counts as an OAuth reading", () => {
	const legacy = snap(parseProxyQuota(goodResponse(BAD_AT - MIN), BAD_AT).map(({ sampledMs: _drop, ...entry }) => entry), BAD_AT - MIN);
	const after = poll(legacy, badResponse(), BAD_AT);
	assert.equal(byKey(after.entries, "seven_day")?.usedPct, 37);
	assert.equal(byKey(after.entries, "seven_day")?.sampledMs, BAD_AT - MIN);
});

test("good, bad, good: no lost 5h window, no warning, and no granted reset", () => {
	const dir = mkdtempSync(join(tmpdir(), "proxy-quota-"));
	try {
		const collector = createDollarsCollector({ agentDir: dir, timeZone: "UTC" });
		let stored: LimitSnapshot | undefined;
		const fired = new Set<string>();
		const steps: Array<[unknown, number]> = [
			[goodResponse(BAD_AT - 30_000), BAD_AT - 30_000],
			[badResponse(), BAD_AT],
			[goodResponse(BAD_AT + 20_724, 0.38), BAD_AT + 20_724],
			[goodResponse(BAD_AT + 80_000, 0.38), BAD_AT + 80_000],
		];
		for (const [body, atMs] of steps) {
			stored = poll(stored, body, atMs);
			assert.ok(byKey(stored.entries, "five_hour"), "the 5h window stays");
			const warnings = pendingWarnings([["anthropic", stored]], OPUS, ON, undefined, fired, atMs);
			assert.deepEqual(warnings, []);
			collector.observe([["anthropic", stored]], atMs);
		}
		const readings = JSON.parse(readFileSync(join(dir, "usage-dollars", "window-readings.json"), "utf8"));
		assert.equal(readings["anthropic|seven_day"].grant, undefined);
		assert.equal(readings["anthropic|seven_day"].pending, undefined);
		assert.equal(readings["anthropic|seven_day"].drops, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fresh start with OAuth down shows the reading as approximate, fires no warning and records no reading", () => {
	const dir = mkdtempSync(join(tmpdir(), "proxy-quota-"));
	try {
		const stored = poll(undefined, badResponse(), BAD_AT);
		const entry = byKey(stored.entries, "seven_day");
		assert.equal(entry?.usedPct, 96);
		assert.equal(entry?.approximate, true);
		assert.deepEqual(pendingWarnings([["anthropic", stored]], OPUS, ON, { window: "7d", pct: 60 }, new Set(), BAD_AT), []);
		assert.equal(hotProviders([["anthropic", stored]], OPUS, ON, undefined, BAD_AT).size, 0);
		const report = usageReport([["anthropic", stored]], OPUS, ON, undefined, BAD_AT);
		const limit = report.limits.find((item) => item.key === "seven_day");
		assert.equal(limit?.approximate, "from Claude Code's last response");
		assert.ok(report.notes.some((note) => /approximate/.test(note)));
		const collector = createDollarsCollector({ agentDir: dir, timeZone: "UTC" });
		const { resetEvidence } = collector.observe([["anthropic", stored]], BAD_AT);
		assert.deepEqual(resetEvidence, {});
		assert.throws(() => readFileSync(join(dir, "usage-dollars", "window-readings.json")), /ENOENT/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude Code reading older than 15 minutes is ignored, unless it blocks requests until a future reset", () => {
	const old = badResponse(BAD_AT, BAD_AT - 16 * MIN);
	assert.deepEqual(parseProxyQuota(old, BAD_AT), []);
	const rejected = badResponse(BAD_AT, BAD_AT - 16 * MIN);
	rejected.buckets[0] = { ...rejected.buckets[0], status: "rejected", utilization: 1 };
	const [blocked] = parseProxyQuota(rejected, BAD_AT);
	assert.equal(blocked.exhausted, true);
	assert.equal(blocked.approximate, true);
	const stale = badResponse(BAD_AT, BAD_AT - 6 * 60 * MIN);
	stale.buckets[0] = { ...stale.buckets[0], status: "rejected", utilization: 1, resetsAt: BAD_AT - 60 * MIN };
	assert.deepEqual(parseProxyQuota(stale, BAD_AT), []);
});

test("a Claude Code rejection blocks the window even while a recent OAuth reading is kept", () => {
	const good = poll(undefined, goodResponse(BAD_AT - MIN), BAD_AT - MIN);
	const rejected = badResponse();
	rejected.buckets[0] = { ...rejected.buckets[0], status: "rejected", utilization: 1 };
	const after = poll(good, rejected, BAD_AT);
	const week = byKey(after.entries, "seven_day");
	assert.equal(week?.usedPct, 37);
	assert.equal(week?.exhausted, true);
	assert.equal(week?.proxyRejected, true);
});

test("polls with OAuth readings, and other providers, are not merged", () => {
	const good = poll(undefined, goodResponse(BAD_AT - MIN), BAD_AT - MIN);
	const fresh = parseProxyQuota(goodResponse(BAD_AT, 0.4), BAD_AT).filter((entry) => entry.key !== "five_hour");
	assert.deepEqual(mergePolled(good, fresh, BAD_AT), fresh);
	const codex: LimitEntry[] = [{ label: "5h", key: "five_hour", usedPct: 3 }];
	assert.deepEqual(mergePolled(good, codex, BAD_AT), codex);
});
