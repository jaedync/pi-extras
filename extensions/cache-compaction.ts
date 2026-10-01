import { convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionProjection, type SessionBeforeCompactEvent, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, readSection } from "../lib/extras-config.ts";
import { buildInstruction, capturePayload, fallbackReason, fileLists, fingerprint, formatFiles, idleLimitMs, loadConfig, mergePayload, payloadHashes, reconcile, requestEffort, safeHeaders, type RequestIdentity, type RequestEffort, type Snapshot } from "../lib/cache-compaction/core.ts";

import { estimateRequestContext, contextSafetyTokens, summaryOutputFloor } from "../lib/cache-compaction/estimate.ts";

type Message = SessionProjection["messages"][number];
interface Captured extends RequestIdentity, Snapshot {
	readonly messages: Message[];
	readonly positions: readonly number[];
	readonly payload?: Record<string, unknown>;
	readonly payloadPrefix?: readonly string[];
	readonly headers?: Record<string, string>;
	readonly effort?: RequestEffort;
}
type RequestSettings = Pick<SettingsManager, "getProviderRetrySettings" | "getHttpIdleTimeoutMs" | "getWebSocketConnectTimeoutMs" | "getTransport">;
export interface CacheCompactionOptions { readonly configFile?: string; readonly now?: () => number; readonly settingsManager?: RequestSettings }

function sessionOptions(settings: RequestSettings) {
	const retry = settings.getProviderRetrySettings();
	const idle = settings.getHttpIdleTimeoutMs();
	return { timeoutMs: retry.timeoutMs ?? (idle === 0 ? 2147483647 : idle), maxRetries: retry.maxRetries, maxRetryDelayMs: retry.maxRetryDelayMs, websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(), transport: settings.getTransport() };
}

function identity(ctx: ExtensionContext, at: number): RequestIdentity | undefined {
	const model = ctx.model;
	return model ? { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow, sessionId: ctx.sessionManager.getSessionId(), at } : undefined;
}
/** Map canonical messages by complete identity, allowing injected request-local messages, never guessed text. */
function positionsFor(hashes: readonly string[], requestHashes: readonly string[]): number[] | undefined {
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
function startOf(messages: readonly Message[], span: readonly Message[], end: number, hash: (message: Message) => string): number | undefined {
	if (!span.length) return undefined;
	const hashes = span.map(hash);
	const visible = messages.slice(0, end).flatMap((message, i) => message.role === "system" ? [] : [{ hash: hash(message), index: i }]);
	const matches = visible.flatMap((message, i) => hashes.every((hash, j) => hash === visible[i + j]?.hash) ? [message.index] : []);
	return matches.length === 1 ? matches[0] : undefined;
}
function report(ctx: ExtensionContext, path: string): void {
	try {
		if (ctx.mode === "tui") ctx.ui.notify(`Compaction: ${path}`, "info");
	} catch { /* A missing or disposed UI must not stop default compaction. */ }
}

function hashOnce(): (message: Message) => string {
	const hashes = new WeakMap<Message, string>();
	return (message) => { const known = hashes.get(message); if (known) return known; const hash = fingerprint(message); hashes.set(message, hash); return hash; };
}
const excluded = (message: Message) => (message.role === "bashExecution" && message.excludeFromContext) || (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error"));
const visibleLlm = (messages: readonly Message[]) => convertToLlm(messages.filter((message) => !excluded(message)));
const unsentInput = (message: Message) => message.role === "user" || message.role === "custom" || (message.role === "bashExecution" && !message.excludeFromContext);
function prepareRequest(captured: Captured, event: SessionBeforeCompactEvent, ctx: ExtensionContext, at: number): { messages: Message[] } | { fallback: string } {
	const p = event.preparation;
	const projection = ctx.sessionManager.buildSessionProjection();
	const hash = hashOnce();
	const hashes = projection.messages.map(hash);
	const count = reconcile(captured, ctx.sessionManager.getBranch().map((entry) => entry.id), projection.messages, hashes);
	if (count === undefined) return { fallback: "branch-changed" };
	const kept = entryMessageIndex(projection, p.firstKeptEntryId);
	if (kept === undefined || !projection.messages[kept]) return { fallback: "unknown-boundary" };
	const tail = projection.messages.slice(count);
	const unsent = tail.findIndex(unsentInput);
	if (unsent >= 0 && (count + unsent < kept || tail.slice(unsent).some((message) => !unsentInput(message) && !excluded(message)))) return { fallback: "unrequested-tail" };
	const sentTail = unsent < 0 ? tail : tail.slice(0, unsent);
	if (sentTail.some((message) => message.role !== "assistant" && message.role !== "toolResult" && !excluded(message))) return { fallback: "unrequested-tail" };
	const messages = [...captured.messages, ...sentTail];
	const position = (canonical: number) => canonical < count ? captured.positions[canonical] : captured.messages.length + canonical - count;
	const split = startOf(projection.messages, p.turnPrefixMessages, kept, hash);
	const history = startOf(projection.messages, p.messagesToSummarize, split ?? kept, hash);
	if ((p.messagesToSummarize.length && history === undefined) || (p.isSplitTurn && split === undefined)) return { fallback: "unknown-boundary" };
	const visibleKept = projection.messages.findIndex((message, i) => i >= kept && !excluded(message));
	const firstVisibleKept = visibleKept < 0 ? kept : visibleKept;
	const llmMessages = visibleLlm(messages);
	if (p.previousSummary && !messages.some((message) => message.role === "compactionSummary" && message.summary === p.previousSummary)) return { fallback: "missing-previous-summary" };
	// Dropped assistant replies and !! output cannot identify a provider-visible boundary.
	const visiblePosition = (canonical: number) => visibleLlm(messages.slice(0, position(canonical))).length;
	const instruction = buildInstruction({ messages: llmMessages, boundary: visiblePosition(firstVisibleKept), entryId: p.firstKeptEntryId, historyStart: visiblePosition(history ?? split ?? kept), splitStart: p.isSplitTurn && split !== undefined ? visiblePosition(split) : undefined, previousSummary: p.previousSummary, customInstructions: event.customInstructions, keptMessage: visibleLlm([projection.messages[firstVisibleKept]])[0] ?? { role: projection.messages[kept].role, content: [] }, boundaryInRequest: visibleKept >= 0 && position(firstVisibleKept) < messages.length, boundaryExcluded: visibleKept < 0 });
	const prompt: Message = { role: "user", content: [{ type: "text", text: instruction }], timestamp: at };
	const full = [...messages, prompt];
	return { messages: full };
}

export default function cacheCompaction(pi: ExtensionAPI, options: CacheCompactionOptions = {}): void {
	const now = options.now ?? Date.now;
	const configFile = options.configFile ?? CONFIG_FILE;
	let policy = loadConfig(readSection("cacheCompaction", configFile));
	let requestOptions: ReturnType<typeof sessionOptions> | undefined;
	let pending: Captured | undefined;
	let latest: Captured | undefined;
	const clear = () => { pending = undefined; latest = undefined; };
	pi.on("session_start", (_event, ctx) => {
		clear();
		try { policy = loadConfig(readSection("cacheCompaction", configFile)); requestOptions = sessionOptions(options.settingsManager ?? SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })); }
		catch { requestOptions = undefined; }
	});
	pi.on("session_shutdown", clear);
	pi.on("session_tree", clear);
	pi.on("session_compact", clear);
	pi.on("model_select", clear);
	pi.on("thinking_level_select", clear);

	pi.on("context_with_system", (event, ctx) => {
		pending = undefined;
		try {
			if (!policy.enabled || event.messages[0]?.role !== "system") return;
			const request = identity(ctx, now());
			if (!request) return;
			const projection = ctx.sessionManager.buildSessionProjection();
			const hash = hashOnce();
			const hashes = projection.messages.map(hash);
			const positions = positionsFor(hashes, event.messages.map(hash));
			if (!positions) return;
			// Pi and later extensions may mutate these messages after this observational hook.
			pending = { ...request, ids: ctx.sessionManager.getBranch().map((entry) => entry.id), hashes, positions, messages: structuredClone(event.messages) };
		} catch { clear(); }
	});
	pi.on("before_provider_headers", (event) => {
		try { if (pending) pending = { ...pending, headers: safeHeaders(event.headers) }; }
		catch { clear(); }
	});
	pi.on("before_provider_request", (event, ctx) => {
		try {
			const hashes = latest ? payloadHashes(latest.api, event.payload) : undefined;
			if (latest?.payloadPrefix && hashes && hashes.length === latest.payloadPrefix.length && hashes.every((hash, i) => hash === latest!.payloadPrefix![i])) {
				latest = { ...latest, at: now() };
				return;
			}
			const request = pending;
			pending = undefined;
			latest = undefined;
			if (!request) return;
			const current = identity(ctx, now());
			if (!current || current.provider !== request.provider || current.id !== request.id || current.api !== request.api || current.sessionId !== request.sessionId) return;
			const payload = capturePayload(request.api, event.payload);
			const payloadPrefix = payloadHashes(request.api, event.payload);
			if (payload && payloadPrefix) latest = { ...request, at: now(), payload, payloadPrefix, effort: request.api === "anthropic-messages" ? requestEffort(event.payload) : undefined };
		} catch { clear(); }
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const captured = latest;
		// A summary changes the request prefix even if a later hook wins or default compaction runs.
		clear();
		const fallback = (reason: string) => { report(ctx, `default (${reason})`); return undefined; };
		let payloadFallback: string | undefined;
		try {
			const model = ctx.model;
			if (!model) return fallback("no-model");
			const p = event.preparation;
			const reason = fallbackReason({ enabled: policy.enabled, captured, model, sessionId: ctx.sessionManager.getSessionId(), now: now(), idleMs: idleLimitMs(policy, model), reason: event.reason, aborted: event.signal.aborted });
			if (reason || !captured?.payload) return fallback(reason ?? "no-payload");
			const request = prepareRequest(captured, event, ctx, now());
			if ("fallback" in request) return fallback(request.fallback);
			const estimated = estimateRequestContext(convertToLlm(request.messages));
			const available = model.contextWindow - estimated.tokens - contextSafetyTokens(estimated.tailTokens);
			const floor = summaryOutputFloor(p.previousSummary);
			if (available < floor) return fallback("context-window");
			if (event.signal.aborted) return fallback("aborted");
			report(ctx, "prefix-sharing");
			// ModelRuntime.complete normalizes this context with pi-ai normalizeContext, just as
			// streamSimple does in Pi's agent loop. Rebuilding any other provider fields misses cache.
			const response = await ctx.modelRegistry.complete(model, { messages: convertToLlm(request.messages) }, {
				...requestOptions, headers: captured.headers, effort: captured.effort,
				// complete() uses native stream(), not streamSimple()'s automatic context clamp.
				maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : Infinity, available),
				sessionId: captured.sessionId, signal: event.signal,
				onPayload: (generated: unknown) => {
					try { return mergePayload(model.api, captured.payload!, generated, captured.payloadPrefix, floor); }
					catch (error) { if (error instanceof Error && error.message === "thinking-budget") payloadFallback = "thinking-budget"; throw error; }
				},
			});
			const summary = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
			if (event.signal.aborted || response.stopReason === "aborted") return fallback("aborted");
			if (response.stopReason === "error" || response.stopReason === "length") return fallback(payloadFallback ?? "response-failed");
			if (!summary || response.content.some((block) => block.type === "toolCall")) return fallback("unusable-summary");
			const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
			const files = fileLists(p.fileOps, previous?.type === "compaction" ? previous.details : undefined);
			return { compaction: { summary: summary + formatFiles(files), firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore, usage: response.usage, details: { ...files, cachePrefix: true } } };
		} catch (error) {
			// Only known local sentinel errors are safe to expose, never provider error text.
			const reason = error instanceof Error && error.message === "ambiguous-boundary" ? error.message : payloadFallback ?? "request-failed";
			return fallback(event.signal.aborted ? "aborted" : reason);
		}
	});
}
