/**
 * Short provider rate limits, such as OpenRouter's "temporarily rate-limited upstream" or a 429
 * without a structured reset, usually clear within a minute. Pi's default retry gives up after
 * about 14 seconds. This owns those errors instead: jittered exponential backoff within a bounded
 * budget, honoring a Retry-After the transport just saw. Structured quota errors stay with the
 * hibernation path in controller.ts.
 *
 * The same backoff sends a turn again when Meridian, a local Claude Code proxy, fails it with
 * "Reached maximum number of turns". That failure is intermittent and Pi's own retry does not
 * recognize it. 17 s of retries did not clear it in practice, so a fixed schedule grows into the
 * transient budget.
 *
 * Transport failures (connection.ts) use the rate-limit schedule and budget, with a separate
 * streak. Pi would retry them too, so each replacement text below matches none of Pi's retry
 * patterns: only this backoff sends the request again.
 */
import type { ExtensionContext, MessageEndEvent, ModelRegistry, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { MAX_HINT_SECONDS, connectionCause, connectionHint, type ConnectionCause } from "./connection.ts";
import { LOCAL_MAX_DELAY_MS, localTarget, probeServer, waitUntilAnswering, type LocalPolicy, type LocalTarget, type Probe } from "./local.ts";
import { captureLimit, parseRateLimit } from "./core.ts";
import { takeRetryHint } from "./retry-hint.ts";
import { waitForDelay, type Wait } from "./wait.ts";

export const BASE_DELAY_MS = 5_000;
// Pi waited 2 s for a dropped connection, and a short blip clears that fast.
export const DROPPED_FIRST_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 60_000;
// A backstop only: with at least 4 s per wait, even the 900 s maximum budget ends a streak first.
export const MAX_ATTEMPTS = 30;
const MAX_ERROR_CHARS = 32_768;
// ±20% spreads parallel subagents that were limited at the same moment.
const JITTER = 0.2;
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b/i;
// Long-lived limits and billing must still stop the run, as Pi's own classifier intends. `usage.?limit` also
// matches error codes such as ChatGPT's subscription_sharing_usage_limit_exceeded, which can arrive without prose.
const NOT_TRANSIENT = /quota|billing|insufficient|usage.?limit|available balance|out of budget/i;
// Only this result of the proxy, not any api_error: other Claude Code results (a low balance,
// a refusal) would fail again.
const PROXY_TURN_LIMIT = /Claude Code returned an error result: Reached maximum number of turns\b/;
export const PROXY_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000];
// These ran before the schedule grew, with no budget: Pi never retries this failure itself.
const PROXY_FREE_RETRIES = 3;

export interface Streak { readonly attempts: number; readonly spentMs: number }
export interface TransientPlan { readonly delayMs: number; readonly attempt: number; readonly hinted: boolean }
export type TransientRefusal = "budget" | "attempts" | "hint-too-long";
/** A short provider rate limit, the proxy's turn-limit failure, or a transport failure. */
export type TransientKind = "rate-limit" | "proxy" | "connection";
// pi-ai is not a direct dependency; take its assistant message shape from the event.
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
type Failure = Pick<AssistantMessage, "stopReason" | "errorMessage">;

export function isTransientRateLimit(message: Failure): boolean {
	const text = message.errorMessage;
	if (message.stopReason !== "error" || typeof text !== "string" || text.length > MAX_ERROR_CHARS) return false;
	return RATE_LIMITED.test(text) && !NOT_TRANSIENT.test(text) && parseRateLimit(text) === undefined;
}

export function isProxyTurnLimit(message: Failure): boolean {
	const text = message.errorMessage;
	return message.stopReason === "error" && typeof text === "string" && text.length <= MAX_ERROR_CHARS && PROXY_TURN_LIMIT.test(text);
}

/** A transport or proxy failure that a short wait clears; quotas and billing never are. */
export function connectionFailure(message: Failure): ConnectionCause | undefined {
	const text = message.errorMessage;
	if (message.stopReason !== "error" || typeof text !== "string" || text.length > MAX_ERROR_CHARS || NOT_TRANSIENT.test(text)) return undefined;
	// A structured rate limit, even inside a 5xx, belongs to quota hibernation or the child's fail-fast.
	if (parseRateLimit(text) !== undefined) return undefined;
	return connectionCause(text);
}

/** Long-lived limits and billing, which no short wait clears. */
export function isQuotaError(text: string): boolean {
	return text.length <= MAX_ERROR_CHARS && NOT_TRANSIENT.test(text) && !isTemporaryLimitReport(text);
}

/** This backoff's own report of a temporary limit it waited on or gave up on; it reads as a quota error on purpose (see PREFIX). */
export function isTemporaryLimitReport(text: string): boolean {
	return text.startsWith(PREFIX) && text.includes(`: ${TEMPORARY}.`);
}

export function planTransient(streak: Streak, budgetMs: number, random: () => number, hintSeconds?: number, firstDelayMs = BASE_DELAY_MS): TransientPlan | TransientRefusal {
	if (streak.attempts >= MAX_ATTEMPTS) return "attempts";
	const remainingMs = budgetMs - streak.spentMs;
	// The provider's Retry-After is a floor: a short one must not burn the streak in seconds.
	const hintMs = hintSeconds === undefined ? 0 : Math.ceil(hintSeconds * 1000);
	if (hintMs > remainingMs) return "hint-too-long";
	if (remainingMs < BASE_DELAY_MS) return "budget";
	const scheduled = streak.attempts === 0 ? firstDelayMs : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** streak.attempts);
	const jittered = Math.round(scheduled * (1 - JITTER + 2 * JITTER * random()));
	return { delayMs: Math.min(Math.max(jittered, hintMs), remainingMs), attempt: streak.attempts + 1, hinted: hintMs > jittered };
}

/** A local provider's next wait: the same schedule with a 30 s cap, and no budget or retry limit. */
export function planLocal(streak: Streak, random: () => number, hintSeconds?: number, firstDelayMs = BASE_DELAY_MS): TransientPlan {
	const hintMs = hintSeconds === undefined ? 0 : Math.ceil(hintSeconds * 1000);
	const scheduled = streak.attempts === 0 ? firstDelayMs : Math.min(LOCAL_MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(streak.attempts, 16));
	const jittered = Math.min(LOCAL_MAX_DELAY_MS, Math.round(scheduled * (1 - JITTER + 2 * JITTER * random())));
	return { delayMs: Math.max(jittered, Math.min(hintMs, LOCAL_MAX_DELAY_MS)), attempt: streak.attempts + 1, hinted: hintMs > jittered };
}

export function planProxyRetry(streak: Streak, budgetMs: number): TransientPlan | "attempts" {
	const step = PROXY_RETRY_DELAYS_MS[streak.attempts];
	if (step === undefined) return "attempts";
	// Later steps use what remains of the budget, as planTransient does.
	const delayMs = streak.attempts < PROXY_FREE_RETRIES ? step : Math.min(step, budgetMs - streak.spentMs);
	return delayMs < BASE_DELAY_MS && streak.attempts >= PROXY_FREE_RETRIES ? "attempts" : { delayMs, attempt: streak.attempts + 1, hinted: false };
}

/** How many proxy retries the schedule allows within this budget. */
export function proxyRetryLimit(budgetMs: number): number {
	let streak: Streak = { attempts: 0, spentMs: 0 };
	for (let plan = planProxyRetry(streak, budgetMs); typeof plan !== "string"; plan = planProxyRetry(streak, budgetMs)) streak = { attempts: plan.attempt, spentMs: streak.spentMs + plan.delayMs };
	return streak.attempts;
}

function duration(ms: number): string {
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (!minutes) return `${seconds} s`;
	return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

// "Request quota exceeded" is Pi's non-transient class. Without it, Pi's own short retry loop
// would run alongside this wait. Provider prose is omitted, as for structured quota errors.
const PREFIX = "Request quota exceeded for";
const TEMPORARY = "a temporary provider rate limit";

export function waitingMessage(who: string, plan: TransientPlan, budgetMs: number): string {
	return `${PREFIX} ${who}: ${TEMPORARY}. Waiting ${duration(plan.delayMs)} before sending the request again (retry ${plan.attempt}, at most ${duration(budgetMs)} of waiting in total). Press Esc to cancel.`;
}

export function exhaustedMessage(who: string, refusal: TransientRefusal, streak: Streak, hintSeconds?: number): string {
	const retries = `${streak.attempts} automatic ${streak.attempts === 1 ? "retry" : "retries"}`;
	if (refusal === "attempts") return `${PREFIX} ${who}: ${TEMPORARY}. It persisted through the automatic retry limit of ${MAX_ATTEMPTS} over ${duration(streak.spentMs)}. Send the request again later or switch models.`;
	const why = refusal === "hint-too-long" ? `The provider asked to wait ${Math.ceil(hintSeconds ?? 0)} seconds, longer than the automatic wait allows.`
		: `It persisted after ${retries} over ${duration(streak.spentMs)}.`;
	return `${PREFIX} ${who}: ${TEMPORARY}. ${why} Send the request again later, switch models, or raise rateLimitRecovery.transientMaxWaitSeconds.`;
}

// Pi does not retry the proxy's failure, and these texts must not match its retry pattern
// either, or both would send the request. So they carry no "error", no status code and no model
// name: a dated model ID such as 20250520 contains "520", which Pi reads as a server failure.
const PROXY_FAILED = 'Claude Code proxy failure: the proxy ended the turn early ("Reached maximum number of turns")';

export function proxyWaitingMessage(plan: TransientPlan, limit: number): string {
	return `${PROXY_FAILED}. Sending the request again in ${duration(plan.delayMs)} (retry ${plan.attempt} of ${limit}). Press Esc to cancel.`;
}

export function proxyExhaustedMessage(streak: Streak): string {
	return `${PROXY_FAILED}. It persisted after ${streak.attempts} automatic retries over ${duration(streak.spentMs)}. Send the request again later or switch models.`;
}

// Same rule as PROXY_FAILED: no phrase of Pi's retry patterns ("server error", "timeout",
// "unavailable", "overloaded", "rate limit", a 5xx status), so rateLimitRecovery is not named either.
const CONNECTION_FAILED = "Provider connection failure";
// A model name can hold such a phrase (model-502, timeout-tuned); then the message names none.
const RETRY_WORDING = /(?<![a-z0-9])\d{3}(?![a-z0-9])|time.?out|timed|error|overload|unavailable|terminat|rate.?limit|capacity|busy|retry|network|socket|connect|fetch|upstream|ended|interrupt|exhausted|closed|ENOTFOUND|EAI_AGAIN|getaddrinfo/i;
const RAW_CHARS = 2_048;
const named = (who: string) => RETRY_WORDING.test(who) ? "the provider" : who;

/** The provider's own text, which the shown message leaves out; kept in a hidden session entry. */
export interface ConnectionEvidence { readonly kind: "connection-failure"; readonly cause: ConnectionCause; readonly provider: string; readonly model: string; readonly raw: string }
const CAUSES: Readonly<Record<ConnectionCause, string>> = {
	dropped: "the connection dropped",
	slow: "the provider sent no data in time",
	busy: "the provider or its proxy was busy",
	down: "the server could not take the request",
};

/** This backoff's own report of a transport failure; the subagent fallback reads it as overloaded. */
export function isConnectionReport(text: string): boolean {
	return text.startsWith(`${CONNECTION_FAILED} on `);
}

/** `requestedSeconds` is the provider's own retry_after, shown when the plan had to clamp it. */
export function connectionWaitingMessage(who: string, cause: ConnectionCause, plan: TransientPlan, budgetMs: number, requestedSeconds?: number): string {
	const asked = requestedSeconds !== undefined && requestedSeconds > MAX_HINT_SECONDS ? `; the provider asked to wait ${Math.ceil(requestedSeconds)} s` : "";
	return `${CONNECTION_FAILED} on ${named(who)}: ${CAUSES[cause]}. Sending the request again in ${duration(plan.delayMs)} (retry ${plan.attempt}, at most ${duration(budgetMs)} of waiting in total${asked}). Press Esc to cancel.`;
}

/** `downMs` is how long the local server has not answered; under a minute it is left out. */
export function localWaitingMessage(who: string, cause: ConnectionCause, downMs: number): string {
	const down = downMs >= 60_000 ? ` (no answer for ${duration(downMs)})` : "";
	return `${CONNECTION_FAILED} on ${named(who)}: ${CAUSES[cause]}${down}. It runs on local hardware, so Pi waits until the server answers and then sends the request again. Press Esc to cancel.`;
}

export function connectionExhaustedMessage(who: string, cause: ConnectionCause, refusal: TransientRefusal, streak: Streak, hintSeconds?: number): string {
	const head = `${CONNECTION_FAILED} on ${named(who)}: ${CAUSES[cause]}.`;
	if (refusal === "attempts") return `${head} It persisted through the automatic retry limit of ${MAX_ATTEMPTS} over ${duration(streak.spentMs)}. Send the request again later or switch models.`;
	const why = refusal === "hint-too-long" ? `The provider asked to wait ${Math.ceil(hintSeconds ?? 0)} seconds, longer than the automatic wait allows.`
		: `It persisted after ${streak.attempts} automatic ${streak.attempts === 1 ? "retry" : "retries"} over ${duration(streak.spentMs)}.`;
	return `${head} ${why} Send the request again later, switch models, or raise transientMaxWaitSeconds.`;
}

export interface TransientDeps {
	/** Total wait per streak of rate limits or of connection failures; 0 leaves them to Pi. Proxy retries need none for their first 3. */
	readonly budgetMs: () => number;
	readonly random?: () => number;
	readonly wait?: Wait;
	/** Countdown for interactive sessions; children and print mode wait silently. */
	/** `downSinceMs` is set for a local provider: the wait then has no end time to count down to. */
	readonly ui?: (ctx: ExtensionContext, who: string, resumeAtMs: number, cancel: () => void, kind: TransientKind, downSinceMs?: number) => { tick(): void; close(): void } | undefined;
	/** Local providers wait with no limit; undefined keeps every provider on the budget. */
	readonly local?: () => LocalPolicy | undefined;
	readonly probe?: Probe;
	readonly now?: () => number;
	readonly onFailure?: (error: unknown) => void;
	/** Keeps a connection failure's raw text; called at turn_end, so the entry follows the failed reply. */
	readonly record?: (entry: ConnectionEvidence) => void;
}

interface Pending { readonly plan: TransientPlan; readonly who: string; readonly kind: TransientKind; readonly local?: LocalTarget }
type FailureContext = Pick<ExtensionContext, "signal"> & { readonly modelRegistry?: Pick<ModelRegistry, "find"> };
const NO_STREAKS: Readonly<Record<TransientKind, Streak>> = { "rate-limit": { attempts: 0, spentMs: 0 }, proxy: { attempts: 0, spentMs: 0 }, connection: { attempts: 0, spentMs: 0 } };
interface Active { readonly cancel: () => void; readonly skip: () => void }

/** One session's streaks of transient failures, one per kind. Resumes through agent_before_settle, like hibernation. */
export class TransientBackoff {
	private readonly deps: TransientDeps;
	private streaks = NO_STREAKS;
	private pending: Pending | undefined;
	private active: Active | undefined;
	private ready = false;
	private evidence: ConnectionEvidence | undefined;
	/** When the local server stopped answering; cleared by any good reply. */
	private downSinceMs: number | undefined;

	constructor(deps: TransientDeps) { this.deps = deps; }

	private now(): number { return (this.deps.now ?? Date.now)(); }

	private localFor(message: AssistantMessage, ctx: FailureContext): LocalTarget | undefined {
		const policy = this.deps.local?.();
		if (!policy?.enabled || !ctx.modelRegistry) return undefined;
		try { return localTarget(ctx.modelRegistry.find(message.provider, message.model), policy.providers); }
		catch { return undefined; }
	}

	reset(): void {
		this.downSinceMs = undefined;
		this.streaks = NO_STREAKS;
		this.pending = undefined;
		this.evidence = undefined;
		this.ready = false;
	}

	cancel(): void {
		this.pending = undefined;
		this.ready = false;
		this.active?.cancel();
	}

	/** End the current wait now and resume, e.g. when the user switches to another model. */
	skip(): void { this.active?.skip(); }

	get waiting(): boolean { return this.active !== undefined; }

	/** A replacement message when this backoff owns the error; undefined leaves it to Pi. */
	messageEnd(message: AssistantMessage, ctx: FailureContext): AssistantMessage | undefined {
		this.pending = undefined;
		this.ready = false;
		this.evidence = undefined;
		// Taken for every reply, so a hint from a quota error cannot reach a later limit.
		const hint = takeRetryHint(ctx.signal);
		if (message.stopReason !== "error") {
			if (message.stopReason !== "aborted") { this.streaks = NO_STREAKS; this.downSinceMs = undefined; }
			return undefined;
		}
		if (!ctx.signal || ctx.signal.aborted) return undefined;
		const budgetMs = this.deps.budgetMs();
		// A zero budget leaves rate limits and transport failures to Pi, which retries both itself.
		// Pi never retries the proxy's failure, so its first retries run without a budget.
		const cause = budgetMs > 0 ? connectionFailure(message) : undefined;
		const kind: TransientKind | undefined = isProxyTurnLimit(message) ? "proxy" : budgetMs > 0 && isTransientRateLimit(message) ? "rate-limit" : cause ? "connection" : undefined;
		if (!kind) return undefined;
		const limit = captureLimit(message, {}, Date.now());
		const who = `${limit.provider}/${limit.model}`;
		const streak = this.streaks[kind];
		if (kind === "proxy") {
			const plan = planProxyRetry(streak, budgetMs);
			if (typeof plan === "string") return { ...message, errorMessage: proxyExhaustedMessage(streak) };
			this.pending = { plan, who, kind };
			return { ...message, errorMessage: proxyWaitingMessage(plan, proxyRetryLimit(budgetMs)) };
		}
		if (kind === "connection" && cause) {
			const raw = message.errorMessage ?? "";
			this.evidence = { kind: "connection-failure", cause, provider: limit.provider, model: limit.model, raw: raw.slice(0, RAW_CHARS) };
			// The body's own hint names this failure; a transport Retry-After is only kept for 429s.
			const requested = connectionHint(raw) ?? hint;
			const wanted = requested === undefined ? undefined : Math.min(requested, MAX_HINT_SECONDS);
			const local = this.localFor(message, ctx);
			if (local) {
				this.downSinceMs ??= this.now();
				const localPlan = planLocal(streak, this.deps.random ?? Math.random, wanted, cause === "dropped" ? DROPPED_FIRST_DELAY_MS : BASE_DELAY_MS);
				this.pending = { plan: localPlan, who, kind, local };
				return { ...message, errorMessage: localWaitingMessage(who, cause, this.now() - this.downSinceMs) };
			}
			const plan = planTransient(streak, budgetMs, this.deps.random ?? Math.random, wanted, cause === "dropped" ? DROPPED_FIRST_DELAY_MS : BASE_DELAY_MS);
			if (typeof plan === "string") return { ...message, errorMessage: connectionExhaustedMessage(who, cause, plan, streak, requested) };
			this.pending = { plan, who, kind };
			return { ...message, errorMessage: connectionWaitingMessage(who, cause, plan, budgetMs, requested) };
		}
		const plan = planTransient(streak, budgetMs, this.deps.random ?? Math.random, hint);
		if (typeof plan === "string") return { ...message, errorMessage: exhaustedMessage(who, plan, streak, hint) };
		this.pending = { plan, who, kind };
		return { ...message, errorMessage: waitingMessage(who, plan, budgetMs) };
	}

	async turnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<TurnEndEventResult | undefined> {
		const pending = this.pending;
		this.pending = undefined;
		const evidence = this.evidence;
		this.evidence = undefined;
		if (evidence) {
			try { this.deps.record?.(evidence); } catch (error) { this.deps.onFailure?.(error); }
		}
		if (!pending || event.message.role !== "assistant" || event.message.stopReason !== "error") return undefined;
		// Pi runs no tool call of a failed reply today. If it ever does, sending the turn again could run a tool twice.
		if (event.toolResults?.length) return undefined;
		const runSignal = ctx.signal;
		if (!runSignal || runSignal.aborted) return undefined;
		const controller = new AbortController();
		let cancelled = false;
		let wasSkipped = false;
		let skip = () => {};
		const skipped = new Promise<boolean>((resolve) => { skip = () => { wasSkipped = true; resolve(true); }; });
		this.active = { cancel: () => { cancelled = true; controller.abort(); }, skip };
		const startedAt = this.now();
		let ui: ReturnType<NonNullable<TransientDeps["ui"]>>;
		let finished = false;
		try {
			ui = this.deps.ui?.(ctx, pending.who, startedAt + pending.plan.delayMs, () => this.cancel(), pending.kind, pending.local ? this.downSinceMs ?? startedAt : undefined);
			const signal = AbortSignal.any([controller.signal, runSignal]);
			const wait = this.deps.wait ?? waitForDelay;
			const local = pending.local;
			const probe = this.deps.probe ?? probeServer;
			const waited = local
				? waitUntilAnswering({ delayMs: pending.plan.delayMs, signal, tick: () => ui?.tick(), now: () => this.now(), wait, probe: (s) => probe(local.baseUrl, s) })
				: wait(pending.plan.delayMs, signal, () => ui?.tick());
			finished = await Promise.race([waited, skipped]);
		} catch (error) { this.deps.onFailure?.(error); }
		finally {
			try { ui?.close(); } catch (error) { finished = false; this.deps.onFailure?.(error); }
			this.active = undefined;
			// Releases the timer after a skip; the outcome is already decided.
			controller.abort();
		}
		if (!finished || cancelled || runSignal.aborted) return undefined;
		// A completed wait counts in full; a skipped one only as long as it ran.
		// A local wait has no fixed length: it counts as long as it ran.
		const ranMs = Math.max(0, this.now() - startedAt);
		const spentMs = pending.local ? ranMs : wasSkipped ? Math.min(pending.plan.delayMs, ranMs) : pending.plan.delayMs;
		this.streaks = { ...this.streaks, [pending.kind]: { attempts: pending.plan.attempt, spentMs: this.streaks[pending.kind].spentMs + spentMs } };
		this.ready = true;
		// The failed attempt stays in raw history but leaves the retried context, as with Pi's own retry.
		return { entries: [...event.entries, { type: "context_edit", targetId: event.messageEntryId, replacement: null }] };
	}

	consumeReady(): boolean {
		const ready = this.ready;
		this.ready = false;
		return ready;
	}
}
