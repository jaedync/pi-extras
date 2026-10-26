/**
 * update.log: one sanitized line per updater decision. Bounded: past the
 * size limit the older half is dropped.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { sanitize } from "./run.ts";

export const LOG_MAX_BYTES = 256 * 1024;

export type Log = (message: string) => void;

export function fileLog(file: string, now: () => number = Date.now): Log {
	return (message) => {
		try {
			appendFileSync(file, `${new Date(now()).toISOString()} [${process.pid}] ${sanitize(message).replace(/\s*\n\s*/g, " ")}\n`, { mode: 0o600 });
			if (statSync(file).size > LOG_MAX_BYTES) {
				const text = readFileSync(file, "utf8");
				const keep = text.slice(text.indexOf("\n", text.length / 2) + 1);
				writeFileSync(file, keep, { mode: 0o600 });
			}
		} catch {
			// The log is a record, not a dependency: an unwritable log must not stop an update.
		}
	};
}
