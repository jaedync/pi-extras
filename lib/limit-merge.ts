/**
 * How a poll that saw only part of a provider joins the stored snapshot. A
 * proxy whose usage-endpoint source is down (Meridian in an OAuth cooldown)
 * still answers, with Claude Code's last rate-limit events alone: they can be
 * hours old, overstate a window (96% against a real 38%), and leave windows
 * out. Such a reading is approximate and must not replace a recent reading
 * from the usage endpoint, and a window it leaves out keeps its last reading.
 * Polls with no approximate reading (every other provider, the direct OAuth
 * route, a healthy proxy) replace the snapshot as before.
 */
import type { LimitSnapshot } from "./limit-store.ts";
import { SDK_READING_MAX_AGE_MS, type LimitEntry } from "./status-plus-logic.ts";

/** A usage-endpoint reading younger than this outranks Claude Code's readings. */
export const OAUTH_READING_KEEP_MS = 30 * 60_000;

type Stored = Pick<LimitSnapshot, "entries" | "atMs">;

const identity = (entry: LimitEntry): string => `${entry.kind ?? ""}|${entry.key ?? entry.label}`;
const sampled = (entry: LimitEntry, stored: Stored): number => entry.sampledMs ?? stored.atMs;
const resetPassed = (entry: LimitEntry, now: number): boolean => entry.resetMs !== undefined && entry.resetMs <= now;
const isWindow = (entry: LimitEntry): boolean => (entry.kind ?? "window") === "window" && entry.usedPct !== undefined;

/** A kept reading carries its own sample time, so its age does not restart with each poll that keeps it. */
function stamped(entry: LimitEntry, stored: Stored): LimitEntry {
	return entry.sampledMs !== undefined ? entry : { ...entry, sampledMs: stored.atMs };
}

/** A stored usage-endpoint reading that a Claude Code reading must not replace. */
function trusted(entry: LimitEntry, stored: Stored, now: number): boolean {
	return !entry.approximate && !resetPassed(entry, now) && now - sampled(entry, stored) < OAUTH_READING_KEEP_MS;
}

/** A stored entry the poll left out still holds until its reset; one with no reset, for a while. */
function stillHolds(entry: LimitEntry, stored: Stored, now: number): boolean {
	if (resetPassed(entry, now)) return false;
	const age = now - sampled(entry, stored);
	if (entry.approximate) return (entry.exhausted === true && entry.resetMs !== undefined) || age <= SDK_READING_MAX_AGE_MS;
	return entry.resetMs !== undefined || age < OAUTH_READING_KEEP_MS;
}

/** One fresh entry, or the stored reading it must not replace. A fresh rejection still blocks the window. */
function mergeOne(entry: LimitEntry, kept: LimitEntry | undefined, stored: Stored | undefined, now: number): LimitEntry {
	if (!entry.approximate || !kept || !stored || !trusted(kept, stored, now)) return entry;
	return { ...stamped(kept, stored), ...(entry.proxyRejected ? { exhausted: true, proxyRejected: true } : {}) };
}

export function mergePolled(stored: Stored | undefined, fresh: LimitEntry[], now: number): LimitEntry[] {
	if (!fresh.some((entry) => entry.approximate)) return fresh;
	const previous = new Map((stored?.entries ?? []).map((entry) => [identity(entry), entry]));
	const merged = fresh.map((entry) => mergeOne(entry, previous.get(identity(entry)), stored, now));
	// A usage-endpoint answer is complete: a window it leaves out is gone.
	if (!stored || fresh.some((entry) => isWindow(entry) && !entry.approximate)) return merged;
	const seen = new Set(fresh.map(identity));
	const carried = stored.entries
		.filter((entry) => !seen.has(identity(entry)) && stillHolds(entry, stored, now))
		.map((entry) => stamped(entry, stored));
	return [...merged, ...carried];
}
