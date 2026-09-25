/** Merge available child totals without inventing request counts or durations. */
import { createHash } from "node:crypto";
import type { ChildEvidence } from "./status-plus-children.ts";
import type { BranchEntry, SessionStats } from "./status-plus-transcript.ts";
import { EMPTY_PROVIDER } from "./status-plus-render.ts";

export function messageIdentity(entry: BranchEntry, includeEntryId = true, owner = "parent"): string | undefined {
	const message = entry.message as any;
	if (!message || !["assistant", "user"].includes(message.role)) return;
	if (message.timestamp === undefined && !entry.id) return;
	// Native forks/resumes retain row IDs. Keep those IDs across children so
	// independent identical parallel prompts aren't collapsed. Within a child,
	// artifact copies lack row IDs and are matched by the request fingerprint.
	return createHash("sha256").update(JSON.stringify([
		includeEntryId ? entry.id ?? (message.responseId ? undefined : owner) : undefined, message.responseId,
		message.role, message.timestamp ?? entry.id, message.provider, message.model, message.content,
	])).digest("hex");
}

const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const providerOf = (model: unknown): string => typeof model === "string" && model ? model.split("/")[0] : "unknown";
const costOf = (usage: any): number => number(typeof usage?.cost === "object" ? usage.cost.total : usage?.cost);

function metadataAdvanced(child: ChildEvidence): boolean {
	const meta = child.meta?.usage;
	const inline = child.inline?.usage;
	if (!inline) return true;
	if (number(meta?.turns) !== number(inline.turns)) return number(meta?.turns) > number(inline.turns);
	const tokens = (usage: any) => ["input", "output", "cacheRead", "cacheWrite"].reduce((total, key) => total + number(usage?.[key]), 0);
	return tokens(meta) > tokens(inline);
}

export function supplementChild(stats: SessionStats, child: ChildEvidence, inherited: boolean): void {
	// A fork/resume's summary can include already-counted history. Without an
	// incremental ledger, its aggregate must not be added back over deduped rows.
	if (inherited) return;
	if (!child.inline && !child.meta) return;
	// Detached receipts freeze earlier progress while metadata keeps advancing.
	// Prefer a demonstrably newer snapshot, not simply a larger dollar amount.
	// Legacy cost-only evidence cannot establish recency; retain inline priority.
	const [older, newer] = metadataAdvanced(child) ? [child.inline, child.meta] : [child.meta, child.inline];
	const record = { ...older, ...newer };
	const usage = { ...older?.usage, ...newer?.usage };
	stats.turns = Math.max(stats.turns, number(usage?.turns));
	stats.toolCalls = Math.max(stats.toolCalls, number(record.toolCount ?? record.progress?.toolCount ?? record.progressSummary?.toolCount ?? record.toolCalls?.length));
	const promptOf = (tokens: { input: number; cacheRead: number; cacheWrite: number }) => tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const inputGain = Math.max(0, promptOf({ input: number(usage?.input), cacheRead: number(usage?.cacheRead), cacheWrite: number(usage?.cacheWrite) }) - promptOf(stats.tokens));
	const outputGain = Math.max(0, number(usage?.output) - stats.tokens.output);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		stats.tokens[key] = Math.max(stats.tokens[key], number(usage?.[key]));
	}
	const attempts = Array.isArray(record.modelAttempts) ? record.modelAttempts : [];
	// Summaries report tokens per run, not per attempt, so only a single-model
	// run can attribute the growth to a provider; mixed runs keep the session total only.
	if (!attempts.length && (inputGain > 0 || outputGain > 0)) {
		const id = providerOf(record.model);
		const provider = stats.providers.get(id) ?? { ...EMPTY_PROVIDER };
		provider.inputTokens += inputGain;
		provider.outputTokens += outputGain;
		stats.providers.set(id, provider);
	}
	const total = costOf(usage);
	const recorded = [...stats.providers.values()].reduce((sum, p) => sum + p.cost, 0);
	if (total <= recorded) return;
	const attemptTotal = attempts.reduce((sum: number, a: any) => sum + costOf(a.usage), 0);
	if (attempts.length && Math.abs(attemptTotal - total) < 1e-9) {
		const targets = new Map<string, number>();
		for (const attempt of attempts) {
			const id = providerOf(attempt.model);
			targets.set(id, (targets.get(id) ?? 0) + costOf(attempt.usage));
		}
		let remaining = total - recorded;
		for (const [id, target] of targets) {
			const provider = stats.providers.get(id) ?? { ...EMPTY_PROVIDER };
			const delta = Math.min(remaining, Math.max(0, target - provider.cost));
			provider.cost += delta;
			remaining -= delta;
			stats.providers.set(id, provider);
		}
	} else {
		const id = providerOf(record.model);
		const provider = stats.providers.get(id) ?? { ...EMPTY_PROVIDER };
		provider.cost += total - recorded;
		stats.providers.set(id, provider);
	}
}

export function addChild(stats: SessionStats, child: SessionStats): void {
	stats.prompts += child.prompts;
	stats.turns += child.turns;
	stats.toolCalls += child.toolCalls;
	for (const [id, ran] of child.chains) stats.chains.set(id, ran);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) stats.tokens[key] += child.tokens[key];
	for (const [id, usage] of child.providers) {
		const provider = stats.providers.get(id) ?? { ...EMPTY_PROVIDER };
		provider.cost += usage.cost;
		provider.airtimeMs += usage.airtimeMs;
		provider.inputTokens += usage.inputTokens;
		provider.outputTokens += usage.outputTokens;
		stats.providers.set(id, provider);
	}
	// Deliberately do not merge cacheHitPct, lastApiEndMs or lastContextResetMs.
}
