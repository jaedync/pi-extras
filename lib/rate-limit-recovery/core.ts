/** Pure, bounded parsing and timing. Provider prose is never injected or logged. */
import { formatDuration } from "../status-plus-logic.ts";
import type { RecoveryConfig } from "./config.ts";

const MAX_ERROR_CHARS = 32_768;
const MAX_RETRY_SECONDS = 7 * 24 * 3600;
const RATE_LIMIT_TYPES = new Set(["rate_limit_error", "rate_limit_exceeded"]);
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export interface RateLimit { readonly retryAfterSeconds?: number }
export interface ModelIdentity { readonly provider?: string; readonly api?: string; readonly id?: string; readonly model?: string }
export interface CapturedLimit extends RateLimit {
	readonly provider: string;
	readonly model: string;
	readonly scope: string;
	readonly observedAtMs: number;
	readonly resetAtMs?: number;
}
export interface WaitPlan { readonly delayMs: number; readonly pausedAtMs: number; readonly resumeAtMs: number }
export type WaitRefusal = "unknown-reset" | "too-long" | "attempt-limit" | "wait-budget";

/** Accept only documented seconds on a structured rate-limit error, never prose. */
export function parseRateLimit(raw: unknown): RateLimit | undefined {
	if (typeof raw !== "string" || raw.length > MAX_ERROR_CHARS) return undefined;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
	const root = object(parsed);
	if (!root) return undefined;
	const error = object(root.error) ?? root;
	if (typeof error.type !== "string" || !RATE_LIMIT_TYPES.has(error.type)) return undefined;
	const seconds = error.retry_after ?? root.retry_after;
	return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_RETRY_SECONDS
		? { retryAfterSeconds: seconds } : {};
}

const clean = (text: string | undefined, fallback: string): string => (text ?? fallback).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 160) || fallback;

export function scopeFor(model: ModelIdentity): string {
	const id = model.id ?? model.model ?? "";
	const anthropic = model.api === "anthropic-messages" || model.provider === "anthropic" || /(?:^|[/:])(?:anthropic\/)?claude(?:[-/]|$)/i.test(id);
	return anthropic ? "anthropic" : `provider:${model.provider ?? "unknown"}`;
}

export const sameScope = (scope: string, model: ModelIdentity | undefined): boolean => !!model && scopeFor(model) === scope;

export function captureLimit(model: ModelIdentity, limit: RateLimit, observedAtMs: number): CapturedLimit {
	return {
		...limit, provider: clean(model.provider, "unknown provider"), model: clean(model.model ?? model.id, "unknown model"),
		scope: scopeFor(model), observedAtMs,
		...(limit.retryAfterSeconds !== undefined ? { resetAtMs: observedAtMs + limit.retryAfterSeconds * 1000 } : {}),
	};
}

export function planWait(limit: CapturedLimit, config: RecoveryConfig, spentMs: number, attempts: number, now: number): WaitPlan | WaitRefusal {
	if (limit.resetAtMs === undefined) return "unknown-reset";
	if (attempts >= config.maxRecoveries) return "attempt-limit";
	const resumeAtMs = limit.resetAtMs + config.resumeMarginSeconds * 1000;
	const delayMs = Math.max(0, Math.ceil(resumeAtMs - now));
	if (delayMs > config.maxWaitSeconds * 1000) return "too-long";
	if (spentMs + delayMs > config.maxWaitSeconds * 1000) return "wait-budget";
	return { delayMs, pausedAtMs: now, resumeAtMs };
}

export function failureMessage(limit: CapturedLimit, now: number, reason: string): string {
	const seconds = limit.resetAtMs === undefined ? undefined : Math.max(0, Math.ceil((limit.resetAtMs - now) / 1000));
	const reset = seconds === undefined ? "The reset time is unknown."
		: `Expected reset at ${new Date(limit.resetAtMs!).toISOString()} (in ${formatDuration(seconds * 1000, true)}; ${seconds} seconds).`;
	// Pi deliberately treats quota failures as non-transient. This prevents its
	// short retry loop from competing with the bounded recovery boundary below.
	return `Request quota exceeded for ${limit.provider}: the provider rate limit was reached. ${reset} ${reason}`;
}

export function resumedMessage(limit: CapturedLimit, pausedAtMs: number, resumedAtMs: number, model: ModelIdentity | undefined, minimumElapsedMs = 0): string {
	const wallElapsedMs = resumedAtMs - pausedAtMs;
	const lowerBound = wallElapsedMs < minimumElapsedMs;
	const elapsedMs = Math.max(minimumElapsedMs, wallElapsedMs, 0);
	return [
		`Rate-limit recovery: this session was automatically hibernated for ${lowerBound ? "at least " : ""}${(elapsedMs / 1000).toFixed(3)} seconds (${formatDuration(elapsedMs, true)}).`,
		`Paused at: ${new Date(pausedAtMs).toISOString()}.`,
		`Resumed at: ${new Date(resumedAtMs).toISOString()}.`,
		`Limited provider/model: ${limit.provider}/${limit.model}. Current provider/model: ${clean(model?.provider, "unknown")}/${clean(model?.id ?? model?.model, "unknown")}.`,
		lowerBound ? "The system clock changed during hibernation. Elapsed wait is a lower bound from the completed timer, not an exact wall-clock measurement." : "This is elapsed wall time, not tool execution or confirmation that quota has reset.",
		"Follow the current task and any newer user instructions.",
	].join("\n");
}
