/**
 * Transport and proxy failures that clear within minutes: a dropped connection, a stalled
 * upstream, a busy local relay, a gateway with no backend. Pi retries them for about 14 s and
 * then the run waits for a person; unattended runs and subagents waited hours. transient.ts owns
 * them with the rate-limit schedule and budget. Quotas and billing stay excluded there.
 *
 * Each pattern matches the transport's own report, never prose that only mentions one: the
 * SDKs send these as the whole message, and a tool error quoted in a reply must not match.
 */
export type ConnectionCause = "dropped" | "slow" | "busy" | "down";

// Anthropic and OpenAI SDK connection errors, undici's mid-body abort, and Node socket codes.
const DROPPED = /^(?:Connection error\.?|terminated)$|^(?:read|write|connect) (?:ECONNRESET|ECONNREFUSED|EPIPE)\b|^socket hang up$/i;
// The OpenAI SDK's timeout, and Meridian's report of an upstream that sent nothing for 90 s.
const SLOW = /^Request timed out\.?$|"type"\s*:\s*"upstream_timeout"/i;
const BUSY = /"type"\s*:\s*"overloaded_error"/;
// A gateway also answers 5xx for requests it will never serve, so the body must say why.
const GATEWAY = /^50[234]\b/;
const DOWN = /unavailable|overloaded|bad gateway|gateway time-?out/i;
// An expired or wrong key fails every time, whatever status a gateway wraps it in.
const AUTH = /api_key_expired|authentication_error|permission_error|invalid.?api.?key|unauthori[sz]ed|^40[13]\b/i;
// A full context fails the same way on every retry; Pi compacts instead.
const OVERFLOW = /context.?window|context.?length|prompt is too long/i;
// A long hint would hold an unattended run; the budget still decides whether to wait at all.
const MAX_HINT_SECONDS = 60;

/** Why the transport failed, or undefined when the text is not one of its reports. */
export function connectionCause(text: string): ConnectionCause | undefined {
	const trimmed = text.trim();
	if (AUTH.test(trimmed) || OVERFLOW.test(trimmed)) return undefined;
	if (DROPPED.test(trimmed)) return "dropped";
	if (SLOW.test(trimmed)) return "slow";
	if (BUSY.test(trimmed)) return "busy";
	if (GATEWAY.test(trimmed) && DOWN.test(trimmed)) return "down";
	return undefined;
}

const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** `retry_after` seconds from a JSON error body, as Meridian sends with overloaded_error. */
export function connectionHint(text: string): number | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
	const root = object(parsed);
	const seconds = object(root?.error)?.retry_after ?? root?.retry_after;
	return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, MAX_HINT_SECONDS) : undefined;
}
