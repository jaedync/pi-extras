/** Content-free operational notes for Pi extensions. */
import { appendFileSync } from "node:fs";

const lastWrite = new Map<string, number>();
/** Enough of an error to find its cause in a log. */
const ERROR_TEXT_MAX = 200;

/** An error's name and message, cut short: a log line, not a dump. */
export function errorText(error: unknown): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.slice(0, ERROR_TEXT_MAX);
}
const THROTTLE_MS = 60_000;

/**
 * Append one line per file per minute at most. Messages carry no config or
 * payload content, so the log is safe to read aloud; the mode keeps it private.
 * The write is synchronous: an async append still in flight could land after a
 * shutdown has removed its directory, and throttling keeps the cost negligible.
 */
export function operationalError(logFile: string, tag: string, message: string): void {
	const now = Date.now();
	if (now - (lastWrite.get(logFile) ?? 0) < THROTTLE_MS) return;
	lastWrite.set(logFile, now);
	operationalLine(logFile, `[${tag}] ${new Date().toISOString()} ${message}`);
}

/** Decisions need one record each, even when several sessions compact together. */
export function operationalLine(logFile: string, line: string): void {
	try {
		appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
	} catch {
		// Logging is best effort; a missing or unwritable directory must not break the caller.
	}
}
