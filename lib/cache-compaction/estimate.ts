import { calculateContextTokens, estimateTokens, getLastAssistantUsage, type convertToLlm } from "@earendil-works/pi-coding-agent";

/** Reuse Pi's usage-anchored compaction estimate rather than maintaining a second tokenizer. */
export function estimateRequestContext(messages: ReturnType<typeof convertToLlm>): { tokens: number; tailTokens: number } {
	const entries = messages.flatMap((message) => message.role === "assistant" ? [{ type: "message" as const, id: "", parentId: null, timestamp: "", message }] : []);
	const usage = getLastAssistantUsage(entries);
	const index = usage ? messages.findLastIndex((message) => message.role === "assistant" && message.usage === usage) : -1;
	const tailTokens = messages.slice(index + 1).reduce((sum, message) => sum + estimateTokens(message), 0);
	return { tokens: (usage ? calculateContextTokens(usage) : 0) + tailTokens, tailTokens };
}
export const estimateRequestTokens = (messages: ReturnType<typeof convertToLlm>) => estimateRequestContext(messages).tokens;
export const BASE_CONTEXT_MARGIN_TOKENS = 4096;
export const TAIL_TOKEN_SKEW_RATIO = 0.6;
/** Numeric logs tokenize densely; the usage anchor is exact, but its new tail is only chars/4. */
export const contextSafetyTokens = (tailTokens: number) => BASE_CONTEXT_MARGIN_TOKENS + Math.ceil(TAIL_TOKEN_SKEW_RATIO * tailTokens);
export const SUMMARY_GROWTH_TOKENS = 6000;
export const SUMMARY_REASONING_TOKENS = 2000;
/** 183 real summaries: max first summary 5.7k, max update growth 5.2k. Keep 2k for reasoning. */
export function summaryOutputFloor(previousSummary?: string): number {
	return (previousSummary ? estimateTokens({ role: "user", content: previousSummary, timestamp: 0 }) : 0) + SUMMARY_GROWTH_TOKENS + SUMMARY_REASONING_TOKENS;
}
