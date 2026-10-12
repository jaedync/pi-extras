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
 * touching an earlier confirmed reset. Any decrease is also kept as a drop:
 * Tokenfold moves a window on a decrease that a sibling bucket's reset
 * explains, and a family window needs the same evidence.
 */

/** A smaller fall can be the provider's rounding or a reading that came late. */
export const GRANT_DROP_PTS = 10;
/** A real reset restarts the meter near zero; a recovery to this share of the earlier level means a stale reading. */
export const GRANT_RECOVERY_FRACTION = 0.8;
/** Reset times jitter by seconds between readings; a different cycle is hours away. */
export const SAME_RESET_TOLERANCE_MS = 10 * 60_000;
/**
 * Windows are polled every 5 minutes at most, or 10 under backoff. A longer
 * gap means Pi was not polling, so the reset happened at an unknown time
 * inside the gap, and the spend in that gap is not counted.
 */
export const EXACT_GAP_MS = 20 * 60_000;

export interface GrantedReset {
	/** The first reading after the fall: spend counts from here. */
	startMs: number;
	/** The cycle the reset belongs to. */
	resetMs: number;
	beforePct: number;
	/** The last reading before the fall; the reset happened after it. */
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
	drop?: Drop;
}

/** What the dollar figures use: confirmed resets only. */
export interface WindowEvidence {
	resetMs: number;
	grant?: GrantedReset;
	drop?: Drop;
}

export interface Reading {
	pct: number;
	resetMs: number;
	atMs: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const sameReset = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_RESET_TOLERANCE_MS;

/** The next record for one window. A reading that is not newer than the last one changes nothing. */
export function advanceReading(prev: WindowReading | undefined, cur: Reading): WindowReading {
	if (prev && cur.atMs <= prev.atMs) return prev;
	const fresh: WindowReading = { pct: cur.pct, resetMs: cur.resetMs, atMs: cur.atMs };
	// A reading from another cycle starts the record again.
	if (!prev || !sameReset(prev.resetMs, cur.resetMs)) return fresh;
	let { grant, drop } = prev;
	let pending: GrantedReset | undefined;
	if (prev.pending && cur.pct < prev.pending.beforePct * GRANT_RECOVERY_FRACTION) grant = prev.pending;
	// Both checks keep a natural rollover out: the earlier window must still be open at the new reading.
	const open = prev.resetMs > prev.atMs && prev.resetMs > cur.atMs;
	if (open && cur.pct < prev.pct) {
		drop = { fromMs: prev.atMs, atMs: cur.atMs };
		if (cur.pct <= prev.pct - GRANT_DROP_PTS || cur.pct === 0) {
			pending = {
				startMs: cur.atMs, resetMs: cur.resetMs, beforePct: prev.pct, lastHighMs: prev.atMs,
				approximate: cur.atMs - prev.atMs > EXACT_GAP_MS,
			};
		}
	}
	return { ...fresh, ...(grant ? { grant } : {}), ...(pending ? { pending } : {}), ...(drop ? { drop } : {}) };
}

export function evidenceOf(record: WindowReading): WindowEvidence | undefined {
	if (!record.grant && !record.drop) return undefined;
	return { resetMs: record.resetMs, ...(record.grant ? { grant: record.grant } : {}), ...(record.drop ? { drop: record.drop } : {}) };
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
		if (mine && (!merged[key] || mine.atMs > merged[key].atMs)) merged = { ...merged, [key]: mine };
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
		&& (record.drop === undefined || isDrop(record.drop));
}
