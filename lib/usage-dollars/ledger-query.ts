/**
 * Spend queries over the ledger's records. A turn copied into a fork keeps
 * its id and its time, so it counts once: the first copy in file order. A
 * range keeps the first copy it holds, so for an id whose copies all share a
 * time, the first copy of all is the one each range keeps. This builds, once
 * per refresh, the list of those first copies by provider key; each query is
 * one pass with no set of ids. The few ids whose copies differ in time
 * (a test fixture that reuses a response id) stay in every list and are
 * deduplicated per query, so every sum has the same records, added in the
 * same order, as before: the same figures to the last bit.
 */
import { limitKey } from "../plan-billing.ts";
import { familyMatches, type SpendRecord } from "./ledger-parse.ts";

export interface SpendQueries {
	sum(query: { provider: string; sinceMs: number; untilMs: number; family?: string }): number;
	byProvider(sinceMs: number, untilMs: number): Record<string, number>;
	models(provider: string, sinceMs: number): string[];
}

interface Entry {
	record: SpendRecord;
	/** A copy of an id whose copies differ in time: a range counts only its first copy in the range. */
	perRange: boolean;
}

/** limitKey() and familyMatches() parse strings; a week holds about 50,000 records over a few dozen names. */
function memo<T>(compute: (key: string) => T): (key: string) => T {
	const known = new Map<string, T>();
	return (key) => {
		if (!known.has(key)) known.set(key, compute(key));
		return known.get(key) as T;
	};
}

/** Ids whose copies differ in time. */
function splitIds(sources: ReadonlyArray<{ records: readonly SpendRecord[] }>): Set<string> {
	const firstTs = new Map<string, number>();
	const split = new Set<string>();
	for (const state of sources) {
		for (const record of state.records) {
			const ts = firstTs.get(record.id);
			if (ts === undefined) firstTs.set(record.id, record.ts);
			else if (ts !== record.ts) split.add(record.id);
		}
	}
	return split;
}

export function createSpendQueries(files: Iterable<{ records: readonly SpendRecord[] }>): SpendQueries {
	const sources = [...files];
	const keyOf = memo(limitKey);
	const matches = memo((pair) => {
		const at = pair.indexOf("\u0000");
		return familyMatches(pair.slice(0, at), pair.slice(at + 1));
	});
	const split = splitIds(sources);
	const ordered: Entry[] = [];
	const taken = new Set<string>();
	for (const state of sources) {
		for (const record of state.records) {
			if (split.has(record.id)) ordered.push({ record, perRange: true });
			else if (!taken.has(record.id)) {
				taken.add(record.id);
				ordered.push({ record, perRange: false });
			}
		}
	}
	// A per-range copy can take its id from a range in any key's list, so it sits in all of them.
	const perRangeOnly = ordered.filter((entry) => entry.perRange);
	const byKey = new Map<string, Entry[]>();
	for (const entry of ordered) {
		const key = keyOf(entry.record.provider);
		if (!byKey.has(key)) byKey.set(key, []);
	}
	for (const entry of ordered) {
		if (entry.perRange) for (const list of byKey.values()) list.push(entry);
		else byKey.get(keyOf(entry.record.provider))?.push(entry);
	}

	/** The records a range counts, in order, from one list; with `key`, only those of that key. */
	function* counted(list: readonly Entry[], sinceMs: number, untilMs: number, key?: string): Generator<SpendRecord> {
		const seen = new Set<string>();
		for (const { record, perRange } of list) {
			if (record.ts < sinceMs || record.ts > untilMs) continue;
			if (perRange) {
				if (seen.has(record.id)) continue;
				seen.add(record.id);
			}
			if (key === undefined || keyOf(record.provider) === key) yield record;
		}
	}
	const listOf = (key: string): readonly Entry[] => byKey.get(key) ?? perRangeOnly;

	return {
		sum({ provider, sinceMs, untilMs, family }) {
			const key = keyOf(provider);
			let total = 0;
			for (const record of counted(listOf(key), sinceMs, untilMs, key)) {
				if (!family || matches(`${record.model}\u0000${family}`)) total += record.cost;
			}
			return total;
		},
		byProvider(sinceMs, untilMs) {
			const totals: Record<string, number> = {};
			for (const record of counted(ordered, sinceMs, untilMs)) {
				const key = keyOf(record.provider);
				totals[key] = (totals[key] ?? 0) + record.cost;
			}
			return totals;
		},
		models(provider, sinceMs) {
			const key = keyOf(provider);
			const models = new Set<string>();
			for (const record of counted(listOf(key), sinceMs, Infinity, key)) models.add(record.model);
			return [...models];
		},
	};
}
