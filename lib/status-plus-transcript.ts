/**
 * Session statistics recovered from the transcript branch.
 *
 * Everything durable (counts, spend, airtime, last API end) is recomputed
 * from the branch on every update, so /undo, branch switches, resume, and
 * /reload stay consistent. Subagent children run in their own sessions, so
 * their usage is recovered from linked native sessions, artifact transcripts,
 * and inline/metadata totals. Parent context/cache state stays parent-only.
 */
import { ChildEvidenceCollector } from "./status-plus-children.ts";
import { addChild, messageIdentity, supplementChild } from "./status-plus-usage.ts";
import { toEpochMs } from "./status-plus-logic.ts";
import { CHAIN_ENTRY, savedRan } from "./chain/run.ts";
import { EMPTY_PROVIDER, type ProviderStats } from "./status-plus-render.ts";
import { commandsIn, isShell, type StepUnit } from "./tool-count.ts";

export const BILLING_SOURCE_ENTRY = "status-plus-billing-source";

export interface BillingSourceEntry {
	messageTimestampMs: number;
	provider: "opencode";
}

export interface AssistantLike {
	role: "assistant";
	provider: string;
	model: string;
	timestamp: number;
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cost: { total: number } };
	content: Array<{ type: string }>;
	stopReason?: string;
}

/** The subset of a Pi session entry this module reads. */
export interface BranchEntry {
	id?: string;
	details?: unknown;
	type: string;
	timestamp: string;
	customType?: string;
	content?: unknown;
	data?: unknown;
	message?: { role: string; toolName?: unknown; details?: unknown } | AssistantLike;
	/** model_change and usage entries name the model; summaries only carry usage. */
	provider?: unknown;
	modelId?: unknown;
	model?: unknown;
	kind?: unknown;
	usage?: unknown;
}

export interface TranscriptSource {
	getBranch(): BranchEntry[];
	getSessionDir(): string;
	getSessionFile?(): string | undefined;
	/** Cost of an assistant message, recovering catalog pricing when zero was persisted. */
	costOf(message: AssistantLike): number;
}

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface SessionStats {
	prompts: number;
	toolCalls: number;
	/** Steps each chained bash call ran, by tool call id, from Tool Display's saved chains. */
	chains: Map<string, number>;
	/**
	 * The parts of each counted call that is more than one step, by tool call id:
	 * a chained shell call, or a script with the calls it made. Subagents and
	 * scripts save no chains, so this is what their steps are counted from.
	 */
	plans: Map<string, readonly StepUnit[]>;
	turns: number;
	providers: Map<string, ProviderStats>;
	tokens: TokenTotals;
	/** Cache read share of the newest prompt a provider reported reading, in percent. */
	cacheHitPct?: number;
	lastApiEndMs?: number;
	/** End of the newest request that reported reading its prompt, which is what keeps the cache warm. */
	lastCacheMs?: number;
	/** Whether the newest cache write used one-hour retention; undefined when no write reported it either way. */
	cacheLongRetention?: boolean;
	/** Newest compaction/branch summary; the old prompt-prefix cache is unreachable after it. */
	lastContextResetMs?: number;
	/** Some child evidence waited for a later walk's reads, so the totals are still catching up. */
	partial?: boolean;
}

interface ToolCallBlock {
	type: string;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
}

// Saved entries never change and Pi hands back the same objects on each walk;
// splitting every command again was most of a walk's cost after hashing.
const shellPlans = new WeakMap<object, number>();
const scriptPlans = new WeakMap<object, StepUnit[] | undefined>();

function shellPlan(block: ToolCallBlock): number {
	let planned = shellPlans.get(block);
	if (planned === undefined) shellPlans.set(block, planned = commandsIn(block.arguments));
	return planned;
}

/** The calls a script made, from the nestedCalls Pi saves on its result. */
function scriptPlan(result: { toolCallId?: unknown; nestedCalls?: unknown }): StepUnit[] | undefined {
	if (scriptPlans.has(result)) return scriptPlans.get(result);
	const calls = (result.nestedCalls as { calls?: unknown } | undefined)?.calls;
	const units = Array.isArray(calls) && calls.length > 0
		? calls.map((raw, index): StepUnit => {
			const call = (raw ?? {}) as { id?: unknown; name?: unknown; arguments?: unknown; args?: unknown };
			const id = typeof call.id === "string" ? call.id : `${String(result.toolCallId)}/${index}`;
			return { id, planned: typeof call.name === "string" && isShell(call.name) ? commandsIn(call.arguments ?? call.args) : 1 };
		})
		: undefined;
	scriptPlans.set(result, units);
	return units;
}

function providerStats(stats: SessionStats, id: string): ProviderStats {
	let provider = stats.providers.get(id);
	if (!provider) {
		provider = { ...EMPTY_PROVIDER };
		stats.providers.set(id, provider);
	}
	return provider;
}

function zenFallbackMessages(branch: BranchEntry[]): Set<number> {
	const marked = new Set<number>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== BILLING_SOURCE_ENTRY) continue;
		const data = entry.data as Partial<BillingSourceEntry> | undefined;
		if (data?.provider === "opencode" && typeof data.messageTimestampMs === "number") {
			marked.add(data.messageTimestampMs);
		}
	}
	return marked;
}

function newest(current: number | undefined, candidate: number): number | undefined {
	if (!Number.isFinite(candidate)) return current;
	return !current || candidate > current ? candidate : current;
}

type UsageLike = AssistantLike["usage"];

function usageOf(value: unknown): UsageLike | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Partial<UsageLike>;
	return { ...usage, cost: { total: Number(usage.cost?.total) || 0 } };
}

const promptTokensOf = (usage: UsageLike): number => (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

function addTokens(tokens: TokenTotals, usage: UsageLike): TokenTotals {
	return {
		input: tokens.input + (usage.input ?? 0),
		output: tokens.output + (usage.output ?? 0),
		cacheRead: tokens.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: tokens.cacheWrite + (usage.cacheWrite ?? 0),
	};
}

/**
 * Spend Pi records outside replies: compaction and branch summaries, and cache
 * refreshes. It is billed like any request but is neither a turn nor a sign of
 * how warm the conversation's cache is.
 */
function chargeOffTurn(stats: SessionStats, source: TranscriptSource, model: { provider: string; id: string }, usage: UsageLike): void {
	stats.tokens = addTokens(stats.tokens, usage);
	const provider = providerStats(stats, model.provider);
	provider.cost += source.costOf({ role: "assistant", provider: model.provider, model: model.id, timestamp: 0, usage, content: [] });
	provider.inputTokens += promptTokensOf(usage);
	provider.outputTokens += usage.output ?? 0;
}

function collectEntries(source: TranscriptSource): SessionStats {
	const stats: SessionStats = {
		prompts: 0, toolCalls: 0, chains: new Map(), plans: new Map(), turns: 0, providers: new Map(),
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const branch = source.getBranch();
	const zenMessages = zenFallbackMessages(branch);
	// Pi summarizes with the session's current model, which these track.
	let active = { provider: "unknown", id: "" };
	// Cache lifetime evidence only describes the provider that wrote it.
	let retentionProvider: string | undefined;
	/** Tool calls this walk counted, so a script's result can add the calls it made. */
	const counted = new Set<string>();

	for (const entry of branch) {
		if (entry.type === "model_change" && typeof entry.provider === "string") {
			active = { provider: entry.provider, id: String(entry.modelId ?? "") };
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			stats.lastContextResetMs = newest(stats.lastContextResetMs, Date.parse(entry.timestamp));
			const usage = usageOf(entry.usage);
			if (usage) chargeOffTurn(stats, source, active, usage);
			continue;
		}
		if (entry.type === "usage") {
			const usage = usageOf(entry.usage);
			const model = typeof entry.provider === "string" ? { provider: entry.provider, id: String(entry.model ?? "") } : active;
			if (usage) chargeOffTurn(stats, source, model, usage);
			// A refresh keeps the cache warm exactly as a reply would.
			if (entry.kind === "cache_warm") {
				stats.lastApiEndMs = newest(stats.lastApiEndMs, Date.parse(entry.timestamp));
				stats.lastCacheMs = newest(stats.lastCacheMs, Date.parse(entry.timestamp));
			}
			continue;
		}
		if (entry.type === "custom" && entry.customType === CHAIN_ENTRY) {
			const ran = savedRan(entry.data);
			const id = (entry.data as { toolCallId?: unknown }).toolCallId;
			if (ran !== undefined && typeof id === "string") stats.chains.set(id, ran);
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") {
			stats.prompts++;
			continue;
		}
		if (entry.message.role === "toolResult") {
			const result = entry.message as { toolCallId?: unknown; nestedCalls?: unknown };
			// Only for a call this walk counted: a copied or failed reply's results add nothing.
			const units = typeof result.toolCallId === "string" && counted.has(result.toolCallId) ? scriptPlan(result) : undefined;
			if (units) stats.plans.set(result.toolCallId as string, units);
			continue;
		}
		if (entry.message.role !== "assistant") continue;

		const message = entry.message as AssistantLike;
		if (typeof message.provider === "string") active = { provider: message.provider, id: String(message.model ?? "") };
		stats.turns++;
		// A failed or aborted reply's tool calls are never run.
		const ran = message.stopReason !== "error" && message.stopReason !== "aborted";
		for (const block of ran && Array.isArray(message.content) ? message.content as ToolCallBlock[] : []) {
			if (block.type !== "toolCall") continue;
			stats.toolCalls++;
			if (typeof block.id !== "string") continue;
			counted.add(block.id);
			const planned = typeof block.name === "string" && isShell(block.name) ? shellPlan(block) : 1;
			if (planned > 1) stats.plans.set(block.id, [{ id: block.id, planned }]);
		}
		const usage = message.usage ?? { cost: { total: 0 } };
		stats.tokens = addTokens(stats.tokens, usage);
		const promptTokens = promptTokensOf(usage);
		// A request refused before its prompt was read says nothing about the cache.
		if (promptTokens > 0) stats.cacheHitPct = ((usage.cacheRead ?? 0) / promptTokens) * 100;
		// Only Anthropic reports the one-hour split; other APIs leave it undefined, which is no evidence.
		if ((usage.cacheWrite ?? 0) > 0 && typeof usage.cacheWrite1h === "number") {
			stats.cacheLongRetention = usage.cacheWrite1h > 0;
			retentionProvider = message.provider;
		} else if (promptTokens > 0 && message.provider !== retentionProvider) {
			stats.cacheLongRetention = undefined;
			retentionProvider = undefined;
		}

		const startedMs = toEpochMs(message.timestamp);
		// OpenCode keeps the wire provider as opencode-go when an exhausted Go
		// allowance falls through to Zen; the durable marker keeps the billing
		// category right across reloads and branch changes.
		const billingProvider = message.provider === "opencode-go" && zenMessages.has(startedMs)
			? "opencode" : message.provider;
		const provider = providerStats(stats, billingProvider);
		if (message.usage?.cost) provider.cost += source.costOf(message);
		// A provider's "in" is everything sent to it: fresh input plus both cache classes.
		provider.inputTokens += promptTokens;
		provider.outputTokens += usage.output ?? 0;

		const finishedMs = Date.parse(entry.timestamp);
		if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) continue;
		if (finishedMs > startedMs) provider.airtimeMs += finishedMs - startedMs;
		stats.lastApiEndMs = newest(stats.lastApiEndMs, finishedMs);
		if (promptTokens > 0) stats.lastCacheMs = newest(stats.lastCacheMs, finishedMs);
	}

	return stats;
}

export function collect(source: TranscriptSource): SessionStats {
	const branch = source.getBranch();
	const stats = collectEntries({ ...source, getBranch: () => branch });
	const children = new ChildEvidenceCollector(source.getSessionDir(), source.getSessionFile?.());
	children.scanBranch(branch, source.getSessionFile?.() ?? "parent");
	const resolved = children.resolve();
	if (children.partial) stats.partial = true;
	if (resolved.length === 0) return stats;
	// Hashing every message is only needed to tell a child's copies apart from the parent's.
	const seen = new Set(branch.map(entry => messageIdentity(entry)).filter((id): id is string => !!id));
	// Id-free fingerprints of every counted message. One child can surface under two
	// run ids (a native session and another run's artifact copy of it), and those
	// copies share no row ids, so only these fingerprints can tell them apart.
	const counted = new Set(branch.map(entry => messageIdentity(entry, false)).filter((id): id is string => !!id));
	// Each child entry's fingerprint is needed up to three times; hashing is the costly part of a refresh.
	const fingerprints = new Map<BranchEntry, string | undefined>();
	const copyOf = (entry: BranchEntry): string | undefined => {
		if (!fingerprints.has(entry)) fingerprints.set(entry, messageIdentity(entry, false));
		return fingerprints.get(entry);
	};
	const paths = new Set<string>();
	for (const child of resolved) {
		const evidencePaths = [...child.sessionFiles, ...child.transcriptPaths];
		let inherited = evidencePaths.some(path => paths.has(path));
		evidencePaths.forEach(path => paths.add(path));
		// Independent parallel children never share a response, so only a child that
		// repeats an already-counted reply is a copy whose prompts may be repeats too.
		const alias = child.entries.some(entry => entry.message?.role === "assistant" && counted.has(copyOf(entry) ?? ""));
		if (alias) inherited = true;
		const local = new Set<string>();
		const copies = new Set<string>();
		const entries = child.entries.filter(entry => {
			const id = messageIdentity(entry, true, child.key);
			if (!id) return true;
			const copy = copyOf(entry)!;
			if (local.has(id) || !entry.id && copies.has(copy)) return false;
			local.add(id);
			copies.add(copy);
			if (seen.has(id) || alias && counted.has(copy)) { inherited = true; return false; }
			seen.add(id);
			return true;
		});
		for (const entry of entries) {
			const copy = copyOf(entry);
			if (copy) counted.add(copy);
		}
		const usage = collectEntries({ ...source, getBranch: () => entries });
		supplementChild(usage, child, inherited);
		addChild(stats, usage);
	}
	return stats;
}
