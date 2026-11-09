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

/** limitKey() and familyMatches() parse strings; a week holds about 50,000 records over a few dozen names. */
function memo<T>(compute: (key: string) => T): (key: string) => T {
	const known = new Map<string, T>();
	return (key) => {
		if (!known.has(key)) known.set(key, compute(key));
		return known.get(key) as T;
	};
}

export function createSpendQueries(files: Iterable<{ records: readonly SpendRecord[] }>): SpendQueries {
	const sources = [...files];
	const keyOf = memo(limitKey);
	const matches = memo((pair) => {
		const at = pair.indexOf("\u0000");
		return familyMatches(pair.slice(0, at), pair.slice(at + 1));
	});
	// The first copy of each id in file order, the later copies (a few forks), and the ids whose copies differ in time.
	const firstTs = new Map<string, number>();
	const split = new Set<string>();
	const firsts: SpendRecord[] = [];
	const firstAt: number[] = [];
	const later: Array<{ at: number; record: SpendRecord }> = [];
	let at = 0;
	for (const state of sources) {
		for (const record of state.records) {
			at++;
			const ts = firstTs.get(record.id);
			if (ts === undefined) {
				firstTs.set(record.id, record.ts);
				firsts.push(record);
				firstAt.push(at);
				continue;
			}
			later.push({ at, record });
			if (ts !== record.ts) split.add(record.id);
		}
	}
	/** A copy of a split id: a range counts only its first copy in the range. */
	const perRange = (record: SpendRecord): boolean => split.size > 0 && split.has(record.id);
	// Every copy of a split id keeps its place in file order, between the first copies.
	const ordered: SpendRecord[] = split.size === 0 ? firsts : [];
	if (split.size > 0) {
		let next = 0;
		for (const copy of later) {
			if (!split.has(copy.record.id)) continue;
			for (; next < firsts.length && (firstAt[next] ?? Infinity) < copy.at; next++) ordered.push(firsts[next] as SpendRecord);
			ordered.push(copy.record);
		}
		for (; next < firsts.length; next++) ordered.push(firsts[next] as SpendRecord);
	}
	// A per-range copy can take its id from a range in any key's list, so it sits in all of them.
	const byKey = new Map<string, SpendRecord[]>();
	for (const record of ordered) {
		const key = keyOf(record.provider);
		if (!byKey.has(key)) byKey.set(key, []);
	}
	for (const record of ordered) {
		if (perRange(record)) for (const list of byKey.values()) list.push(record);
		else byKey.get(keyOf(record.provider))?.push(record);
	}
	const perRangeOnly = ordered.filter(perRange);
	const listOf = (key: string): readonly SpendRecord[] => byKey.get(key) ?? perRangeOnly;

	/** Calls `take` with the records a range counts, in order, from one list; with `key`, only those of that key. */
	function counted(list: readonly SpendRecord[], sinceMs: number, untilMs: number, key: string | undefined, take: (record: SpendRecord) => void): void {
		const seen = split.size > 0 ? new Set<string>() : undefined;
		for (const record of list) {
			if (record.ts < sinceMs || record.ts > untilMs) continue;
			if (seen && split.has(record.id)) {
				if (seen.has(record.id)) continue;
				seen.add(record.id);
			}
			if (key === undefined || keyOf(record.provider) === key) take(record);
		}
	}

	return {
		sum({ provider, sinceMs, untilMs, family }) {
			const key = keyOf(provider);
			let total = 0;
			counted(listOf(key), sinceMs, untilMs, key, (record) => {
				if (!family || matches(`${record.model}\u0000${family}`)) total += record.cost;
			});
			return total;
		},
		byProvider(sinceMs, untilMs) {
			const totals: Record<string, number> = {};
			counted(ordered, sinceMs, untilMs, undefined, (record) => {
				const key = keyOf(record.provider);
				totals[key] = (totals[key] ?? 0) + record.cost;
			});
			return totals;
		},
		models(provider, sinceMs) {
			const key = keyOf(provider);
			const models = new Set<string>();
			counted(listOf(key), sinceMs, Infinity, key, (record) => { models.add(record.model); });
			return [...models];
		},
	};
}
