/**
 * Times other processes wrote, or this one wrote before its clock was
 * corrected (NTP, a manual change, a VM resume). A time a little ahead is
 * normal drift between processes; one further ahead would hold polls, limit
 * snapshots and reset detection for as long as the clock was wrong.
 */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** True for a time later than `now` plus the drift allowance. */
export const aheadOfClock = (ms: number, now: number): boolean => ms > now + CLOCK_SKEW_MS;
