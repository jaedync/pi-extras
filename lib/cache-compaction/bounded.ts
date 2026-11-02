import { compact, convertToLlm, estimateTokens, serializeConversation, type CompactionResult, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { routedModel } from "../routed-model.ts";
import { BASE_CONTEXT_MARGIN_TOKENS, summaryOutputFloor } from "./estimate.ts";

type Message = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];
type Model = NonNullable<ExtensionContext["model"]>;
interface Usage { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number }

/** Below this, tool schemas and the system prompt dominate the count and inflate the ratio. */
export const MIN_CALIBRATION_TOKENS = 16_384;
export const MAX_TOKEN_RATIO = 2;
/** Room for a summary that Pi's own update prompt can produce, with reasoning. */
export const BOUNDED_OUTPUT_TOKENS = 16_384;
/** Pi's summary system prompt, instructions and conversation tags, rounded up. */
export const SUMMARY_PROMPT_CHARS = 6_000;
/** pi-ai clamps max_tokens with chars/3.5 and this margin; a request fits only if its real count does too. */
const PI_AI_CHARS_PER_TOKEN = 3.5;

// Some engines report the prompt as cache fields with input 0.
// Templates that drop earlier reasoning do not count it; leaving it out can only raise the ratio.
const withoutThinking = (m: Message): Message => m.role === "assistant" ? { ...m, content: m.content.filter((block) => block.type !== "thinking") } : m;
const promptTokens = (usage: Usage | undefined) => usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;

/**
 * Provider tokens per Pi estimated token, from the newest reply whose usage counts the messages before it.
 * Pi estimates chars/4; a tokenizer that counts more makes every char-based budget too small.
 */
export function tokenRatio(messages: readonly Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		const prompt = promptTokens(message.usage);
		if (!prompt) continue;
		const before = messages.slice(0, i);
		const system = before.findLast((m) => m.role === "system");
		const estimate = before.reduce((sum, m) => m.role === "system" ? sum : sum + estimateTokens(withoutThinking(m)), system ? estimateTokens(system) : 0);
		if (estimate < MIN_CALIBRATION_TOKENS) return 1;
		return Math.min(MAX_TOKEN_RATIO, Math.max(1, prompt / estimate));
	}
	return 1;
}

/** The characters Pi's summary prompt sends for these messages, with tool results truncated as Pi does. */
export const summaryChars = (messages: readonly Message[], previousSummary = "") => (messages.length ? serializeConversation(convertToLlm([...messages])).length : 0) + previousSummary.length + SUMMARY_PROMPT_CHARS;
const realTokens = (chars: number, ratio: number) => Math.ceil(chars / 4 * ratio);

/** Whether Pi's default summary request, with pi-ai's max_tokens clamp, stays inside the window. */
export function defaultFits(chars: number, model: Pick<Model, "contextWindow" | "maxTokens">, ratio: number, previousSummary?: string): boolean {
	const window = model.contextWindow;
	const clamp = Math.max(1, window - Math.ceil(chars / PI_AI_CHARS_PER_TOKEN) - BASE_CONTEXT_MARGIN_TOKENS);
	const limit = model.maxTokens > 0 ? model.maxTokens : Infinity;
	// A clamp below the summary floor truncates the summary; a small model limit is the owner's choice.
	return clamp >= Math.min(limit, summaryOutputFloor(previousSummary)) && realTokens(chars, ratio) + Math.min(limit, clamp) <= window;
}

/** Consecutive runs of messages whose serialized size stays under the budget; undefined if one message alone exceeds it. */
export function chunk(messages: readonly Message[], budgetChars: number): Message[][] | undefined {
	const chunks: Message[][] = [];
	let current: Message[] = [];
	let size = 0;
	for (const message of messages) {
		const chars = serializeConversation(convertToLlm([message])).length + 2;
		if (chars > budgetChars) return undefined;
		if (current.length && size + chars > budgetChars) { chunks.push(current); current = []; size = 0; }
		current.push(message);
		size += chars;
	}
	if (current.length) chunks.push(current);
	return chunks;
}

type ContextLike = { systemPrompt?: string; messages: readonly { content: unknown }[] };
const contentChars = (content: unknown): number => typeof content === "string" ? content.length : Array.isArray(content) ? content.reduce((sum: number, block: { type?: string; text?: string; thinking?: string }) => sum + (block.text?.length ?? block.thinking?.length ?? 0), 0) : 0;
const contextChars = (context: ContextLike) => (context.systemPrompt?.length ?? 0) + context.messages.reduce((sum, message) => sum + contentChars(message.content), 0);

/**
 * Pi's default summary, split so that every request fits the window by the calibrated count.
 * Undefined when the default already fits, or when no split can fit; Pi then runs its default path.
 */
export async function boundedCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<CompactionResult | undefined> {
	const model = routedModel(ctx);
	const registry = ctx.modelRegistry;
	if (!model || model.contextWindow <= 0 || typeof registry.streamSimple !== "function" || event.signal.aborted) return undefined;
	const p = event.preparation;
	const ratio = tokenRatio(ctx.sessionManager.buildSessionProjection().messages);
	const extra = event.customInstructions ?? "";
	const historyChars = summaryChars(p.messagesToSummarize, (p.previousSummary ?? "") + extra);
	const prefixChars = summaryChars(p.turnPrefixMessages, extra);
	const prefixFits = !p.isSplitTurn || defaultFits(prefixChars, model, ratio);
	if (defaultFits(historyChars, model, ratio, p.previousSummary) && prefixFits) return undefined;

	const outputCap = Math.min(model.maxTokens > 0 ? model.maxTokens : Infinity, Math.max(summaryOutputFloor(p.previousSummary), BOUNDED_OUTPUT_TOKENS));
	const inputBudget = model.contextWindow - outputCap - BASE_CONTEXT_MARGIN_TOKENS;
	// Each later request carries the running summary, which the output cap bounds.
	const carried = Math.max(realTokens((p.previousSummary ?? "").length, ratio), outputCap);
	const budgetChars = Math.floor((inputBudget - carried) * 4 / ratio) - SUMMARY_PROMPT_CHARS - extra.length;
	const keepSplit = p.isSplitTurn && prefixFits;
	const history = keepSplit ? p.messagesToSummarize : [...p.messagesToSummarize, ...p.turnPrefixMessages];
	const chunks = budgetChars > 0 ? chunk(history, budgetChars) : undefined;
	if (!chunks?.length) return undefined;

	// Pi sends no max_tokens, and pi-ai's clamp trusts its own lower estimate; cap by the calibrated count instead.
	const streamFn: NonNullable<Parameters<typeof compact>[7]> = (m, context, options) => registry.streamSimple(m, context, { ...options, maxTokens: Math.min(outputCap, model.contextWindow - realTokens(contextChars(context), ratio) - BASE_CONTEXT_MARGIN_TOKENS) });
	const noFiles = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
	let summary = p.previousSummary;
	let usage: CompactionResult["usage"];
	let result: CompactionResult | undefined;
	for (const [index, part] of chunks.entries()) {
		const final = index === chunks.length - 1;
		result = await compact({ ...p, messagesToSummarize: part, previousSummary: summary, turnPrefixMessages: final && keepSplit ? p.turnPrefixMessages : [], isSplitTurn: final && keepSplit, fileOps: final ? p.fileOps : noFiles }, model, undefined, undefined, event.customInstructions, event.signal, undefined, streamFn);
		summary = result.summary;
		usage = addUsage(usage, result.usage);
	}
	return result && { ...result, tokensBefore: p.tokensBefore, usage, details: { ...(result.details as object), bounded: true, requests: chunks.length } };
}

function addUsage(a: CompactionResult["usage"], b: CompactionResult["usage"]): CompactionResult["usage"] {
	if (!a || !b) return a ?? b;
	return { ...b, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens, cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output, cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total } };
}
