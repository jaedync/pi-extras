import { CHARS_PER_TOKEN } from "./cc-phase.ts";

/** The divider's live TPS covers the latest second and is redrawn on every frame. */
export const LIVE_WINDOW_MS = 1000;
const MS_PER_SECOND = 1000;

interface Arrival {
	readonly at: number;
	readonly chars: number;
	/**
	 * The silence before it. Some providers hold a tool call back and send it whole when the
	 * model is done, so a burst counts as if it came evenly over the silence that hid it.
	 */
	readonly spreadMs: number;
}

export interface LiveRate {
	readonly startedAt: number;
	readonly lastAt?: number;
	readonly arrivals: readonly Arrival[];
}

/** One rate per request: the silence before its first tokens counts from its start, never across tool runs. */
export function emptyLiveRate(startedAt: number): LiveRate {
	return { startedAt, arrivals: [] };
}

export function noteArrival(rate: LiveRate, at: number, chars: number): LiveRate {
	const since = rate.lastAt ?? rate.startedAt;
	if (!(chars > 0) || !Number.isFinite(at) || at < since) return rate;
	// Time only moves forward, so an arrival a window older than this one can never count again.
	const kept = rate.arrivals.filter((arrival) => arrival.at > at - LIVE_WINDOW_MS);
	return { ...rate, lastAt: at, arrivals: [...kept, { at, chars, spreadMs: at - since }] };
}

/** Tokens per second over the latest second, or undefined when none came in it. */
export function liveTokensPerSecond(rate: LiveRate | undefined, now: number): number | undefined {
	if (rate?.lastAt === undefined || now - rate.lastAt >= LIVE_WINDOW_MS) return undefined;
	const from = now - LIVE_WINDOW_MS;
	let chars = 0;
	for (const arrival of rate.arrivals) {
		if (arrival.at <= from || arrival.at > now) continue;
		chars += arrival.spreadMs > 0 ? arrival.chars * Math.min(1, (arrival.at - from) / arrival.spreadMs) : arrival.chars;
	}
	return chars / CHARS_PER_TOKEN / (LIVE_WINDOW_MS / MS_PER_SECOND);
}
