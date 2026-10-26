import { calculateContextTokens, convertToLlm, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionProjection, type SessionBeforeCompactEvent, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, readSection } from "../lib/extras-config.ts";
import { buildInstruction, capturePayload, fallbackReason, fileLists, fingerprint, formatFiles, idleLimitMs, isLocalCompletions, loadConfig, mergePayload, payloadHashes, reconcile, requestEffort, safeHeaders, type RequestIdentity, type RequestEffort, type Snapshot } from "../lib/cache-compaction/core.ts";
import { backgroundDue, backgroundHeaders, backgroundInstruction, fileOpsOf, tailFits, type FileOps } from "../lib/cache-compaction/background.ts";

import { dirname, join } from "node:path";
import { operationalLine } from "../lib/operational-log.ts";
import { routedModel } from "../lib/routed-model.ts";
import { COMPACTION_DECISION_EVENT, COMPACTION_PROGRESS_EVENT, PROGRESS_TAIL_CHARS, compactionKey, type CompactionDecision } from "../lib/cache-compaction/decision.ts";
import { foldProjection } from "../lib/cache-compaction/system-fold.ts";
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
type RequestSettings = Pick<SettingsManager, "getProviderRetrySettings" | "getHttpIdleTimeoutMs" | "getWebSocketConnectTimeoutMs" | "getTransport" | "getCompactionSettings">;
export interface CacheCompactionOptions { readonly configFile?: string; readonly now?: () => number; readonly settingsManager?: RequestSettings }

function sessionOptions(settings: RequestSettings) {
	const retry = settings.getProviderRetrySettings();
	const idle = settings.getHttpIdleTimeoutMs();
	return { timeoutMs: retry.timeoutMs ?? (idle === 0 ? 2147483647 : idle), maxRetries: retry.maxRetries, maxRetryDelayMs: retry.maxRetryDelayMs, websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(), transport: settings.getTransport() };
}

/** The model a request goes to: under a virtual selection, the one it routed to, whose prefix cache the summary shares. */
function identity(ctx: ExtensionContext, at: number): RequestIdentity | undefined {
	const model = routedModel(ctx);
	return model ? { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow, sessionId: ctx.sessionManager.getSessionId(), at } : undefined;
}
/** Only custom notices may be omitted; missing conversation messages could be rewritten retained content. */
function positionsFor(messages: readonly Message[], hashes: readonly string[], requestHashes: readonly string[]): number[] | undefined {
	const positions = new Array<number>(hashes.length);
	let next = requestHashes.length;
	let matched = 0;
	for (let i = hashes.length - 1; i >= 0; i--) {
		const position = next > 0 ? requestHashes.lastIndexOf(hashes[i], next - 1) : -1;
		if (position < 0 && (messages[i].role !== "custom" || requestHashes.includes(hashes[i]))) return undefined;
		if (position >= 0) { next = position; matched++; }
		positions[i] = next;
	}
	return matched || !hashes.length ? positions : undefined;
}
function entryMessageIndex(projection: SessionProjection, id: string): number | undefined {
	const index = projection.entries.findIndex((entry) => entry.sourceEntry.id === id);
	if (index < 0) return undefined;
	return projection.entries.slice(0, index).reduce((sum, entry) => sum + entry.messages.length, 0);
}
function startOf(messages: readonly Message[], span: readonly Message[], end: number, hash: (message: Message) => string, omitted: ReadonlySet<string>): number | undefined {
	const hashes = span.map(hash).filter((value) => !omitted.has(value));
	if (!hashes.length) return undefined;
	const visible = messages.slice(0, end).flatMap((message, i) => message.role === "system" || omitted.has(hash(message)) ? [] : [{ hash: hash(message), index: i }]);
	const matches = visible.flatMap((message, i) => hashes.every((hash, j) => hash === visible[i + j]?.hash) ? [message.index] : []);
	return matches.length === 1 ? matches[0] : undefined;
}
function report(ctx: ExtensionContext, path: string): void {
	try {
		if (ctx.mode === "tui") ctx.ui.notify(`Compaction: ${path}`, "info");
	} catch { /* A missing or disposed UI must not stop default compaction. */ }
}

type Registry = ExtensionContext["modelRegistry"];
/**
 * `complete()` is `stream().result()`, so streaming sends the same request and
 * hits the same cache; the text deltas feed the live band as they come.
 */
type Complete = Parameters<Registry["complete"]>;
async function streamed(registry: Registry, model: Complete[0], context: Complete[1], options: Complete[2], onText: (text: string) => void) {
	if (typeof registry.stream !== "function") return registry.complete(model, context, options);
	const stream = registry.stream(model, context, options);
	let text = "";
	for await (const event of stream) {
		if (event.type !== "text_delta") continue;
		text += event.delta;
		onText(text);
	}
	return stream.result();
}

type Model = NonNullable<ExtensionContext["model"]>;
type Response = Awaited<ReturnType<typeof streamed>>;
/** A summary written ahead of Pi's trigger: either its text and usage, or why it is unusable. */
type HeldResult = { readonly summary: string; readonly usage: Response["usage"]; readonly stopReason: string } | { readonly failure: string };
interface Held { readonly captured: Captured; readonly controller: AbortController; readonly result: Promise<HeldResult>; readonly ops: FileOps }

/** The summary text, or why a response cannot become a checkpoint. */
function summarize(response: Response, aborted: boolean, payloadFallback: string | undefined): { readonly summary: string } | { readonly failure: string } {
	const summary = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
	if (aborted || response.stopReason === "aborted") return { failure: "aborted" };
	if (response.stopReason === "error" || response.stopReason === "length") return { failure: payloadFallback ?? (response.stopReason === "length" ? "length" : "response-failed") };
	if (!summary || response.content.some((block) => block.type === "toolCall")) return { failure: "unusable-summary" };
	return { summary };
}
/** Entries Pi can keep first: never a tool result, which needs the call before it. */
const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const cutPoint = (entry: SessionEntry) => entry.type === "message" ? CUT_ROLES.has(entry.message.role) : entry.type === "custom_message" || entry.type === "branch_summary";
function settle<T>(promise: Promise<T>, signal: AbortSignal, aborted: T): Promise<T> {
	if (signal.aborted) return Promise.resolve(aborted);
	return new Promise((resolve) => {
		const onAbort = () => resolve(aborted);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); });
	});
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
	const present = (canonical: number) => canonical >= count || (captured.positions[canonical] < captured.messages.length && hashes[canonical] === hash(captured.messages[captured.positions[canonical]]));
	// The same local-only custom entries may also be pruned from preparation spans.
	// Filter only proven request omissions, keeping original indices for the retained suffix.
	const omitted = new Set(projection.messages.flatMap((message, i) => message.role === "custom" && !present(i) ? [hashes[i]] : []));
	const split = startOf(projection.messages, p.turnPrefixMessages, kept, hash, omitted);
	const history = startOf(projection.messages, p.messagesToSummarize, split ?? kept, hash, omitted);
	const hasVisible = (span: readonly Message[]) => span.some((message) => !omitted.has(hash(message)));
	if ((hasVisible(p.messagesToSummarize) && history === undefined) || (p.isSplitTurn && split === undefined)) return { fallback: "unknown-boundary" };
	// A folded system checkpoint sits at request position 0; Pi never cuts at system state.
	const visibleKept = projection.messages.findIndex((message, i) => i >= kept && message.role !== "system" && present(i) && !excluded(message));
	const firstVisibleKept = visibleKept < 0 ? kept : visibleKept;
	const llmMessages = visibleLlm(messages);
	if (p.previousSummary && !messages.some((message) => message.role === "compactionSummary" && message.summary === p.previousSummary)) return { fallback: "missing-previous-summary" };
	// Request-time omissions, dropped replies and !! output cannot identify a visible boundary.
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
	let captureMiss: string | undefined;
	let settings: RequestSettings | undefined;
	let held: Held | undefined;
	/** The held summary while a compaction waits for it, so a reset still stops it. */
	let using: Held | undefined;
	const clear = () => { pending = undefined; latest = undefined; captureMiss = undefined; };
	const miss = (reason: string) => { clear(); captureMiss = reason; };
	// An unused summary would only cost tokens; stop it.
	const drop = () => { held?.controller.abort(); using?.controller.abort(); held = undefined; using = undefined; };
	const reset = () => { clear(); drop(); };
	pi.on("session_start", (_event, ctx) => {
		reset();
		try {
			policy = loadConfig(readSection("cacheCompaction", configFile));
			settings = options.settingsManager ?? SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
			requestOptions = sessionOptions(settings);
		} catch { requestOptions = undefined; settings = undefined; }
	});
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);
	pi.on("session_compact", reset);
	pi.on("model_select", reset);
	pi.on("thinking_level_select", clear);

	/** Sends the summary of the captured request beside the main turn. The promise never rejects. */
	function startBackground(captured: Captured, model: Model, ctx: ExtensionContext): Held {
		const controller = new AbortController();
		const ops = fileOpsOf(captured.messages);
		const previous = captured.messages.findLast((message) => message.role === "compactionSummary");
		const previousSummary = previous?.role === "compactionSummary" ? previous.summary : undefined;
		const prompt: Message = { role: "user", content: [{ type: "text", text: backgroundInstruction({ previousSummary: previousSummary !== undefined }) }], timestamp: now() };
		const messages = convertToLlm([...captured.messages, prompt]);
		const estimated = estimateRequestContext(messages);
		const available = model.contextWindow - estimated.tokens - contextSafetyTokens(estimated.tailTokens);
		const floor = summaryOutputFloor(previousSummary);
		// Held as failed, so later replies above the start point do not try again.
		if (available < floor) return { captured, controller, ops, result: Promise.resolve({ failure: "context-window" }) };
		const sessionId = captured.sessionId;
		const progress = (text: string) => {
			try { pi.events.emit(COMPACTION_PROGRESS_EVENT, { sessionId, text: text.slice(-PROGRESS_TAIL_CHARS), chars: text.length }); }
			catch { /* The live band is display only. */ }
		};
		let payloadFallback: string | undefined;
		const result: Promise<HeldResult> = streamed(ctx.modelRegistry, model, { messages }, {
			...requestOptions, headers: backgroundHeaders(model, sessionId, captured.headers), effort: captured.effort,
			maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : Infinity, available),
			sessionId, signal: controller.signal,
			onPayload: (generated: unknown) => {
				try { return mergePayload(model.api, captured.payload!, generated, captured.payloadPrefix, floor); }
				catch (error) { if (error instanceof Error && ["thinking-budget", "prefix-changed"].includes(error.message)) payloadFallback = error.message; throw error; }
			},
		}, progress).then((response): HeldResult => {
			const text = summarize(response, controller.signal.aborted, payloadFallback);
			return "failure" in text ? text : { summary: text.summary, usage: response.usage, stopReason: response.stopReason };
		}, () => ({ failure: controller.signal.aborted ? "aborted" : payloadFallback ?? "request-failed" }));
		return { captured, controller, ops, result };
	}

	/** The held summary as Pi's compaction, if the session still extends the request it summarized. */
	async function useHeld(waiting: Held, event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<{ readonly compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage: Response["usage"]; details: Record<string, unknown> }; readonly stopReason: string } | { readonly fallback: string }> {
		const { captured } = waiting;
		const model = routedModel(ctx);
		if (!model || model.provider !== captured.provider || model.id !== captured.id || model.api !== captured.api || model.baseUrl !== captured.baseUrl) return { fallback: "model-changed" };
		const result = await settle(waiting.result, event.signal, { failure: "aborted" });
		if ("failure" in result) return { fallback: result.failure };
		// Read the session after the wait: a reset may have dropped the summary, and the branch may have grown.
		if (waiting.controller.signal.aborted) return { fallback: "aborted" };
		if (ctx.sessionManager.getSessionId() !== captured.sessionId) return { fallback: "session-changed" };
		const branch = ctx.sessionManager.getBranch();
		const projection = ctx.sessionManager.buildSessionProjection();
		const hash = hashOnce();
		if (reconcile(captured, branch.map((entry) => entry.id), projection.messages, projection.messages.map(hash)) === undefined) return { fallback: "branch-changed" };
		const kept = branch.slice(captured.ids.length).find(cutPoint);
		const start = kept ? entryMessageIndex(projection, kept.id) : undefined;
		if (!kept || start === undefined) return { fallback: "unknown-boundary" };
		const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
		const files = fileLists(waiting.ops, previous?.type === "compaction" ? previous.details : undefined);
		const summary = result.summary + formatFiles(files);
		// Like Pi's estimate after a compaction: the current system state, the summary and the kept messages.
		const system = projection.messages.findLast((message) => message.role === "system");
		const after = [...(system ? [system] : []), ...projection.messages.slice(start).filter((message) => message.role !== "system")]
			.reduce((sum, message) => sum + estimateTokens(message), estimateTokens({ role: "user", content: summary, timestamp: 0 }));
		if (!tailFits(after, Math.min(model.contextWindow, ctx.model?.contextWindow ?? Infinity) - event.preparation.settings.reserveTokens)) return { fallback: "tail-too-large" };
		const p = event.preparation;
		return { stopReason: result.stopReason, compaction: { summary, firstKeptEntryId: kept.id, tokensBefore: p.tokensBefore, usage: result.usage, details: { ...files, cachePrefix: true, background: true } } };
	}

	pi.on("message_end", (event, ctx) => {
		try {
			const message = event.message;
			if (!policy.enabled || !policy.background || held || message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return;
			const captured = latest;
			const model = routedModel(ctx);
			if (!captured?.payload || !model || !settings?.getCompactionSettings(model).enabled || isLocalCompletions(model)) return;
			if (fallbackReason({ enabled: true, captured, model, sessionId: ctx.sessionManager.getSessionId(), now: now(), idleMs: idleLimitMs(policy, model), reason: "threshold", aborted: false })) return;
			// Pi's trigger uses the selected model, the cache the routed one: the earlier trigger of the two decides.
			const trigger = Math.min(...[model, ctx.model].flatMap((m) => m ? [m.contextWindow - settings!.getCompactionSettings(m).reserveTokens] : []));
			if (!backgroundDue(calculateContextTokens(message.usage), trigger, policy.backgroundPercent)) return;
			held = startBackground(captured, model, ctx);
		} catch { /* An optimization only: Pi's trigger still compacts on the usual path. */ }
	});

	pi.on("context_with_system", (event, ctx) => {
		pending = undefined;
		captureMiss = undefined;
		try {
			// Startup custom messages can precede Pi's first prompt-state entry. Preserve
			// their order; the provider-prefix guard still verifies the complete replay.
			if (!policy.enabled) return;
			if (!event.messages.some((message) => message.role === "system")) { captureMiss = "capture-no-system"; return; }
			const request = identity(ctx, now());
			if (!request) { captureMiss = "capture-no-model"; return; }
			const projection = ctx.sessionManager.buildSessionProjection();
			const hash = hashOnce();
			const hashes = projection.messages.map(hash);
			// A pruning context hook makes Pi replay system deltas into one leading
			// checkpoint. Accept only that exact deterministic fold, not arbitrary rewrites.
			const folded = foldProjection(projection.messages, event.messages, hash);
			const mapped = positionsFor(folded.messages, folded.messages.map(hash), event.messages.map(hash));
			if (!mapped) { captureMiss = "capture-projection"; return; }
			const positions = folded.indices.map((index) => mapped[index]);
			// Pi and later extensions may mutate these messages after this observational hook.
			pending = { ...request, ids: ctx.sessionManager.getBranch().map((entry) => entry.id), hashes, positions, messages: structuredClone(event.messages) };
		} catch { miss("capture-failed"); }
	});
	pi.on("before_provider_headers", (event) => {
		try { if (pending) pending = { ...pending, headers: safeHeaders(event.headers) }; }
		catch { miss("capture-headers"); }
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
			if (!request) { captureMiss ??= "capture-no-context"; return; }
			const current = identity(ctx, now());
			if (!current || current.provider !== request.provider || current.id !== request.id || current.api !== request.api || current.baseUrl !== request.baseUrl || current.sessionId !== request.sessionId) { captureMiss = "capture-identity"; return; }
			const payload = capturePayload(request.api, event.payload);
			const payloadPrefix = payloadHashes(request.api, event.payload);
			if (payload && payloadPrefix) { latest = { ...request, at: now(), payload, payloadPrefix, effort: request.api === "anthropic-messages" ? requestEffort(event.payload) : undefined }; captureMiss = undefined; }
			else captureMiss = "capture-payload";
		} catch { miss("capture-payload"); }
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const captured = latest;
		const missed = captureMiss;
		const waiting = held;
		held = undefined;
		// A summary changes the request prefix even if a later hook wins or default compaction runs.
		clear();
		let background: string | null = null;
		let metrics: Pick<CompactionDecision, "estimate" | "available" | "tailTokens"> = { estimate: null, available: null, tailTokens: null };
		let outcome: Pick<CompactionDecision, "stopReason" | "usage"> = { stopReason: null, usage: null };
		const floor = summaryOutputFloor(event.preparation.previousSummary);
		const record = (path: CompactionDecision["path"], fallbackReason: string | null, key?: string) => {
			// This allowlist deliberately excludes response content, diagnostics and provider errors.
			try {
				const decision: CompactionDecision = { time: new Date(now()).toISOString(), sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null, reason: event.reason, path, fallbackReason, tokensBefore: event.preparation.tokensBefore, ...metrics, floor, ...outcome, background };
				operationalLine(join(dirname(configFile), "cache-compaction.log"), JSON.stringify(decision));
				pi.events.emit(COMPACTION_DECISION_EVENT, { path, fallbackReason, sessionId: decision.sessionId, ...(key ? { compactionKey: key } : {}) });
			} catch { /* Best-effort diagnostics must never replace the compaction decision. */ }
		};
		const fallback = (reason: string) => { record("default", reason); report(ctx, `default (${reason})`); return undefined; };
		if (waiting) {
			// Manual compaction may carry its own focus, and overflow recovery must not wait on an old request.
			using = waiting;
			const used = event.reason !== "threshold" ? { fallback: event.reason } : await useHeld(waiting, event, ctx).catch(() => ({ fallback: "request-failed" }));
			if (using === waiting) using = undefined;
			if ("compaction" in used) {
				const usage = used.compaction.usage;
				background = "used";
				outcome = { stopReason: used.stopReason, usage: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output } };
				record("background", null, compactionKey(used.compaction));
				report(ctx, "background");
				return { compaction: used.compaction };
			}
			waiting.controller.abort();
			background = used.fallback;
		}
		let payloadFallback: string | undefined;
		try {
			const model = routedModel(ctx);
			if (!model) return fallback("no-model");
			const p = event.preparation;
			const reason = fallbackReason({ enabled: policy.enabled, captured, model, sessionId: ctx.sessionManager.getSessionId(), now: now(), idleMs: idleLimitMs(policy, model), reason: event.reason, aborted: event.signal.aborted });
			if (reason || !captured?.payload) return fallback(reason === "no-request" ? missed ?? reason : reason ?? "no-payload");
			const request = prepareRequest(captured, event, ctx, now());
			if ("fallback" in request) return fallback(request.fallback);
			const estimated = estimateRequestContext(convertToLlm(request.messages));
			const available = model.contextWindow - estimated.tokens - contextSafetyTokens(estimated.tailTokens);
			metrics = { estimate: estimated.tokens, available, tailTokens: estimated.tailTokens };
			if (available < floor) return fallback("context-window");
			if (event.signal.aborted) return fallback("aborted");
			report(ctx, "prefix-sharing");
			// ModelRuntime.complete normalizes this context with pi-ai normalizeContext, just as
			// streamSimple does in Pi's agent loop. Rebuilding any other provider fields misses cache.
			const sessionId = ctx.sessionManager.getSessionId();
			const progress = (text: string) => {
				try { pi.events.emit(COMPACTION_PROGRESS_EVENT, { sessionId, text: text.slice(-PROGRESS_TAIL_CHARS), chars: text.length }); }
				catch { /* The live band is display only; it must never stop the compaction. */ }
			};
			const response = await streamed(ctx.modelRegistry, model, { messages: convertToLlm(request.messages) }, {
				...requestOptions, headers: captured.headers, effort: captured.effort,
				// Native stream(), not streamSimple(), so there is no automatic context clamp.
				maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : Infinity, available),
				sessionId: captured.sessionId, signal: event.signal,
				onPayload: (generated: unknown) => {
					try { return mergePayload(model.api, captured.payload!, generated, captured.payloadPrefix, floor); }
					catch (error) { if (error instanceof Error && ["thinking-budget", "prefix-changed"].includes(error.message)) payloadFallback = error.message; throw error; }
				},
			}, progress);
			outcome = { stopReason: response.stopReason, usage: { input: response.usage.input, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, output: response.usage.output } };
			const text = summarize(response, event.signal.aborted, payloadFallback);
			if ("failure" in text) return fallback(text.failure);
			const { summary } = text;
			const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
			const files = fileLists(p.fileOps, previous?.type === "compaction" ? previous.details : undefined);
			const compaction = { summary: summary + formatFiles(files), firstKeptEntryId: p.firstKeptEntryId, tokensBefore: p.tokensBefore, usage: response.usage, details: { ...files, cachePrefix: true } };
			record("prefix-sharing", null, compactionKey(compaction));
			return { compaction };
		} catch (error) {
			// Only known local sentinel errors are safe to expose, never provider error text.
			const reason = error instanceof Error && error.message === "ambiguous-boundary" ? error.message : payloadFallback ?? "request-failed";
			return fallback(event.signal.aborted ? "aborted" : reason);
		}
	});
}
