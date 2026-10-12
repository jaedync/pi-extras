/** Content-free operational notes for Pi extensions. */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";

const lastWrite = new Map<string, number>();
const THROTTLE_MS = 60_000;
/** The start of a message that names its kind ("footer render failed"), for the throttle. */
const KIND_MAX = 80;
/** Enough of an error to find its cause in a log. */
const ERROR_TEXT_MAX = 200;
const FRAME_MAX = 160;

/** What a message is about: the text before its first colon. */
function kindOf(message: string): string {
	const colon = message.indexOf(":");
	return (colon < 0 ? message : message.slice(0, colon)).slice(0, KIND_MAX);
}

/**
 * Append one line per file and kind of message per minute at most, so one
 * failure that repeats on every frame does not hide another. Messages carry no
 * config or payload content, so the log is safe to read aloud; the mode keeps
 * it private. The write is synchronous: an async append still in flight could
 * land after a shutdown has removed its directory, and throttling keeps the
 * cost negligible.
 */
export function operationalError(logFile: string, tag: string, message: string): void {
	const now = Date.now();
	const key = `${logFile}\u0000${tag}\u0000${kindOf(message)}`;
	if (now - (lastWrite.get(key) ?? 0) < THROTTLE_MS) return;
	lastWrite.set(key, now);
	operationalLine(logFile, `[${tag}] ${new Date().toISOString()} ${message}`);
}

/** The first "at" line of a stack, with the home directory shown as ~. */
function firstFrame(stack: unknown): string | undefined {
	if (typeof stack !== "string") return undefined;
	const frame = stack.split("\n").find((line) => line.trimStart().startsWith("at "));
	return frame?.trim().replace("file://", "").split(homedir()).join("~").slice(0, FRAME_MAX);
}

/** An error's name, message and where it came from, cut short: a log line, not a dump. */
export function errorText(error: unknown): string {
	try {
		if (!(error instanceof Error)) return String(error).slice(0, ERROR_TEXT_MAX);
		const where = firstFrame(error.stack);
		return `${`${error.name}: ${error.message}`.slice(0, ERROR_TEXT_MAX)}${where ? ` (${where})` : ""}`;
	} catch {
		// A value with no usable toString (Object.create(null)) or a getter that throws.
		return "an error that cannot be shown as text";
	}
}

/** Decisions need one record each, even when several sessions compact together. */
export function operationalLine(logFile: string, line: string): void {
	try {
		appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
	} catch {
		// Logging is best effort; a missing or unwritable directory must not break the caller.
	}
}
