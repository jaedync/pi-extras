/**
 * A child's usage-window limit (`maxWindowPct`): the fullest subscription
 * window that governs its model, read from the limit store that Status Plus
 * fills (limit-store.ts). The team wraps a run up when that window reaches
 * the limit, as at a time or cost budget.
 */
import type { LimitSnapshot } from "../limit-store.ts";
import { entryApplies, entryKind, missingReason, NO_READING_REASON } from "../usage-guard-core.ts";

export interface WindowReading {
	/** The provider and the window, as `anthropic 7d`. */
	readonly label: string;
	readonly pct: number;
}

/** The reading for `model`, or why there is none (a provider with no usage source, or no reading yet). */
export type WindowLookup = { reading: WindowReading } | { why: string };

export function windowReading(get: (provider: string) => LimitSnapshot | undefined, model: string): WindowLookup {
	const slash = model.indexOf("/");
	const provider = slash > 0 ? model.slice(0, slash) : model;
	const id = slash > 0 ? model.slice(slash + 1) : model;
	const snapshot = get(provider);
	if (!snapshot) {
		const why = missingReason(provider);
		return { why: why === NO_READING_REASON ? `${provider} has no usage reading yet; the limit acts once Status Plus polls one.` : why };
	}
	const windows = snapshot.entries.filter((entry) => entryKind(entry) === "window" && entryApplies(entry, { provider, id }) && (entry.usedPct !== undefined || entry.exhausted === true));
	if (windows.length === 0) return { why: `${provider} reports no usage windows for ${id}.` };
	// A blocked window counts as full, whatever its percentage says.
	const pct = (entry: (typeof windows)[number]): number => (entry.exhausted ? 100 : entry.usedPct ?? 0);
	const fullest = windows.reduce((top, entry) => (pct(entry) > pct(top) ? entry : top));
	return { reading: { label: `${provider} ${fullest.label}`, pct: pct(fullest) } };
}

/** The wrap-up reason; the report reads `reached its 80% limit on the anthropic 7d window`. */
export const windowReason = (limit: number, reading: WindowReading): string => `over its ${limit}% limit on the ${reading.label} window`;

/** What the spawn result says when the limit can't act, and that the cost cap still does. */
export const windowUnavailable = (model: string, why: string): string =>
	`maxWindowPct can't act on ${model} now: ${why} A time or cost budget (maxMinutes, maxCost) still applies.`;
