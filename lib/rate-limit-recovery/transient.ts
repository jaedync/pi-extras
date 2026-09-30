/**
 * Short provider rate limits, such as OpenRouter's "temporarily rate-limited upstream" or a 429
 * without a structured reset, usually clear within a minute. Pi's default retry gives up after
 * about 14 seconds. This owns those errors instead: jittered exponential backoff within a bounded
 * budget, honoring a Retry-After the transport just saw. Structured quota errors stay with the
 * hibernation path in controller.ts.
 */
import type { ExtensionContext, MessageEndEvent, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { captureLimit, parseRateLimit } from "./core.ts";
import { takeRetryHint } from "./retry-hint.ts";
import { waitForDelay, type Wait } from "./wait.ts";

export const BASE_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 60_000;
// A backstop only: with at least 4 s per wait, even the 900 s maximum budget ends a streak first.
export const MAX_ATTEMPTS = 30;
const MAX_ERROR_CHARS = 32_768;
// ±20% spreads parallel subagents that were limited at the same moment.
const JITTER = 0.2;
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b/i;
// Long-lived limits and billing must still stop the run, as Pi's own classifier intends.
const NOT_TRANSIENT = /quota|billing|insufficient|usage limit|available balance|out of budget/i;

export interface Streak { readonly attempts: number; readonly spentMs: number }
export interface TransientPlan { readonly delayMs: number; readonly attempt: number; readonly hinted: boolean }
export type TransientRefusal = "budget" | "attempts" | "hint-too-long";
// pi-ai is not a direct dependency; take its assistant message shape from the event.
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
type Failure = Pick<AssistantMessage, "stopReason" | "errorMessage">;

export function isTransientRateLimit(message: Failure): boolean {
	const text = message.errorMessage;
	if (message.stopReason !== "error" || typeof text !== "string" || text.length > MAX_ERROR_CHARS) return false;
	return RATE_LIMITED.test(text) && !NOT_TRANSIENT.test(text) && parseRateLimit(text) === undefined;
}

export function planTransient(streak: Streak, budgetMs: number, random: () => number, hintSeconds?: number): TransientPlan | TransientRefusal {
	if (streak.attempts >= MAX_ATTEMPTS) return "attempts";
	const remainingMs = budgetMs - streak.spentMs;
	// The provider's Retry-After is a floor: a short one must not burn the streak in seconds.
	const hintMs = hintSeconds === undefined ? 0 : Math.ceil(hintSeconds * 1000);
	if (hintMs > remainingMs) return "hint-too-long";
	if (remainingMs < BASE_DELAY_MS) return "budget";
	const scheduled = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** streak.attempts);
	const jittered = Math.round(scheduled * (1 - JITTER + 2 * JITTER * random()));
	return { delayMs: Math.min(Math.max(jittered, hintMs), remainingMs), attempt: streak.attempts + 1, hinted: hintMs > jittered };
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

export function waitingMessage(who: string, plan: TransientPlan, budgetMs: number): string {
	return `${PREFIX} ${who}: a temporary provider rate limit. Waiting ${duration(plan.delayMs)} before sending the request again (retry ${plan.attempt}, at most ${duration(budgetMs)} of waiting in total). Esc cancels.`;
}

export function exhaustedMessage(who: string, refusal: TransientRefusal, streak: Streak, hintSeconds?: number): string {
	const retries = `${streak.attempts} automatic ${streak.attempts === 1 ? "retry" : "retries"}`;
	if (refusal === "attempts") return `${PREFIX} ${who}: a temporary provider rate limit. It persisted through the automatic retry limit of ${MAX_ATTEMPTS} over ${duration(streak.spentMs)}. Send the request again later or switch models.`;
	const why = refusal === "hint-too-long" ? `The provider asked to wait ${Math.ceil(hintSeconds ?? 0)} seconds, longer than the automatic wait allows.`
		: `It persisted after ${retries} over ${duration(streak.spentMs)}.`;
	return `${PREFIX} ${who}: a temporary provider rate limit. ${why} Send the request again later, switch models, or raise rateLimitRecovery.transientMaxWaitSeconds.`;
}

export interface TransientDeps {
	/** Total wait per streak of consecutive limits; 0 leaves these errors to Pi. */
	readonly budgetMs: () => number;
	readonly random?: () => number;
	readonly wait?: Wait;
	/** Countdown for interactive sessions; children and print mode wait silently. */
	readonly ui?: (ctx: ExtensionContext, who: string, resumeAtMs: number, cancel: () => void) => { tick(): void; close(): void } | undefined;
	readonly onFailure?: (error: unknown) => void;
}

interface Pending { readonly plan: TransientPlan; readonly who: string }
interface Active { readonly cancel: () => void; readonly skip: () => void }

/** One session's streak of transient limits. Resumes through agent_before_settle, like hibernation. */
export class TransientBackoff {
	private readonly deps: TransientDeps;
	private streak: Streak = { attempts: 0, spentMs: 0 };
	private pending: Pending | undefined;
	private active: Active | undefined;
	private ready = false;

	constructor(deps: TransientDeps) { this.deps = deps; }

	reset(): void {
		this.streak = { attempts: 0, spentMs: 0 };
		this.pending = undefined;
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
	messageEnd(message: AssistantMessage, ctx: Pick<ExtensionContext, "signal">): AssistantMessage | undefined {
		this.pending = undefined;
		this.ready = false;
		// Taken for every reply, so a hint from a quota error cannot reach a later limit.
		const hint = takeRetryHint(ctx.signal);
		if (message.stopReason !== "error") {
			if (message.stopReason !== "aborted") this.streak = { attempts: 0, spentMs: 0 };
			return undefined;
		}
		const budgetMs = this.deps.budgetMs();
		if (budgetMs <= 0 || !isTransientRateLimit(message) || !ctx.signal || ctx.signal.aborted) return undefined;
		const limit = captureLimit(message, {}, Date.now());
		const who = `${limit.provider}/${limit.model}`;
		const plan = planTransient(this.streak, budgetMs, this.deps.random ?? Math.random, hint);
		if (typeof plan === "string") return { ...message, errorMessage: exhaustedMessage(who, plan, this.streak, hint) };
		this.pending = { plan, who };
		return { ...message, errorMessage: waitingMessage(who, plan, budgetMs) };
	}

	async turnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<TurnEndEventResult | undefined> {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending || event.message.role !== "assistant" || event.message.stopReason !== "error") return undefined;
		const runSignal = ctx.signal;
		if (!runSignal || runSignal.aborted) return undefined;
		const controller = new AbortController();
		let cancelled = false;
		let wasSkipped = false;
		let skip = () => {};
		const skipped = new Promise<boolean>((resolve) => { skip = () => { wasSkipped = true; resolve(true); }; });
		this.active = { cancel: () => { cancelled = true; controller.abort(); }, skip };
		const startedAt = Date.now();
		let ui: ReturnType<NonNullable<TransientDeps["ui"]>>;
		let finished = false;
		try {
			ui = this.deps.ui?.(ctx, pending.who, startedAt + pending.plan.delayMs, () => this.cancel());
			const waited = (this.deps.wait ?? waitForDelay)(pending.plan.delayMs, AbortSignal.any([controller.signal, runSignal]), () => ui?.tick());
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
		const spentMs = wasSkipped ? Math.min(pending.plan.delayMs, Math.max(0, Date.now() - startedAt)) : pending.plan.delayMs;
		this.streak = { attempts: pending.plan.attempt, spentMs: this.streak.spentMs + spentMs };
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
