/**
 * Granted mid-window resets, seen from this machine's own limit readings.
 * When a provider resets a window early, the reset time stays the same but
 * the percent falls to near zero, and the usage before it no longer counts.
 * Spend from before that point must not size the window.
 *
 * The rules follow Tokenfold's detect_resets and persistent_resets
 * (app/limit_readings.py): a fall of at least 10 points while the window is
 * still open is a reset that starts at the first low reading, and the next
 * reading cancels it when it is back near the earlier level (a stale reading
 * that came late, not a reset).
 */

/** A smaller fall can be the provider's rounding or a reading that came late. */
export const GRANT_DROP_PTS = 10;
/** A real reset restarts the meter near zero; a recovery to this share of the earlier level means a stale reading. */
export const GRANT_RECOVERY_FRACTION = 0.8;
/** Reset times jitter by seconds between readings; a different cycle is hours away. */
export const SAME_RESET_TOLERANCE_MS = 10 * 60_000;

export interface GrantedReset {
	/** The first reading after the fall: spend counts from here. */
	startMs: number;
	/** The cycle the reset belongs to. */
	resetMs: number;
	beforePct: number;
	/** False until a later reading shows the fall was not a stale reading. */
	confirmed: boolean;
}

/** The last reading of one window, with the latest granted reset in its cycle. */
export interface WindowReading {
	pct: number;
	resetMs: number;
	atMs: number;
	grant?: GrantedReset;
}

export interface Reading {
	pct: number;
	resetMs: number;
	atMs: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const sameReset = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_RESET_TOLERANCE_MS;

/** Check the first reading after a new reset: a recovery cancels it. */
function settle(grant: GrantedReset | undefined, cur: Reading): GrantedReset | undefined {
	if (!grant || grant.confirmed || cur.atMs <= grant.startMs) return grant;
	return cur.pct >= grant.beforePct * GRANT_RECOVERY_FRACTION ? undefined : { ...grant, confirmed: true };
}

/** The next record for one window. A reading that is not newer than the last one changes nothing. */
export function advanceReading(prev: WindowReading | undefined, cur: Reading): WindowReading {
	if (prev && cur.atMs <= prev.atMs) return prev;
	// A reading from another cycle starts the record again.
	const last = prev && sameReset(prev.resetMs, cur.resetMs) ? prev : undefined;
	let grant = last ? settle(last.grant, cur) : undefined;
	// Both checks keep a natural rollover out: the earlier window must still be open at the new reading.
	const open = !!last && last.resetMs > last.atMs && last.resetMs > cur.atMs;
	if (last && open && cur.pct <= last.pct - GRANT_DROP_PTS) {
		grant = { startMs: cur.atMs, resetMs: cur.resetMs, beforePct: last.pct, confirmed: false };
	}
	return { pct: cur.pct, resetMs: cur.resetMs, atMs: cur.atMs, ...(grant ? { grant } : {}) };
}

function isGrant(value: unknown): value is GrantedReset {
	const grant = value as GrantedReset | null;
	return !!grant && finite(grant.startMs) && finite(grant.resetMs) && finite(grant.beforePct) && typeof grant.confirmed === "boolean";
}

/** Stored records are shared by processes and may be damaged: keep only valid ones. */
export function isWindowReading(value: unknown): value is WindowReading {
	const record = value as WindowReading | null;
	return !!record && finite(record.pct) && finite(record.resetMs) && finite(record.atMs)
		&& (record.grant === undefined || isGrant(record.grant));
}
