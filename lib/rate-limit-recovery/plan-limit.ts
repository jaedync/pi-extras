/**
 * The ChatGPT plan's usage limit, on the Codex login (`openai-codex`) and on
 * Sign in with ChatGPT (`openai`). Neither sends the `rate_limit_error` with a
 * `retry_after` that core.ts accepts:
 *
 * - Codex answers HTTP 429, or a WebSocket `error` event that wraps one, with
 *   `error.type` `usage_limit_reached`, `resets_at` in epoch seconds and
 *   `limit_window_minutes` (openai/codex codex-api api_bridge.rs and
 *   responses_websocket.rs). Pi keeps none of it in the message, so the
 *   transport records it for the run that failed.
 * - Sign in with ChatGPT sends the code `subscription_sharing_usage_limit_exceeded`
 *   or only its prose (recorded 2026-10-20), with no reset time. The plan's
 *   polled windows then say which window is full and when it resets.
 *
 * Only structure and fixed strings are read. Provider prose is never injected or logged.
 */
import type { LimitSnapshot } from "../limit-store.ts";
import type { LimitEntry } from "../status-plus-logic.ts";
import { planBilled } from "../plan-billing.ts";
import { providerFamily } from "../provider-family.ts";

const PLAN_FAMILY = "openai-codex";
const MAX_ERROR_CHARS = 32_768;
const PLAN_TYPES = new Set(["usage_limit_reached", "subscription_sharing_usage_limit_exceeded"]);
// Sign in with ChatGPT's code and its prose. Not Pi's "You have hit your ChatGPT usage limit": Pi writes
// it for every Codex 429, so a Codex limit counts only with the structure the transport kept.
const PLAN_TEXT = /\bsubscription_sharing_usage_limit_exceeded\b|has reached their Subscription Sharing usage limit/;
// A ChatGPT Business admin sets this one; it is no plan window and only the admin can raise it.
const WORKSPACE_LIMIT = /workplace_individual_usage_limit|workspace admin/i;
// A weekly window plus margin; a reset further out is a wrong value, not a long wait.
const MAX_RESET_AHEAD_MS = 8 * 24 * 3600_000;
// A reset just behind the clock is a reset that has happened, not a bad value.
const MAX_RESET_BEHIND_MS = 60_000;
const MAX_WINDOW_MINUTES = 31 * 24 * 60;
/** A reading older than this before the rejection cannot say what the rejection hit (Usage Guard's rule). */
export const READING_MAX_AGE_MS = 60_000;
/** A hint describes the response that just failed; an older one belongs to some other request. */
const HINT_MAX_AGE_MS = 30_000;
const HINTS = Symbol.for("pi-extras.plan-limit-hints.v1");

export interface PlanHint {
	readonly type: string;
	readonly resetAtMs?: number;
	readonly windowMinutes?: number;
}
export type ReadingRefusal = "no-reading" | "not-blocked" | "no-reset";
export interface ReadingReset { readonly resetAtMs: number; readonly window: string }

const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** True for a provider whose requests bill the ChatGPT plan; an `openai` API key is not one. */
export function planLimited(provider: string | undefined): boolean {
	return provider !== undefined && providerFamily(provider) === PLAN_FAMILY && planBilled(provider);
}

function resetOf(error: Record<string, unknown>, now: number): number | undefined {
	const at = finite(error.resets_at) ? error.resets_at * 1000 : finite(error.resets_in_seconds) && error.resets_in_seconds >= 0 ? now + error.resets_in_seconds * 1000 : undefined;
	return at !== undefined && at >= now - MAX_RESET_BEHIND_MS && at <= now + MAX_RESET_AHEAD_MS ? at : undefined;
}

/** The plan limit in a parsed error body, or in a WebSocket `error` event that wraps one. */
export function planHintOf(value: unknown, now: number): PlanHint | undefined {
	const root = object(value);
	if (!root) return undefined;
	const error = object(root.error) ?? root;
	const type = [error.type, error.code].find((v): v is string => typeof v === "string" && PLAN_TYPES.has(v));
	if (!type) return undefined;
	const resetAtMs = resetOf(error, now);
	const minutes = error.limit_window_minutes;
	const windowMinutes = finite(minutes) && Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_WINDOW_MINUTES ? minutes : undefined;
	return { type, ...(resetAtMs !== undefined ? { resetAtMs } : {}), ...(windowMinutes !== undefined ? { windowMinutes } : {}) };
}

/** The plan limit in text that holds one JSON object (an HTTP body, or the transport's own error). */
export function parsePlanHint(raw: unknown, now: number): PlanHint | undefined {
	if (typeof raw !== "string" || raw.length > MAX_ERROR_CHARS) return undefined;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (error) {
		// Text that is not JSON is no structured limit; anything else is a fault to report.
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	return planHintOf(parsed, now);
}

/** The fixed strings of a plan usage limit, without a body to read. */
export function isPlanLimitText(raw: unknown): boolean {
	return typeof raw === "string" && raw.length <= MAX_ERROR_CHARS && PLAN_TEXT.test(raw) && !WORKSPACE_LIMIT.test(raw);
}

/** Only the validated fields, so the message keeps no provider prose. */
export function sanitizedPlanError(hint: PlanHint): string {
	return `Provider usage limit: ${JSON.stringify({
		type: hint.type,
		...(hint.resetAtMs !== undefined ? { resets_at: Math.round(hint.resetAtMs / 1000) } : {}),
		...(hint.windowMinutes !== undefined ? { limit_window_minutes: hint.windowMinutes } : {}),
	})}`;
}

function hints(): WeakMap<AbortSignal, { hint: PlanHint; atMs: number }> {
	const global = globalThis as typeof globalThis & { [HINTS]?: WeakMap<AbortSignal, { hint: PlanHint; atMs: number }> };
	return global[HINTS] ??= new WeakMap();
}

/** Pi gives the provider stream and the extension handlers one run signal (see retry-hint.ts). */
export function recordPlanHint(run: AbortSignal | undefined, hint: PlanHint): void {
	if (run) hints().set(run, { hint, atMs: Date.now() });
}

export function takePlanHint(run: AbortSignal | undefined): PlanHint | undefined {
	if (!run) return undefined;
	const held = hints().get(run);
	if (!held) return undefined;
	hints().delete(run);
	return Date.now() - held.atMs <= HINT_MAX_AGE_MS ? held.hint : undefined;
}

/** "5h" for 300 minutes, "7d" for 10080: the footer's labels. */
export function windowName(minutes: number): string {
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function blocked(entry: LimitEntry): boolean {
	return entry.exhausted === true || (entry.allowed === false && finite(entry.usedPct) && entry.usedPct >= 100);
}

/**
 * The reset of the plan window that rejected a request, from the polled
 * readings. A rejection names no window, so only a fresh reading that shows a
 * full window counts. When several are full, the run waits for the last reset.
 */
export function resetFromReadings(snapshot: LimitSnapshot | undefined, rejectedAtMs: number): ReadingReset | ReadingRefusal {
	if (!snapshot) return "no-reading";
	const fresh = snapshot.entries.filter((entry) => entry.stale !== true && entry.approximate !== true
		&& (entry.sampledMs ?? snapshot.atMs) >= rejectedAtMs - READING_MAX_AGE_MS);
	if (fresh.length === 0) return "no-reading";
	const full = fresh.filter(blocked);
	if (full.length === 0) return "not-blocked";
	const resets = full.map((entry) => ({ resetAtMs: entry.resetMs, window: entry.label }));
	let last: ReadingReset | undefined;
	for (const { resetAtMs, window } of resets) {
		if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= rejectedAtMs) return "no-reset";
		if (!last || resetAtMs > last.resetAtMs) last = { resetAtMs, window };
	}
	return last ?? "no-reset";
}
