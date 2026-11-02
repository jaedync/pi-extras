import { convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { fallbackReason, fingerprint, mergePayload, reconcile, type Config, type RequestEffort, type RequestIdentity, type Snapshot } from "./core.ts";
import { backgroundHeaders } from "./background.ts";
import { CACHE_WARM_ENTRY, WAKE_PENDING_EVENT, WARM_INSTRUCTION, WARM_MAX_TOKENS, WakeSet, artifactWakes, cacheLifetimeMs, readWakePending, warmDelayMs, warmStop } from "./warm.ts";
import { BACKGROUND_EVENT, BACKGROUND_REQUEST_EVENT, backgroundWork } from "../tab-status/events.ts";
import { operationalLine } from "../operational-log.ts";
import { routedModel } from "../routed-model.ts";

type Message = SessionProjection["messages"][number];
type Model = NonNullable<ExtensionContext["model"]>;
/** The parts of the captured real request that a warm replays. */
export interface WarmSource extends RequestIdentity, Snapshot {
	readonly messages: Message[];
	readonly payload?: Record<string, unknown>;
	readonly payloadPrefix?: readonly string[];
	readonly headers?: Record<string, string>;
	readonly effort?: RequestEffort;
}
export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export const realTimers: Timers = {
	set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export interface WarmerDeps {
	readonly pi: ExtensionAPI;
	readonly now: () => number;
	readonly timers: Timers;
	readonly logFile: string;
	readonly policy: () => Config;
	readonly latest: () => WarmSource | undefined;
	/** A compaction or a background summary is in flight: its request reads the same prefix. */
	readonly busy: () => boolean;
	readonly requestOptions: () => Record<string, unknown> | undefined;
}
export interface Warmer {
	/** A real request was captured: stop any warm and plan the next from it. */
	rearm(ctx: ExtensionContext): void;
	/** A real request starts, or the capture was dropped: a warm in flight is wasted. */
	cancel(): void;
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number; cost?: { total?: number } };
const ARTIFACT_PREFIX = "artifact:";

export function createWarmer(d: WarmerDeps): Warmer {
	const { pi } = d;
	const wakes = new WakeSet();
	const tools = new Set<string>();
	const toolArgs = new Map<string, unknown>();
	let sessionId: string | undefined;
	let ctx: ExtensionContext | undefined;
	let timer: unknown;
	let dueAt = 0;
	let inFlight: AbortController | undefined;
	/** Dollars spent on warms since the last real request: the break-even guard's running total. */
	let spent = 0;
	let lastWarmCost: number | undefined;

	const log = (fields: Record<string, unknown>) => {
		// An allowlist of numbers and fixed reasons; never provider text or request fields.
		try { operationalLine(d.logFile, JSON.stringify({ time: new Date(d.now()).toISOString(), sessionId: sessionId ?? null, ...fields, wakes: wakes.size, tools: tools.size })); }
		catch { /* Diagnostics are best effort. */ }
	};
	const clearTimer = () => { if (timer !== undefined) d.timers.clear(timer); timer = undefined; };
	const abort = () => { inFlight?.abort(); inFlight = undefined; };
	const schedule = (at: number) => {
		clearTimer();
		dueAt = at;
		timer = d.timers.set(() => { timer = undefined; void fire(); }, Math.max(0, at - d.now()));
	};
	const stop = (reason: string, extra: Record<string, unknown> = {}) => { clearTimer(); log({ event: "stop", reason, ...extra }); };
	const resetSession = () => { clearTimer(); abort(); wakes.clear(); tools.clear(); toolArgs.clear(); spent = 0; lastWarmCost = undefined; ctx = undefined; sessionId = undefined; };
	const mine = (id: string) => id === sessionId;

	function promptTokens(context: ExtensionContext): number {
		const branch = context.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const usage = entry.message.usage;
				return usage.input + usage.cacheRead + usage.cacheWrite;
			}
		}
		return 0;
	}

	async function fire(): Promise<void> {
		const context = ctx;
		const captured = d.latest();
		const policy = d.policy();
		if (!context || !captured?.payload) return stop("no-request");
		if (!policy.enabled || !policy.warm.enabled) return stop("disabled");
		if (!wakes.size && !tools.size) return stop("no-wake");
		if (d.busy()) { log({ event: "defer", reason: "summary-running" }); return schedule(d.now() + (warmDelayMs(cacheLifetimeMs(captured.payload, captured)) ?? 60_000)); }
		let model: Model | undefined;
		let tokens = 0;
		try {
			model = routedModel(context);
			if (!model) return stop("no-model");
			const changed = fallbackReason({ enabled: true, captured, model, sessionId: context.sessionManager.getSessionId(), now: d.now(), idleMs: Infinity, reason: "warm", aborted: false });
			if (changed) return stop(changed);
			if (!policy.warm.apis.includes(model.api)) return stop("api");
			const projection = context.sessionManager.buildSessionProjection();
			if (reconcile(captured, context.sessionManager.getBranch().map((entry) => entry.id), projection.messages, projection.messages.map(fingerprint)) === undefined) return stop("branch-changed");
			tokens = promptTokens(context);
		} catch { return stop("context-unavailable"); }
		const ttlMs = cacheLifetimeMs(captured.payload, captured);
		const now = d.now();
		const reason = warmStop({ promptTokens: tokens, cost: model.cost, spent, ttlMs, maxHours: policy.warm.maxHours, minTokens: policy.warm.minTokens, realAt: captured.at, dueAt, now, lastWarmCost });
		if (reason) return stop(reason, { promptTokens: tokens, spent });
		await send(context, captured, model, tokens, ttlMs, now);
	}

	async function send(context: ExtensionContext, captured: WarmSource, model: Model, tokens: number, ttlMs: number, sentAt: number): Promise<void> {
		const controller = new AbortController();
		abort();
		inFlight = controller;
		const prompt: Message = { role: "user", content: [{ type: "text", text: WARM_INSTRUCTION }], timestamp: sentAt };
		let stopReason: string;
		let usage: Usage | undefined;
		let failure: string | undefined;
		try {
			const stream = context.modelRegistry.stream(model, { messages: convertToLlm([...captured.messages, prompt]) }, {
				...d.requestOptions(), maxRetries: 0,
				// Meridian's own session key keeps its turn lock and lineage away from the main session, as for background summaries.
				headers: backgroundHeaders(model, captured.sessionId, captured.headers), effort: captured.effort,
				maxTokens: WARM_MAX_TOKENS, sessionId: captured.sessionId, signal: controller.signal,
				onPayload: (generated: unknown) => {
					try { return mergePayload(model.api, captured.payload!, generated, captured.payloadPrefix, 0); }
					catch (error) { failure = error instanceof Error && ["thinking-budget", "prefix-changed"].includes(error.message) ? error.message : "payload"; throw error; }
				},
			});
			const response = await stream.result();
			stopReason = response.stopReason;
			usage = response.usage;
			// Only a fixed class leaves this function; the provider's message stays here.
			if (stopReason === "error") failure ??= /\b429\b|rate.?limit|overloaded/i.test(response.errorMessage ?? "") ? "rate-limited" : "error";
		} catch { stopReason = "error"; failure ??= "request-failed"; }
		if (inFlight === controller) inFlight = undefined;
		if (controller.signal.aborted || stopReason === "aborted") { log({ event: "stop", reason: "aborted" }); return; }
		if (failure || !usage) { stop(failure ?? "error"); return; }
		const cost = Number(usage.cost?.total) || 0;
		spent += cost;
		lastWarmCost = cost;
		const recorded = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens ?? 0, cost: usage.cost };
		try { pi.appendEntry(CACHE_WARM_ENTRY, { provider: model.provider, model: model.id, usage: recorded, promptTokens: tokens, ttlSeconds: ttlMs / 1000, stopReason }); }
		catch { /* The warm already happened; a lost record must not stop the next one. */ }
		log({ event: "warm", provider: model.provider, model: model.id, promptTokens: tokens, usage: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output }, cost, spent, stopReason });
		// The warm read the prefix at send time, which restarted the entry's lifetime then.
		const delay = warmDelayMs(ttlMs);
		if (delay !== undefined && ctx === context) schedule(sentAt + delay);
	}

	pi.on("session_start", (_event, context) => {
		resetSession();
		try { ctx = context; sessionId = context.sessionManager.getSessionId(); } catch { ctx = undefined; }
		// Shell jobs and subagents publish their counts on request; a reload may keep running work.
		try { pi.events?.emit?.(BACKGROUND_REQUEST_EVENT, { sessionId }); } catch { /* optional */ }
	});
	pi.on("session_shutdown", () => resetSession());
	pi.on("agent_start", () => abort());
	pi.events?.on?.(BACKGROUND_EVENT, (data) => {
		const work = backgroundWork(data);
		if (work && mine(work.sessionId)) wakes.set(`background:${work.source}`, work.count > 0);
	});
	pi.events?.on?.(WAKE_PENDING_EVENT, (data) => {
		const wake = readWakePending(data);
		if (wake && mine(wake.sessionId)) wakes.set(wake.key, wake.pending);
	});
	pi.on("tool_execution_start", (event) => {
		if (!event.parentToolCallId) tools.add(event.toolCallId);
		toolArgs.set(event.toolCallId, event.args);
	});
	pi.on("tool_execution_end", (event) => {
		tools.delete(event.toolCallId);
		const args = toolArgs.get(event.toolCallId);
		toolArgs.delete(event.toolCallId);
		if (artifactWakes(d.policy().warm.formTools, event.toolName, args, event.isError)) wakes.set(`${ARTIFACT_PREFIX}${event.toolCallId}`, true);
	});
	pi.on("agent_end", () => { tools.clear(); toolArgs.clear(); });
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; customType?: string };
		if (message.role === "custom" && message.customType === "artifact-feedback") wakes.clearPrefix(ARTIFACT_PREFIX);
	});

	return {
		rearm(context) {
			abort();
			ctx = context;
			spent = 0;
			lastWarmCost = undefined;
			const captured = d.latest();
			const policy = d.policy();
			if (!captured?.payload || !policy.enabled || !policy.warm.enabled || !policy.warm.apis.includes(captured.api)) { clearTimer(); return; }
			const delay = warmDelayMs(cacheLifetimeMs(captured.payload, captured));
			if (delay === undefined) { clearTimer(); return; }
			schedule(captured.at + delay);
		},
		cancel() { clearTimer(); abort(); },
	};
}
