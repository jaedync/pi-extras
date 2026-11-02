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
const promptTokens = (usage: Usage | undefined) => usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
// Chat templates can drop earlier reasoning from the prompt; other APIs send it, so it stays in their estimate.
const withoutThinking = (m: Message): Message => m.role === "assistant" ? { ...m, content: m.content.filter((block) => block.type !== "thinking") } : m;

/** Which replies can calibrate: those after the latest compaction (kept replies carry older usage), from the model that compacts. */
export interface RatioScope { readonly from: number; readonly provider: string; readonly id: string; readonly api: string }

/**
 * Provider tokens per Pi estimated token, from the newest qualifying reply whose usage counts the messages before it.
 * Pi estimates chars/4; a tokenizer that counts more makes every char-based budget too small.
 */
export function tokenRatio(messages: readonly Message[], scope: RatioScope): number {
	for (let i = messages.length - 1; i >= scope.from; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || message.provider !== scope.provider || message.model !== scope.id) continue;
		const prompt = promptTokens(message.usage);
		if (!prompt) continue;
		// Every system message counts: a later one is a patch with only its changed sections and added tools.
		const strip = scope.api === "openai-completions" ? withoutThinking : (m: Message) => m;
		const estimate = messages.slice(0, i).reduce((sum, m) => sum + estimateTokens(strip(m)), 0);
		if (estimate < MIN_CALIBRATION_TOKENS) return 1;
		return Math.min(MAX_TOKEN_RATIO, Math.max(1, prompt / estimate));
	}
	return 1;
}

type Projection = ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>;
/** The index of the first projected message from an entry after the latest compaction on the branch. */
export function firstAfterCompaction(projection: Pick<Projection, "entries">, branch: readonly { readonly id: string; readonly type: string }[]): number {
	const latest = branch.findLastIndex((entry) => entry.type === "compaction");
	if (latest < 0) return 0;
	const after = new Set(branch.slice(latest + 1).map((entry) => entry.id));
	let index = 0;
	for (const entry of projection.entries) {
		if (after.has(entry.sourceEntry.id)) return index;
		index += entry.messages.length;
	}
	return index;
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

/** A part may end after this message: the next one does not need it as its tool call. */
const closes = (message: Message) => message.role !== "assistant" || !message.content.some((block) => block.type === "toolCall");
/** Within this share of the budget, a part ends at the last message that closes a step. */
const BOUNDARY_SLACK = 0.25;

/** Consecutive runs of messages whose serialized size stays under the budget; undefined if one message alone exceeds it. */
export function chunk(messages: readonly Message[], budgetChars: number): Message[][] | undefined {
	const sizes = messages.map((message) => serializeConversation(convertToLlm([message])).length + 2);
	if (sizes.some((size) => size > budgetChars)) return undefined;
	const chunks: Message[][] = [];
	let start = 0;
	while (start < messages.length) {
		let end = start;
		let size = 0;
		while (end < messages.length && size + sizes[end] <= budgetChars) size += sizes[end++];
		if (end < messages.length) {
			// A summary of one part should not see a tool call whose result is in the next part.
			let cut = end;
			let dropped = 0;
			while (cut - 1 > start && !closes(messages[cut - 1]) && dropped + sizes[cut - 1] <= budgetChars * BOUNDARY_SLACK) dropped += sizes[--cut];
			if (closes(messages[cut - 1])) end = cut;
		}
		chunks.push(messages.slice(start, end));
		start = end;
	}
	return chunks;
}

type ContextLike = { systemPrompt?: string; messages: readonly { content: unknown }[] };
const contentChars = (content: unknown): number => typeof content === "string" ? content.length : Array.isArray(content) ? content.reduce((sum: number, block: { type?: string; text?: string; thinking?: string }) => sum + (block.text?.length ?? block.thinking?.length ?? 0), 0) : 0;
const contextChars = (context: ContextLike) => (context.systemPrompt?.length ?? 0) + context.messages.reduce((sum, message) => sum + contentChars(message.content), 0);

/**
 * Pi's default summary, split so that every request fits the window by the calibrated count.
 * Undefined when the default already fits, or when no split can fit; Pi then runs its default path.
 */
export interface BoundedOptions { readonly thinkingLevel?: Parameters<typeof compact>[6]; readonly retry?: Parameters<typeof compact>[9] }
export type BoundedResult = { readonly compaction: CompactionResult } | { readonly failure: string } | undefined;
/** Runs only for overflow recovery, the case where Pi's default path stalled; never rejects. */
export async function boundedCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext, options: () => BoundedOptions = () => ({})): Promise<BoundedResult> {
	try {
		const compaction = event.reason === "overflow" ? await split(event, ctx, options) : undefined;
		return compaction && { compaction };
	} catch (error) {
		// Fixed reasons only: the decision log never holds provider error text.
		return { failure: event.signal.aborted ? "aborted" : error instanceof Error && /token cap/.test(error.message) ? "bounded-failed:length" : "bounded-failed:request" };
	}
}

// Options are read only here, inside the guard, so a host without them still gets the default path.
async function split(event: SessionBeforeCompactEvent, ctx: ExtensionContext, options: () => BoundedOptions): Promise<CompactionResult | undefined> {
	const model = routedModel(ctx);
	const registry = ctx.modelRegistry;
	if (!model || model.contextWindow <= 0 || typeof registry.streamSimple !== "function" || event.signal.aborted) return undefined;
	const p = event.preparation;
	const projection = ctx.sessionManager.buildSessionProjection();
	const ratio = tokenRatio(projection.messages, { from: firstAfterCompaction(projection, ctx.sessionManager.getBranch()), provider: model.provider, id: model.id, api: model.api });
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
	const { thinkingLevel, retry } = options();
	const noFiles = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
	let summary = p.previousSummary;
	let usage: CompactionResult["usage"];
	let result: CompactionResult | undefined;
	for (const [index, part] of chunks.entries()) {
		event.signal.throwIfAborted();
		const final = index === chunks.length - 1;
		result = await compact({ ...p, messagesToSummarize: part, previousSummary: summary, turnPrefixMessages: final && keepSplit ? p.turnPrefixMessages : [], isSplitTurn: final && keepSplit, fileOps: final ? p.fileOps : noFiles }, model, undefined, undefined, event.customInstructions, event.signal, thinkingLevel, streamFn, undefined, retry);
		summary = result.summary;
		usage = addUsage(usage, result.usage);
	}
	event.signal.throwIfAborted();
	return result && { ...result, tokensBefore: p.tokensBefore, usage, details: { ...(result.details as object), bounded: true, requests: chunks.length } };
}

function addUsage(a: CompactionResult["usage"], b: CompactionResult["usage"]): CompactionResult["usage"] {
	if (!a || !b) return a ?? b;
	return { ...b, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens, cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output, cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total } };
}
