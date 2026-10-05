/**
 * Model fallback. A run that fails because its model can't serve it (a used-up
 * quota, a rate limit the recovery did not wait out, an overloaded provider,
 * missing credentials, a model that is gone) goes on, in the same run, on the
 * next model of `subagents.fallbackModels`. Any other failure, such as a full
 * context or a bad request, is the run's own and fails as before.
 *
 * Quota and rate-limit errors are told apart the way rate-limit-recovery
 * does, so a child guard's report and a raw provider error read the same.
 */
import { SETUP_FAILURE } from "../rate-limit-recovery/child.ts";
import { parseRateLimit } from "../rate-limit-recovery/core.ts";
import { isQuotaError, isTemporaryLimitReport, isTransientRateLimit } from "../rate-limit-recovery/transient.ts";
import { type ModelChoice, resolveModel } from "./models.ts";
import type { AgentRecord, FailureKind, FallbackStep } from "./types.ts";

export interface Failure {
	kind: FailureKind;
	reason: string;
}

// A full context is the run's own problem: another model would hit it too, or a compaction fixes it.
const OVERFLOW = /context.?length|context.?window|prompt is too long|input is too long|too many tokens|maximum context/i;
const OVERLOADED = /overloaded|high demand|service.?unavailable|temporarily unavailable|bad gateway|gateway timeout|internal server error|server_error|\b(?:502|503|504|529)\b/i;
const CREDENTIALS = /api key|unauthori[sz]ed|\b40[13]\b|forbidden|authentication|credential|(?:token|session|login)\b.{0,40}\bexpired|expired.{0,40}\b(?:token|credential)|not logged in|\/login\b/i;
const NOT_FOUND = /unknown model|model_not_found|no such model|model\b.{0,60}\b(?:not found|does not exist|is not available)/i;
/** Failures that are the provider's as a whole, so its other models would fail the same way. */
const PROVIDER_WIDE: ReadonlySet<FailureKind> = new Set(["quota", "credentials"]);

/** Why the model could not serve the run, or undefined when the failure is the run's own. */
export function classifyFailure(error: string): Failure | undefined {
	// The child's quota guard failed to install: a setup problem that says "quota" without being one.
	if (OVERFLOW.test(error) || error === SETUP_FAILURE) return undefined;
	if (isTemporaryLimitReport(error)) return { kind: "rate-limit", reason: "rate limit" };
	if (isQuotaError(error)) return { kind: "quota", reason: /usage limit/i.test(error) ? "usage limit reached" : "quota exceeded" };
	if (parseRateLimit(error) !== undefined || isTransientRateLimit({ stopReason: "error", errorMessage: error })) return { kind: "rate-limit", reason: "rate limit" };
	if (OVERLOADED.test(error)) return { kind: "overloaded", reason: "provider overloaded or unavailable" };
	if (CREDENTIALS.test(error)) return { kind: "credentials", reason: "missing or expired credentials" };
	if (NOT_FOUND.test(error)) return { kind: "not-found", reason: "model not found" };
	return undefined;
}

const providerOf = (ref: string): string => ref.split("/")[0] ?? ref;

/**
 * `fallbackModels` as model references, in order: unset means the default
 * subagent model, `[]` turns fallback off. Names outside the allowed scope
 * are skipped with a warning.
 */
export function fallbackChain(configured: readonly string[] | undefined, defaultModel: string | null, allowed: readonly ModelChoice[], warn: (message: string) => void): string[] {
	const wanted = configured ?? (defaultModel ? [defaultModel] : []);
	const refs = wanted.flatMap((query) => {
		const resolved = resolveModel(query, allowed);
		if (resolved.ok) return [resolved.choice.ref];
		warn(`subagents.fallbackModels: ${resolved.error} It is skipped.`);
		return [];
	});
	return [...new Set(refs)];
}

/** The next model to try: not tried in this run, and not of a provider whose quota or credentials failed in it. */
function nextModel(failed: string, failure: Failure, chain: readonly string[], steps: readonly FallbackStep[]): string | undefined {
	const tried = new Set([failed, ...steps.flatMap((step) => [step.from, step.to])]);
	const blocked = new Set([...steps, { from: failed, kind: failure.kind }].filter((step) => PROVIDER_WIDE.has(step.kind)).map((step) => providerOf(step.from)));
	return chain.find((ref) => !tried.has(ref) && !blocked.has(providerOf(ref)));
}

const sentence = (text: string): string => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

export type FallbackPlan = { ok: true; step: FallbackStep } | { ok: false; error: string };

/** Whether this failure moves the run to a fallback model, or the error it fails with: that one, plus why no fallback took it on. */
export function planFallback(record: Pick<AgentRecord, "model" | "runs" | "fallbacks">, error: string, chain: readonly string[], now: number): FallbackPlan {
	const failure = chain.length > 0 ? classifyFailure(error) : undefined;
	if (!failure) return { ok: false, error };
	const steps = (record.fallbacks ?? []).filter((step) => step.run === record.runs);
	const next = nextModel(record.model, failure, chain, steps);
	if (next) return { ok: true, step: { run: record.runs, from: record.model, to: next, kind: failure.kind, reason: failure.reason, at: now } };
	const why = steps.length > 0 ? "No fallback model is left to try." : "No fallback model is available; add one to subagents.fallbackModels.";
	return { ok: false, error: `${sentence(error)} ${why}` };
}

/** What the child reads first on its fallback model, in one line. */
export function fallbackNote(step: FallbackStep): string {
	return `Your model ${step.from} failed: ${step.reason}. You now run on ${step.to}. Check the current state of files before you continue your work.`;
}
