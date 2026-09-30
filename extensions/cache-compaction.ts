import { convertToLlm, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionProjection, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, readSection } from "../lib/extras-config.ts";
import { buildInstruction, capturePayload, fallbackReason, fileLists, fingerprint, formatFiles, idleLimitMs, loadConfig, mergePayload, payloadHashes, reconcile, type RequestIdentity, type Snapshot } from "../lib/cache-compaction/core.ts";

type Message = SessionProjection["messages"][number];
interface Captured extends RequestIdentity, Snapshot {
	readonly messages: Message[];
	readonly positions: readonly number[];
	readonly payload?: Record<string, unknown>;
	readonly payloadPrefix?: readonly string[];
}
export interface CacheCompactionOptions { readonly configFile?: string; readonly now?: () => number }

function identity(ctx: ExtensionContext, at: number): RequestIdentity | undefined {
	const model = ctx.model;
	return model ? { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow, sessionId: ctx.sessionManager.getSessionId(), at } : undefined;
}
/** Map canonical messages by complete identity, allowing injected request-local messages, never guessed text. */
function positionsFor(hashes: readonly string[], messages: readonly Message[]): number[] | undefined {
	const requestHashes = messages.map(fingerprint);
	const positions: number[] = [];
	let from = 0;
	for (const hash of hashes) {
		const position = requestHashes.indexOf(hash, from);
		if (position < 0) return undefined;
		positions.push(position);
		from = position + 1;
	}
	return positions;
}
function entryMessageIndex(projection: SessionProjection, id: string): number | undefined {
	const index = projection.entries.findIndex((entry) => entry.sourceEntry.id === id);
	if (index < 0) return undefined;
	return projection.entries.slice(0, index).reduce((sum, entry) => sum + entry.messages.length, 0);
}
function startOf(messages: readonly Message[], span: readonly Message[], end: number): number | undefined {
	if (!span.length) return undefined;
	const hashes = span.map(fingerprint);
	const visible = messages.slice(0, end).flatMap((message, i) => message.role === "system" ? [] : [{ hash: fingerprint(message), index: i }]);
	const matches = visible.flatMap((message, i) => hashes.every((hash, j) => hash === visible[i + j]?.hash) ? [message.index] : []);
	return matches.length === 1 ? matches[0] : undefined;
}
function report(ctx: ExtensionContext, path: string): void {
	try {
		if (ctx.mode === "tui") ctx.ui.notify(`Compaction: ${path}`, "info");
	} catch { /* A missing or disposed UI must not stop default compaction. */ }
}

function prepareRequest(captured: Captured, event: SessionBeforeCompactEvent, ctx: ExtensionContext, at: number): { messages: Message[]; estimated: number } | { fallback: string } {
	const p = event.preparation;
	const projection = ctx.sessionManager.buildSessionProjection();
	const count = reconcile(captured, ctx.sessionManager.getBranch().map((entry) => entry.id), projection.messages);
	if (count === undefined) return { fallback: "branch-changed" };
	const tail = projection.messages.slice(count);
	// Only finalized replies/results can follow the last request without a fresh capture.
	if (tail.some((message) => message.role !== "assistant" && message.role !== "toolResult")) return { fallback: "unrequested-tail" };
	const messages = [...captured.messages, ...tail];
	const position = (canonical: number) => canonical < count ? captured.positions[canonical] : captured.messages.length + canonical - count;
	const kept = entryMessageIndex(projection, p.firstKeptEntryId);
	const split = kept === undefined ? undefined : startOf(projection.messages, p.turnPrefixMessages, kept);
	const history = kept === undefined ? undefined : startOf(projection.messages, p.messagesToSummarize, split ?? kept);
	if (kept === undefined || !messages[position(kept)] || (p.messagesToSummarize.length && history === undefined) || (p.isSplitTurn && split === undefined)) return { fallback: "unknown-boundary" };
	const llmMessages = convertToLlm(messages);
	if (llmMessages.length !== messages.length) return { fallback: "invisible-messages" };
	const instruction = buildInstruction({ messages: llmMessages, boundary: position(kept), entryId: p.firstKeptEntryId, historyStart: history === undefined ? position(split ?? kept) : position(history), splitStart: p.isSplitTurn && split !== undefined ? position(split) : undefined, previousSummary: p.previousSummary, customInstructions: event.customInstructions });
	const prompt: Message = { role: "user", content: [{ type: "text", text: instruction }], timestamp: at };
	const full = [...messages, prompt];
	// Include full tool outputs, system/tools, injected messages and the uncached instruction.
	return { messages: full, estimated: full.reduce((sum, message) => sum + estimateTokens(message), 0) };
}

export default function cacheCompaction(pi: ExtensionAPI, options: CacheCompactionOptions = {}): void {
	const now = options.now ?? Date.now;
	const configFile = options.configFile ?? CONFIG_FILE;
	const config = () => loadConfig(readSection("cacheCompaction", configFile));
	let pending: Captured | undefined;
	let latest: Captured | undefined;
	const clear = () => { pending = undefined; latest = undefined; };
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	pi.on("session_tree", clear);
	pi.on("session_compact", clear);
	pi.on("model_select", clear);
	pi.on("thinking_level_select", clear);

	pi.on("context_with_system", (event, ctx) => {
		clear();
		try {
			if (!config().enabled || event.messages[0]?.role !== "system") return;
			const request = identity(ctx, now());
			if (!request) return;
			const projection = ctx.sessionManager.buildSessionProjection();
			const hashes = projection.messages.map(fingerprint);
			const positions = positionsFor(hashes, event.messages);
			if (!positions) return;
			// Pi and later extensions may mutate these messages after this observational hook.
			pending = { ...request, ids: ctx.sessionManager.getBranch().map((entry) => entry.id), hashes, positions, messages: structuredClone(event.messages) };
		} catch { clear(); }
	});
	pi.on("before_provider_request", (event, ctx) => {
		const request = pending;
		pending = undefined;
		if (!request) return;
		try {
			const current = identity(ctx, now());
			if (!current || current.provider !== request.provider || current.id !== request.id || current.api !== request.api || current.sessionId !== request.sessionId) return;
			const payload = capturePayload(request.api, event.payload);
			const payloadPrefix = payloadHashes(request.api, event.payload);
			if (payload && payloadPrefix) latest = { ...request, at: now(), payload, payloadPrefix };
		} catch { clear(); }
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const captured = latest;
		// A summary changes the request prefix even if a later hook wins or default compaction runs.
		clear();
		const fallback = (reason: string) => { report(ctx, `default (${reason})`); return undefined; };
		try {
			const model = ctx.model;
			if (!model) return fallback("no-model");
			const policy = config();
			const p = event.preparation;
			const reason = fallbackReason({ enabled: policy.enabled, captured, model, sessionId: ctx.sessionManager.getSessionId(), now: now(), idleMs: idleLimitMs(policy, model), reason: event.reason, aborted: event.signal.aborted, tokensBefore: p.tokensBefore, reserveTokens: p.settings.reserveTokens });
			if (reason || !captured?.payload) return fallback(reason ?? "no-payload");
			const request = prepareRequest(captured, event, ctx, now());
			if ("fallback" in request) return fallback(request.fallback);
			if (Math.max(request.estimated, p.tokensBefore) + p.settings.reserveTokens > model.contextWindow) return fallback("context-window");
			if (event.signal.aborted) return fallback("aborted");
			report(ctx, "prefix-sharing");
			// ModelRuntime.complete normalizes this context with pi-ai normalizeContext, just as
			// streamSimple does in Pi's agent loop. Rebuilding any other provider fields misses cache.
			const response = await ctx.modelRegistry.complete(model, { messages: convertToLlm(request.messages) }, {
				sessionId: captured.sessionId, signal: event.signal,
				onPayload: (generated: unknown) => mergePayload(model.api, captured.payload!, generated, captured.payloadPrefix),
			});
			const summary = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
			if (event.signal.aborted || response.stopReason === "aborted") return fallback("aborted");
			if (response.stopReason === "error" || response.stopReason === "length") return fallback("response-failed");
			if (!summary || response.content.some((block) => block.type === "toolCall")) return fallback("unusable-summary");
			const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
			const files = fileLists(p.fileOps, previous?.type === "compaction" ? previous.details : undefined);
			return { compaction: { summary: summary + formatFiles(files), firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore, usage: response.usage, details: { ...files, cachePrefix: true } } };
		} catch {
			// Provider errors can contain request text or credentials. Never echo them.
			return fallback(event.signal.aborted ? "aborted" : "request-failed");
		}
	});
}
