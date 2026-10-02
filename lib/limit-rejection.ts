import type { LimitEntry } from "./status-plus-logic.ts";

const RESET_DRIFT_MS = 10 * 60_000;
const NEAR_FULL_PCT = 95;

interface Rejection {
	firstSeenMs: number;
	resetMs?: number;
	cleared: boolean;
}

/** Reconcile only proxy status. Other providers can accept requests against paid overage. */
export function createRejectionTracker() {
	const rejections = new Map<string, Rejection>();
	const keyFor = (provider: string, entry: LimitEntry) => `${provider}|${entry.key ?? entry.label}`;
	return {
		reconcile(provider: string, entries: LimitEntry[], now: number): LimitEntry[] {
			return entries.map((entry) => {
				const key = keyFor(provider, entry);
				if (!entry.proxyRejected) {
					rejections.delete(key);
					return { ...entry };
				}
				const prior = rejections.get(key) ?? { firstSeenMs: now, resetMs: entry.resetMs, cleared: false };
				const rollover = prior.resetMs !== undefined && entry.resetMs !== undefined &&
					prior.resetMs <= now && entry.resetMs - prior.resetMs > RESET_DRIFT_MS;
				const cleared = prior.cleared || rollover;
				rejections.set(key, { ...prior, cleared });
				// A proxy can refresh utilization and reset time but retain its last rejection.
				// New-cycle or successful-response evidence ends that rejection, not a low percentage alone.
				// Keep near-full buckets blocked because the new window can also genuinely be exhausted.
				const headroom = entry.usedPct !== undefined && Number.isFinite(entry.usedPct) && entry.usedPct < NEAR_FULL_PCT;
				return { ...entry, exhausted: !(cleared && headroom) };
			});
		},
		succeed(provider: string, modelId: string, entries: LimitEntry[], atMs: number): void {
			const tokens = modelId.toLowerCase().split(/[^a-z0-9]+/);
			for (const entry of entries) {
				if (entry.modelFamily && !tokens.includes(entry.modelFamily.toLowerCase())) continue;
				const key = keyFor(provider, entry);
				const prior = rejections.get(key);
				if (prior && atMs > prior.firstSeenMs) rejections.set(key, { ...prior, cleared: true });
			}
		},
	};
}
