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
const resetPassed = (entry: LimitEntry, now: number): boolean => entry.resetMs !== undefined && entry.resetMs <= now;
const isWindow = (entry: LimitEntry): boolean => (entry.kind ?? "window") === "window" && entry.usedPct !== undefined;

/** A kept reading carries its own sample time, so its age does not restart with each poll that keeps it. */
function stamped(entry: LimitEntry, stored: Stored): LimitEntry & { sampledMs: number } {
	return { ...entry, sampledMs: entry.sampledMs ?? stored.atMs };
}

/**
 * A stored usage-endpoint reading that a Claude Code reading must not replace.
 * One with no sample time came from an older installed copy, which wrote
 * Claude Code's readings unmarked, so it is not trusted.
 */
function trusted(entry: LimitEntry, now: number): entry is LimitEntry & { sampledMs: number } {
	return !entry.approximate && entry.sampledMs !== undefined && !resetPassed(entry, now) && now - entry.sampledMs < OAUTH_READING_KEEP_MS;
}

/**
 * A stored entry the poll left out: kept as it is while recent; approximate
 * when it is Claude Code's, has no sample time, or is a usage-endpoint reading
 * older than OAUTH_READING_KEEP_MS (shown until its reset, never counted as
 * current); or dropped.
 */
function carry(entry: LimitEntry, stored: Stored, now: number): LimitEntry | undefined {
	if (resetPassed(entry, now)) return undefined;
	const kept = stamped(entry, stored);
	const age = now - kept.sampledMs;
	if (entry.stale) return entry.resetMs !== undefined ? kept : undefined;
	if (entry.approximate || entry.sampledMs === undefined) {
		const holds = (entry.exhausted === true && entry.resetMs !== undefined) || age <= SDK_READING_MAX_AGE_MS;
		return holds ? { ...kept, approximate: true } : undefined;
	}
	if (age < OAUTH_READING_KEEP_MS) return kept;
	return entry.resetMs !== undefined ? { ...kept, approximate: true, stale: true } : undefined;
}

/**
 * One fresh entry, or the stored reading it must not replace. The status is
 * the fresh one's: a fresh rejection blocks the window, a fresh "allowed" clears
 * the kept block, unless the kept reading is full.
 */
function mergeOne(entry: LimitEntry, kept: LimitEntry | undefined, now: number): LimitEntry {
	if (!entry.approximate || !kept || !trusted(kept, now)) return entry;
	const { exhausted, proxyRejected: _rejected, allowed: _allowed, ...reading } = kept;
	const full = exhausted === true && (kept.usedPct ?? 0) >= 100;
	return {
		...reading,
		exhausted: entry.proxyRejected === true || full,
		...(entry.proxyRejected ? { proxyRejected: true } : {}),
		...(entry.allowed ? { allowed: true } : {}),
	};
}

export function mergePolled(stored: Stored | undefined, fresh: LimitEntry[], now: number): LimitEntry[] {
	if (!fresh.some((entry) => entry.approximate)) return fresh;
	const previous = new Map((stored?.entries ?? []).map((entry) => [identity(entry), entry]));
	const merged = fresh.map((entry) => mergeOne(entry, previous.get(identity(entry)), now));
	// A usage-endpoint answer is complete: a window it leaves out is gone.
	if (!stored || fresh.some((entry) => isWindow(entry) && !entry.approximate)) return merged;
	const seen = new Set(fresh.map(identity));
	const carried = stored.entries.flatMap((entry) => {
		const kept = seen.has(identity(entry)) ? undefined : carry(entry, stored, now);
		return kept ? [kept] : [];
	});
	return [...merged, ...carried];
}

/**
 * Windows another process shared without a sample time come from an older
 * installed copy, which shared proxy readings without their approximate mark.
 * They show as approximate until a poll by this version replaces them.
 */
export function markUnsampled(entries: readonly LimitEntry[]): LimitEntry[] {
	return entries.map((entry) => isWindow(entry) && entry.sampledMs === undefined && !entry.approximate ? { ...entry, approximate: true } : entry);
}
