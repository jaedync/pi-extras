import { formatDuration, type LimitEntry } from "./status-plus-logic.ts";
import { localTime } from "./usage-time.ts";

export type PaceState = "below pace" | "on pace" | "above pace" | "too early to tell";

export interface UsagePace {
	durationSeconds: number;
	elapsedFraction: number;
	expectedUsagePct: number;
	projectedUsagePct?: number;
	state: PaceState;
	reaches100At?: string;
	reaches100AtLocal?: string;
	reaches100InSeconds?: number;
}

// A short burst at the start produces unstable projections. Wait for five percent
// of the window and at least one percent used before treating an average as evidence.
const MIN_ELAPSED_FRACTION = 0.05;
const MIN_USED_PCT = 1;
// Ten percentage points around a full-window projection absorb small quota rounding
// and request bursts without hiding a sustained excess rate.
const PACE_TOLERANCE_PCT = 10;
const roundPct = (value: number) => Math.round(value * 10) / 10;

export function usagePace(entry: LimitEntry, now: number, timeZone?: string): UsagePace | undefined {
	const { windowSeconds: duration, resetMs, usedPct } = entry;
	if (entry.kind && entry.kind !== "window" || entry.resetApprox) return undefined;
	if (duration === undefined || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(now)) return undefined;
	if (resetMs === undefined || !Number.isFinite(new Date(resetMs).getTime()) || resetMs <= now) return undefined;
	if (usedPct === undefined || !Number.isFinite(usedPct) || usedPct < 0) return undefined;
	const durationMs = duration * 1000;
	const elapsedMs = durationMs - (resetMs - now);
	if (!Number.isFinite(durationMs) || elapsedMs < 0) return undefined;
	const elapsedFraction = elapsedMs / durationMs;
	const base = { durationSeconds: duration, elapsedFraction, expectedUsagePct: roundPct(100 * elapsedFraction) };
	if (elapsedFraction < MIN_ELAPSED_FRACTION || usedPct < MIN_USED_PCT) {
		return { ...base, state: "too early to tell" };
	}
	const projected = usedPct / elapsedFraction;
	const state: PaceState = projected > 100 + PACE_TOLERANCE_PCT ? "above pace"
		: projected < 100 - PACE_TOLERANCE_PCT ? "below pace" : "on pace";
	const result = { ...base, projectedUsagePct: roundPct(projected), state };
	if (state !== "above pace") return result;
	const reachesMs = now - elapsedMs + elapsedMs * 100 / usedPct;
	if (!Number.isFinite(new Date(reachesMs).getTime())) return result;
	return {
		...result,
		reaches100At: new Date(reachesMs).toISOString(),
		reaches100AtLocal: localTime(reachesMs, timeZone),
		reaches100InSeconds: Math.max(0, Math.ceil((reachesMs - now) / 1000)),
	};
}

/** Keep the warning clause and tool popup consistent without changing warning thresholds. */
export function paceText(pace: UsagePace | undefined, resetsInSeconds?: number): string {
	if (!pace) return "";
	if (pace.state !== "above pace" || pace.reaches100InSeconds === undefined) return pace.state;
	if (pace.reaches100InSeconds === 0) return "above pace: 100% already reached";
	const reachesIn = formatDuration(pace.reaches100InSeconds * 1000, false);
	const reset = resetsInSeconds === undefined ? "" : `, before the reset in ${formatDuration(resetsInSeconds * 1000, false)}`;
	return `above pace: 100% in about ${reachesIn}${reset}`;
}
