/**
 * The transport sees a 429's Retry-After header; the rate-limit decision only sees the finalized
 * message. Pi gives the provider stream and extension handlers the same run signal, so keying by
 * it keeps a hint inside the one run that received it, even with parallel sessions on a provider.
 */
const SHARED = Symbol.for("pi-extras.retry-hints.v2");
// A hint describes the response that just failed; an older one belongs to some other request.
const MAX_AGE_MS = 30_000;
const MAX_SECONDS = 24 * 3600;
const SECONDS = /^\d+(?:\.\d+)?$/;

interface Hint { readonly seconds: number; readonly atMs: number }

function hints(): WeakMap<AbortSignal, Hint> {
	const global = globalThis as typeof globalThis & { [SHARED]?: WeakMap<AbortSignal, Hint> };
	return global[SHARED] ??= new WeakMap<AbortSignal, Hint>();
}

function bounded(seconds: number): number | undefined {
	return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_SECONDS ? seconds : undefined;
}

/** Seconds from `retry-after-ms`, or `retry-after` as seconds or an HTTP date. */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
	const ms = headers.get("retry-after-ms")?.trim();
	if (ms && SECONDS.test(ms)) return bounded(Number(ms) / 1000);
	const value = headers.get("retry-after")?.trim();
	if (!value) return undefined;
	if (SECONDS.test(value)) return bounded(Number(value));
	if (!/[a-z]/i.test(value)) return undefined;
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : bounded(Math.max(0, (at - now) / 1000));
}

export function recordRetryHint(run: AbortSignal | undefined, seconds: number): void {
	if (run) hints().set(run, { seconds, atMs: Date.now() });
}

export function takeRetryHint(run: AbortSignal | undefined): number | undefined {
	if (!run) return undefined;
	const hint = hints().get(run);
	if (!hint) return undefined;
	hints().delete(run);
	return Date.now() - hint.atMs <= MAX_AGE_MS ? hint.seconds : undefined;
}
