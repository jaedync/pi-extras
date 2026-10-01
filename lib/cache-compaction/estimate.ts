import { calculateContextTokens, estimateTokens, getLastAssistantUsage, type convertToLlm } from "@earendil-works/pi-coding-agent";

/** Reuse Pi's usage-anchored compaction estimate rather than maintaining a second tokenizer. */
export function estimateRequestTokens(messages: ReturnType<typeof convertToLlm>): number {
	const entries = messages.flatMap((message) => message.role === "assistant" ? [{ type: "message" as const, id: "", parentId: null, timestamp: "", message }] : []);
	const usage = getLastAssistantUsage(entries);
	const index = usage ? messages.findLastIndex((message) => message.role === "assistant" && message.usage === usage) : -1;
	return (usage ? calculateContextTokens(usage) : 0) + messages.slice(index + 1).reduce((sum, message) => sum + estimateTokens(message), 0);
}
export const SUMMARY_GROWTH_TOKENS = 6000;
export const SUMMARY_REASONING_TOKENS = 2000;
/** 183 real summaries: max first summary 5.7k, max update growth 5.2k. Keep 2k for reasoning. */
export function summaryOutputFloor(previousSummary?: string): number {
	return (previousSummary ? estimateTokens({ role: "user", content: previousSummary, timestamp: 0 }) : 0) + SUMMARY_GROWTH_TOKENS + SUMMARY_REASONING_TOKENS;
}
