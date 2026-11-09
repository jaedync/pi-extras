/**
 * Spend in one Pi session line: an assistant turn's recorded cost, or the
 * spend Pi records outside turns (compaction and branch summaries, cache
 * refreshes), and the model switches that say whose that spend is.
 */
import { cacheWarmUsage } from "../cache-warm-entry.ts";

export interface SpendRecord {
	ts: number;
	provider: string;
	model: string;
	cost: number;
	id: string;
}

// Pi writes the role near the start of each line; tool results, the bulk of the bytes, are never parsed.
export const HEAD_CHARS = 600;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function familyMatches(model: string, family: string): boolean {
	return model.toLowerCase().split(/[^a-z0-9]+/).includes(family.toLowerCase());
}

/** The session's model, which Pi summarizes and compacts with: the latest model_change line or reply sets it. */
export interface SessionModel {
	provider: string;
	model: string;
}

export const UNKNOWN_MODEL: SessionModel = { provider: "unknown", model: "unknown" };
/** Lines with spend outside replies, and the model switches that say whose it is. */
const OFF_TURN_TYPES = new Set(["compaction", "branch_summary", "usage", "model_change"]);
const OFF_TURN_HEAD = /"type":"(compaction|branch_summary|usage|model_change)"|"customType":"pi-extras\.cache-warm"/;

/** One line's spend, or the model it switches the session to. */
export interface LedgerLine {
	record?: SpendRecord;
	model?: SessionModel;
}

function recordedCost(usage: { cost?: unknown } | undefined): number | undefined {
	const raw = typeof usage?.cost === "object" && usage.cost ? (usage.cost as { total?: unknown }).total : usage?.cost;
	return finite(raw) && raw >= 0 ? raw : undefined;
}

function replySpend(entry: { timestamp?: unknown; message?: Record<string, unknown> }): SpendRecord | undefined {
	const message = entry.message;
	if (!message || message.role !== "assistant") return undefined;
	const usage = message.usage as { cost?: unknown; totalTokens?: unknown } | undefined;
	const cost = recordedCost(usage);
	const ts = finite(message.timestamp) ? message.timestamp : Date.parse(String(entry.timestamp));
	if (cost === undefined || !finite(ts)) return undefined;
	const provider = typeof message.provider === "string" ? message.provider : "unknown";
	const model = typeof message.model === "string" ? message.model : "unknown";
	const id = typeof message.responseId === "string" && message.responseId
		? `${provider}:${message.responseId}`
		: `${ts}|${provider}|${model}|${String(usage?.totalTokens)}`;
	return { ts, provider, model, cost, id };
}

/**
 * Spend Pi records outside replies: compaction and branch summaries (made with
 * the session's model) and usage entries such as cache refreshes (which name
 * their own). A fork copies an entry with its id, so the id makes it count one time.
 */
function offTurnSpend(entry: Record<string, unknown>, active: SessionModel): LedgerLine | undefined {
	if (entry.type === "model_change") {
		return typeof entry.provider === "string" ? { model: { provider: entry.provider, model: String(entry.modelId ?? "unknown") } } : undefined;
	}
	const cost = recordedCost(entry.usage as { cost?: unknown } | undefined);
	const ts = Date.parse(String(entry.timestamp));
	if (cost === undefined || !finite(ts)) return undefined;
	const own = entry.type === "usage" && typeof entry.provider === "string";
	const provider = own ? entry.provider as string : active.provider;
	const model = own ? String(entry.model ?? "unknown") : active.model;
	const id = typeof entry.id === "string" && entry.id ? `${entry.type}:${entry.id}` : `${ts}|${String(entry.type)}|${provider}|${model}`;
	return { record: { ts, provider, model, cost, id } };
}

export function parseSpendLine(text: string, active: SessionModel = UNKNOWN_MODEL): LedgerLine | undefined {
	const head = text.slice(0, HEAD_CHARS);
	const offTurn = OFF_TURN_HEAD.test(head);
	if (!offTurn && !head.includes('"role":"assistant"')) return undefined;
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (offTurn && OFF_TURN_TYPES.has(String(entry.type))) return offTurnSpend(entry, active);
	// The pi-extras cache warmer records its usage in a custom entry; it names its own model.
	const warm = offTurn ? cacheWarmUsage(entry) : undefined;
	if (warm) return offTurnSpend(warm as unknown as Record<string, unknown>, active);
	const record = replySpend(entry as { timestamp?: unknown; message?: Record<string, unknown> });
	// A reply names the model it came from: under a virtual selection, the one a summary is likely routed to.
	return record ? { record, model: { provider: record.provider, model: record.model } } : undefined;
}

