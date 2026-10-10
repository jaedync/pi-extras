import { test } from "node:test";
import assert from "node:assert/strict";
import { pollAnthropicUsage, pollOpenRouterCredits } from "../lib/status-plus-limits.ts";

const registry = (provider: string) => ({ modelRegistry: {
	getProvider: () => undefined,
	getApiKeyForProvider: async (name: string) => (name === provider ? "test-only-token" : undefined),
} });

async function withFetch<T>(body: unknown, run: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify(body));
	try { return await run(); } finally { globalThis.fetch = original; }
}

test("the Anthropic OAuth meter carries its spend and limit in dollars", async () => {
	const entries = await withFetch({
		spend: { enabled: true, used: { amount_minor: 117083, exponent: 2 }, limit: { amount_minor: 200000 } },
	}, () => pollAnthropicUsage(registry("anthropic") as never));
	const budget = entries?.find((entry) => entry.kind === "budget");
	assert.equal(budget?.usedUsd, 1170.83);
	assert.equal(budget?.limitUsd, 2000);
	assert.equal(budget?.remainingText, "$829/$2000");
});

test("OpenRouter credits carry the balance in dollars", async () => {
	const entries = await withFetch({ data: { total_credits: 50, total_usage: 7.5 } },
		() => pollOpenRouterCredits(registry("openrouter") as never));
	assert.deepEqual(entries, [{ label: "", kind: "credits", remainingText: "$42.50 credits", balanceUsd: 42.5 }]);
});
