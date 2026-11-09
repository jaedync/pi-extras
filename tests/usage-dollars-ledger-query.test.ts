/** The ledger's query index must give the figures that deduplicating each range on its own gives, to the last bit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { limitKey } from "../lib/plan-billing.ts";
import { familyMatches, type SpendRecord } from "../lib/usage-dollars/ledger-parse.ts";
import { createSpendQueries } from "../lib/usage-dollars/ledger-query.ts";

/** The ledger's queries as 0.42.0 ran them: a set of ids for each range. */
function reference(files: Array<{ records: SpendRecord[] }>) {
	const unique = (sinceMs: number, untilMs: number) => {
		const seen = new Set<string>();
		const result: SpendRecord[] = [];
		for (const state of files) for (const record of state.records) {
			if (record.ts < sinceMs || record.ts > untilMs || seen.has(record.id)) continue;
			seen.add(record.id);
			result.push(record);
		}
		return result;
	};
	return {
		sum: ({ provider, sinceMs, untilMs, family }: { provider: string; sinceMs: number; untilMs: number; family?: string }) => unique(sinceMs, untilMs)
			.filter((record) => limitKey(record.provider) === limitKey(provider) && (!family || familyMatches(record.model, family)))
			.reduce((total, record) => total + record.cost, 0),
		byProvider: (sinceMs: number, untilMs: number) => {
			const totals: Record<string, number> = {};
			for (const record of unique(sinceMs, untilMs)) totals[limitKey(record.provider)] = (totals[limitKey(record.provider)] ?? 0) + record.cost;
			return totals;
		},
		models: (provider: string, sinceMs: number) =>
			[...new Set(unique(sinceMs, Infinity).filter((record) => limitKey(record.provider) === limitKey(provider)).map((record) => record.model))],
	};
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

test("property: the query index gives the per-range figures to the last bit, also for ids whose copies differ", () => {
	const providers = ["anthropic", "claude-code", "opencode-go", "openai-codex", "openai"];
	const models = ["claude-opus-5-5", "claude-fable-5-1", "glm-5.3", "gpt-6.1-sol"];
	for (let seed = 1; seed <= 300; seed++) {
		const rand = random(seed);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
		const ids = Array.from({ length: 8 + Math.floor(rand() * 20) }, (_, index) => `id${index}`);
		const base = new Map<string, SpendRecord>();
		const files = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
			records: Array.from({ length: Math.floor(rand() * 25) }, (): SpendRecord => {
				const id = pick(ids);
				const known = base.get(id);
				// Most copies repeat their first line exactly (a fork); some differ in time, provider or cost.
				if (known && rand() < 0.7) return known;
				const record = { id, ts: Math.floor(rand() * 100), provider: pick(providers), model: pick(models), cost: Math.round(rand() * 1e6) / 1e5 + rand() * 1e-9 };
				if (!known) base.set(id, record);
				return record;
			}),
		}));
		const fast = createSpendQueries(files);
		const slow = reference(files);
		for (let query = 0; query < 20; query++) {
			const sinceMs = Math.floor(rand() * 100) - 10;
			const untilMs = rand() < 0.2 ? Infinity : sinceMs + Math.floor(rand() * 80);
			const provider = pick(providers);
			const family = rand() < 0.3 ? pick(["fable", "opus", "gpt"]) : undefined;
			const where = `seed ${seed} query ${query}`;
			assert.equal(Object.is(fast.sum({ provider, sinceMs, untilMs, family }), slow.sum({ provider, sinceMs, untilMs, family })), true, where);
			assert.deepEqual(fast.byProvider(sinceMs, untilMs), slow.byProvider(sinceMs, untilMs), where);
			assert.deepEqual(fast.models(provider, sinceMs), slow.models(provider, sinceMs), where);
		}
	}
});
