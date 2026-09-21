/** Content-free, throttled failure notes for Pi extensions. */
import { appendFile } from "node:fs";

const lastWrite = new Map<string, number>();
const THROTTLE_MS = 60_000;

/**
 * Append one line per file per minute at most. Messages carry no config or
 * payload content, so the log is safe to read aloud; the mode keeps it private.
 */
export function operationalError(logFile: string, tag: string, message: string): void {
	const now = Date.now();
	if (now - (lastWrite.get(logFile) ?? 0) < THROTTLE_MS) return;
	lastWrite.set(logFile, now);
	appendFile(logFile, `[${tag}] ${new Date().toISOString()} ${message}\n`, { mode: 0o600 }, () => {});
}
