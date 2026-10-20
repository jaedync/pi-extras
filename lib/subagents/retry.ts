import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * The least retry a child gets from Pi: 8 tries, 5 s apart at first and doubling up to 2 min, about 8.6 min in all.
 * With Pi's default (3 tries from 2 s) a child gave up after about 15 s, so a short outage ended a run on the model
 * its parent chose.
 */
const CHILD_RETRY = { maxRetries: 8, baseDelayMs: 5_000, maxAgentDelayMs: 120_000 } as const;

/** `settings` with a retry no shorter than CHILD_RETRY. Longer settings stay, and retry turned off stays off. */
export function withChildRetry(settings: SettingsManager): SettingsManager {
	const current = settings.getRetrySettings();
	settings.applyOverrides({ retry: {
		maxRetries: Math.max(current.maxRetries, CHILD_RETRY.maxRetries),
		baseDelayMs: Math.max(current.baseDelayMs, CHILD_RETRY.baseDelayMs),
		maxAgentDelayMs: Math.max(current.maxAgentDelayMs, CHILD_RETRY.maxAgentDelayMs),
	} });
	return settings;
}
