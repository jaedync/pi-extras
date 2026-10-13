/**
 * Granted mid-window resets, seen from this machine's own limit readings.
 * When a provider resets a window early, the reset time stays the same but
 * the percent falls to near zero, and the usage before it no longer counts.
 * Spend from before that point must not size the window.
 *
 * The rules follow Tokenfold's detect_resets and persistent_resets
 * (app/limit_readings.py). While the window is still open, a fall of at least
 * 10 points, or a wipe to exactly 0, is a reset that starts at the first low
 * reading. It stays pending until the next reading: a recovery to 80% of the
 * earlier level means a stale reading that came late, and cancels it without
 * touching an earlier confirmed reset. Every decrease is also kept as a drop
 * (the newest MAX_DROPS of the cycle): Tokenfold moves a window on a
 * decrease that a sibling bucket's reset explains, and a family window needs
 * the same evidence. One latest drop is not enough, because 1 to 2 point
 * dips are normal and a later dip would hide the fall at the reset.
 */
import { aheadOfClock } from "../clock-skew.ts";

/** A smaller fall can be the provider's rounding or a reading that came late. */
export const GRANT_DROP_PTS = 10;
/** A real reset restarts the meter near zero; a recovery to this share of the earlier level means a stale reading. */
export const GRANT_RECOVERY_FRACTION = 0.8;
/** Reset times jitter by seconds between readings; a different cycle is hours away. */
export const SAME_RESET_TOLERANCE_MS = 10 * 60_000;
/**
 * Twice the longest normal poll gap. Windows are polled every minute
 * (Anthropic through a proxy, Codex, OpenCode Go) or every 5 minutes
 * (Anthropic directly), and failed polls back off to at most 10 minutes
 * (MAX_BACKOFF_MS). A Retry-After can hold a poll for up to 60 minutes
 * (MAX_RETRY_AFTER_MS), and Pi does not poll while it is not running. After
 * such a gap the reset happened at an unknown time inside it, so the reset
 * is approximate: the safe direction.
 */
export const EXACT_GAP_MS = 20 * 60_000;
/** A week of normal readings has few decreases; this keeps the reset's fall in view past later dips. */
export const MAX_DROPS = 24;

export interface GrantedReset {
	/** The first reading after the fall: spend counts from here. */
	startMs: number;
	/** The cycle the reset belongs to. */
	resetMs: number;
	beforePct: number;
	/** The last reading before the fall: the earliest time the reset can have happened. */
	lastHighMs: number;
	/** The gap from lastHighMs to startMs is longer than EXACT_GAP_MS. */
	approximate: boolean;
}

/** The latest decrease in the cycle, between two readings. */
export interface Drop {
	fromMs: number;
	atMs: number;
}

/** The last reading of one window, with what it showed in its cycle. */
export interface WindowReading {
	pct: number;
	resetMs: number;
	atMs: number;
	/** The latest confirmed granted reset. */
	grant?: GrantedReset;
	/** A granted reset that the next reading confirms or cancels. */
	pending?: GrantedReset;
	/** This cycle's decreases, oldest first, at most MAX_DROPS. */
	drops?: Drop[];
}

/** What the dollar figures use: confirmed resets only. */
export interface WindowEvidence {
	resetMs: number;
	grant?: GrantedReset;
	drops?: Drop[];
}

export interface Reading {
	pct: number;
	resetMs: number;
	atMs: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const sameReset = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_RESET_TOLERANCE_MS;

/**
 * The next record for one window. A reading that is not newer than the last one
 * changes nothing. A last reading stamped well ahead of this one came from a clock
 * that was wrong, and is no base for this one.
 */
export function advanceReading(prev: WindowReading | undefined, cur: Reading): WindowReading {
	const fresh: WindowReading = { pct: cur.pct, resetMs: cur.resetMs, atMs: cur.atMs };
	if (prev && aheadOfClock(prev.atMs, cur.atMs)) return fresh;
	if (prev && cur.atMs <= prev.atMs) return prev;
	// A reading from another cycle starts the record again.
	if (!prev || !sameReset(prev.resetMs, cur.resetMs)) return fresh;
	let { grant, drops } = prev;
	let pending: GrantedReset | undefined;
	if (prev.pending && cur.pct < prev.pending.beforePct * GRANT_RECOVERY_FRACTION) grant = prev.pending;
	// Both checks keep a natural rollover out: the earlier window must still be open at the new reading.
	const open = prev.resetMs > prev.atMs && prev.resetMs > cur.atMs;
	if (open && cur.pct < prev.pct) {
		drops = [...drops ?? [], { fromMs: prev.atMs, atMs: cur.atMs }].slice(-MAX_DROPS);
		if (cur.pct <= prev.pct - GRANT_DROP_PTS || cur.pct === 0) {
			pending = {
				startMs: cur.atMs, resetMs: cur.resetMs, beforePct: prev.pct, lastHighMs: prev.atMs,
				approximate: cur.atMs - prev.atMs > EXACT_GAP_MS,
			};
		}
	}
	return { ...fresh, ...(grant ? { grant } : {}), ...(pending ? { pending } : {}), ...(drops ? { drops } : {}) };
}

export function evidenceOf(record: WindowReading): WindowEvidence | undefined {
	if (!record.grant && !record.drops?.length) return undefined;
	return { resetMs: record.resetMs, ...(record.grant ? { grant: record.grant } : {}), ...(record.drops?.length ? { drops: record.drops } : {}) };
}

/**
 * Several processes share the readings file. Merge this process's changed
 * keys into what is on disk now, keeping the newer record per key, so a
 * slower writer cannot put back an older record and lose a reset.
 */
export function mergeReadings(onDisk: Record<string, WindowReading>, ours: Record<string, WindowReading>, changed: readonly string[]): Record<string, WindowReading> {
	let merged = onDisk;
	for (const key of changed) {
		const mine = ours[key];
		const theirs = merged[key];
		if (mine && (!theirs || mine.atMs > theirs.atMs || aheadOfClock(theirs.atMs, mine.atMs))) merged = { ...merged, [key]: mine };
	}
	return merged;
}

function isGrant(value: unknown): value is GrantedReset {
	const grant = value as GrantedReset | null;
	return !!grant && finite(grant.startMs) && finite(grant.resetMs) && finite(grant.beforePct) && finite(grant.lastHighMs)
		&& typeof grant.approximate === "boolean";
}

function isDrop(value: unknown): value is Drop {
	const drop = value as Drop | null;
	return !!drop && finite(drop.fromMs) && finite(drop.atMs);
}

/** Stored records are shared by processes and may be damaged: keep only valid ones. */
export function isWindowReading(value: unknown): value is WindowReading {
	const record = value as WindowReading | null;
	return !!record && finite(record.pct) && finite(record.resetMs) && finite(record.atMs)
		&& (record.grant === undefined || isGrant(record.grant))
		&& (record.pending === undefined || isGrant(record.pending))
		&& (record.drops === undefined || (Array.isArray(record.drops) && record.drops.length <= MAX_DROPS && record.drops.every(isDrop)));
}
