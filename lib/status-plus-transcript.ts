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
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost: { total: number } };
	content: Array<{ type: string }>;
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
	turns: number;
	providers: Map<string, ProviderStats>;
	tokens: TokenTotals;
	/** Cache read share of the newest assistant message's prompt, in percent. */
	cacheHitPct?: number;
	lastApiEndMs?: number;
	/** Newest compaction/branch summary; the old prompt-prefix cache is unreachable after it. */
	lastContextResetMs?: number;
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

function collectEntries(source: TranscriptSource): SessionStats {
	const stats: SessionStats = {
		prompts: 0, toolCalls: 0, chains: new Map(), turns: 0, providers: new Map(),
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const branch = source.getBranch();
	const zenMessages = zenFallbackMessages(branch);

	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			stats.lastContextResetMs = newest(stats.lastContextResetMs, Date.parse(entry.timestamp));
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
		if (entry.message.role !== "assistant") continue;

		const message = entry.message as AssistantLike;
		stats.turns++;
		for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === "toolCall") stats.toolCalls++;
		const usage = message.usage ?? { cost: { total: 0 } };
		stats.tokens = {
			input: stats.tokens.input + (usage.input ?? 0),
			output: stats.tokens.output + (usage.output ?? 0),
			cacheRead: stats.tokens.cacheRead + (usage.cacheRead ?? 0),
			cacheWrite: stats.tokens.cacheWrite + (usage.cacheWrite ?? 0),
		};
		const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		stats.cacheHitPct = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;

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
	}

	return stats;
}

export function collect(source: TranscriptSource): SessionStats {
	const branch = source.getBranch();
	const stats = collectEntries({ ...source, getBranch: () => branch });
	const children = new ChildEvidenceCollector(source.getSessionDir(), source.getSessionFile?.());
	children.scanBranch(branch, source.getSessionFile?.() ?? "parent");
	const seen = new Set(branch.map(entry => messageIdentity(entry)).filter((id): id is string => !!id));
	const paths = new Set<string>();
	for (const child of children.resolve()) {
		const evidencePaths = [...child.sessionFiles, ...child.transcriptPaths];
		let inherited = evidencePaths.some(path => paths.has(path));
		evidencePaths.forEach(path => paths.add(path));
		const local = new Set<string>();
		const copies = new Set<string>();
		const entries = child.entries.filter(entry => {
			const id = messageIdentity(entry, true, child.key);
			if (!id) return true;
			const copy = messageIdentity(entry, false)!;
			if (local.has(id) || !entry.id && copies.has(copy)) return false;
			local.add(id);
			copies.add(copy);
			if (seen.has(id)) { inherited = true; return false; }
			seen.add(id);
			return true;
		});
		const usage = collectEntries({ ...source, getBranch: () => entries });
		supplementChild(usage, child, inherited);
		addChild(stats, usage);
	}
	return stats;
}
