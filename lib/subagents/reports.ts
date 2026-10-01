/** Full reports stay beside the session; completion messages only carry previews. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentRecord } from "./types.ts";

type ReportIO = Pick<typeof fs, "statSync" | "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "linkSync" | "unlinkSync">;
type Warn = (message: string) => void;
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

function warnSafely(warn: Warn, message: string): void {
	try { warn(message); }
	catch {
		// Pi invalidates UI contexts on reload; a warning must not strand a report's waiters.
	}
}

export function reportFilePath(sessionFile: string, run: number): string {
	if (!Number.isSafeInteger(run) || run < 1) throw new Error("A report needs a positive run number.");
	return `${sessionFile.replace(/\.jsonl$/, "")}.run-${run}.report.md`;
}

function writeExclusive(file: string, text: string, mode: number, io: ReportIO, warn: Warn): void {
	const fd = io.openSync(file, "wx", mode);
	let closing = false;
	try {
		io.writeFileSync(fd, text, "utf8");
		io.fsyncSync(fd);
		closing = true;
		io.closeSync(fd);
	} catch (error) {
		try { if (!closing) io.closeSync(fd); }
		catch (closeError) { warnSafely(warn, `subagents: could not close report ${file}: ${String(closeError)}`); }
		try { io.unlinkSync(file); }
		catch (cleanupError) { warnSafely(warn, `subagents: could not remove partial report ${file}: ${String(cleanupError)}`); }
		throw error;
	}
}

/** Hard-link publication is atomic; exclusive creation preserves no-overwrite on filesystems without links. */
export function writeReport(sessionFile: string, run: number, text: string, io: ReportIO = fs, warn: Warn = console.warn): string {
	const file = reportFilePath(sessionFile, run);
	const temp = `${file}.${randomUUID()}.tmp`;
	const mode = io.statSync(sessionFile).mode & 0o600;
	writeExclusive(temp, text, mode, io, warn);
	try {
		try { io.linkSync(temp, file); }
		catch (error) {
			if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			writeExclusive(file, text, mode, io, warn);
		}
		return file;
	} finally {
		try { io.unlinkSync(temp); }
		catch (error) { warnSafely(warn, `subagents: could not remove temporary report ${temp}: ${String(error)}`); }
	}
}

/** Disk trouble must not prevent delivery of the report or leave a stale path in it. */
export function saveReport(record: AgentRecord, warn: Warn = console.warn): AgentRecord {
	if (!record.report || !record.sessionFile) return { ...record };
	try {
		return { ...record, reportFile: writeReport(record.sessionFile, record.runs, record.report, fs, warn) };
	} catch (error) {
		warnSafely(warn, `subagents: could not write report for ${record.name}, run ${record.runs}: ${error instanceof Error ? error.message : String(error)}`);
		return { ...record, reportFile: undefined };
	}
}

/** Restored records from older versions may not carry a report path. Run numbers can have gaps. */
export function latestReportFile(sessionFile: string): string | undefined {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dirname(sessionFile), { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const prefix = `${basename(sessionFile).replace(/\.jsonl$/, "")}.run-`;
	const suffix = ".report.md";
	const runs = entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
		.map((entry) => ({ name: entry.name, run: entry.name.slice(prefix.length, -suffix.length) }))
		.filter((entry) => /^[1-9]\d*$/.test(entry.run) && Number.isSafeInteger(Number(entry.run)))
		.sort((a, b) => Number(b.run) - Number(a.run));
	return runs[0] ? join(dirname(sessionFile), runs[0].name) : undefined;
}
