/**
 * shell-jobs-core: pure helpers and bounded log reading for the shell-jobs
 * extension. No Pi API and no process registry live here so the logic can be
 * unit tested without a session.
 */
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";

export const MAX_LIVE = 8;
export const MAX_RETAINED = 128;
export const NOTIFY_TAIL_LINES = 30;
// Raw byte budgets are sized so the JSON-escaped form fits by construction.
// After sanitizeControl the worst case is a 2x expansion (newline, tab, CR,
// quote, backslash), and log offsets must describe bytes actually represented,
// so a page has to fit rather than be trimmed after the fact.
export const NOTIFY_TAIL_BYTES = 3584;
export const LOG_READ_BYTES = 4096;
export const TEXT_BUDGET_BYTES = 8192;
export const DETAILS_BUDGET_BYTES = 3584;
export const PAYLOAD_CAP_BYTES = 12288;
export const TERM_GRACE_MS = 1000;
export const KILL_WAIT_MS = 1500;
export const MAX_LIST_LIMIT = 20;
export const MAX_COMMAND_BYTES = 65536;
export const MAX_CWD_BYTES = 4096;
// A title is a UI label, so it is held to one short line.
export const MAX_TITLE_BYTES = 80;

const TRUNCATION_NOTICE = "\n[... truncated; read the log path for the rest ...]";

export type StartValidation = { ok: true; command: string; cwd?: string; title?: string } | { ok: false; error: string };

export type LogsParams = { op: "logs"; id: string; offset: number; tail: boolean; bytes: number };
export type KillParams = { op: "kill"; id: string };
export type ListParams = { op: "list"; limit: number };
export type ManageParams = LogsParams | KillParams | ListParams;
export type ManageValidation = { ok: true; params: ManageParams } | { ok: false; error: string };

/** The numbered ids of pi-extras 0.5 and earlier; a resumed session can still name one. */
export function formatJobId(counter: number): string {
	return `j${counter}`;
}

export function parseJobId(value: string): number | null {
	const match = /^j([1-9][0-9]*)$/.exec(value);
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export const MAX_JOB_ID = 24;
/** Lowercase words joined by hyphens; also safe as a log file name. */
export const JOB_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,31}$";
const JOB_ID = new RegExp(JOB_ID_PATTERN);

export function isJobId(value: string): boolean {
	return JOB_ID.test(value);
}

/** `Run e2e tests!` → `run-e2e-tests`, cut at a word boundary to fit. */
export function slugify(text: string, max = MAX_JOB_ID): string {
	const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (slug.length <= max) return slug;
	const cut = slug.slice(0, max);
	const boundary = cut.lastIndexOf("-");
	return (boundary >= max / 3 ? cut.slice(0, boundary) : cut).replace(/-+$/, "");
}

// Launchers that say nothing about what runs; the name comes from what they launch.
const WRAPPERS = new Set(["sudo", "env", "npx", "bunx", "pnpx", "nohup", "time", "exec", "command", "nice", "caffeinate"]);
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** The part of a path or script name that names it: `scripts/serve.mjs` → `serve`. */
const stem = (word: string) => (word.includes("/") || /\.[a-z0-9]+$/i.test(word) ? word.split("/").filter(Boolean).at(-1)!.replace(/\.[^.]+$/, "") : word);

/** A name for an untitled job: the program and what it runs, e.g. `npm test` → `npm-test`. */
export function commandSlug(command: string): string {
	const first = command.trim().split(/[;&|\n]/, 1)[0] ?? "";
	const words = first.split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ""));
	let index = 0;
	while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) || WRAPPERS.has(words[index]!) || words[index]!.startsWith("-"))) index++;
	const program = words[index];
	if (program === undefined) return "";
	const parts = [stem(program)];
	const rest = words.slice(index + 1).filter((word) => !word.startsWith("-"));
	if (rest[0] !== undefined) parts.push(stem(rest[0]));
	// `npm run dev` is named by the script, not by `run`.
	if (RUNNERS.has(parts[0]!) && (rest[0] === "run" || rest[0] === "exec") && rest[1] !== undefined) parts[1] = stem(rest[1]);
	return slugify(parts.join(" "));
}

/**
 * A job's id: its title or command as a short name, made unique among
 * `taken`. A name that reads like an old numbered id gets a prefix, so the two
 * kinds never collide.
 */
export function jobIdFor(title: string | null, command: string, taken: (id: string) => boolean): string {
	let base = (title ? slugify(title) : "") || commandSlug(command) || "job";
	if (parseJobId(base) !== null) base = `job-${base}`;
	if (!taken(base)) return base;
	for (let n = 2; ; n++) {
		const id = `${base}-${n}`;
		if (!taken(id)) return id;
	}
}

export function resolveShellPath(env: NodeJS.ProcessEnv): string {
	const shell = typeof env.SHELL === "string" ? env.SHELL.trim() : "";
	return shell.length > 0 ? shell : "/bin/sh";
}

function badCommand(reason: string): { ok: false; error: string } {
	return { ok: false, error: reason };
}

export function validateStartParams(raw: unknown): StartValidation {
	if (typeof raw !== "object" || raw === null) return badCommand("shell_job_start requires an object argument.");
	const input = raw as { command?: unknown; cwd?: unknown; title?: unknown };
	if (typeof input.command !== "string") return badCommand("shell_job_start requires a string 'command'.");
	if (input.command.trim().length === 0) return badCommand("shell_job_start requires a non-empty 'command'.");
	if (input.command.includes("\u0000")) return badCommand("The command contains a NUL byte.");
	if (Buffer.byteLength(input.command, "utf8") > MAX_COMMAND_BYTES) {
		return badCommand(`The command exceeds ${MAX_COMMAND_BYTES} bytes.`);
	}
	if (input.cwd !== undefined) {
		if (typeof input.cwd !== "string" || input.cwd.length === 0) {
			return badCommand("'cwd' must be a non-empty string when provided.");
		}
		if (input.cwd.includes("\u0000")) return badCommand("'cwd' contains a NUL byte.");
		if (Buffer.byteLength(input.cwd, "utf8") > MAX_CWD_BYTES) {
			return badCommand(`'cwd' exceeds ${MAX_CWD_BYTES} bytes.`);
		}
	}
	let title: string | undefined;
	if (input.title !== undefined) {
		if (typeof input.title !== "string") return badCommand("'title' must be a non-empty string when provided.");
		if (input.title.includes("\u0000")) return badCommand("'title' contains a NUL byte.");
		if (Buffer.byteLength(input.title, "utf8") > MAX_TITLE_BYTES) {
			return badCommand(`'title' exceeds ${MAX_TITLE_BYTES} bytes.`);
		}
		const flat = titlePreview(input.title);
		if (flat === null) return badCommand("'title' must be a non-empty string when provided.");
		title = flat;
	}
	return {
		ok: true,
		command: input.command,
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
		...(title === undefined ? {} : { title }),
	};
}

function readId(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	return isJobId(raw) ? raw : null;
}

function readCount(raw: unknown, fallback: number, max: number): number {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) return fallback;
	return Math.min(raw, max);
}

export function validateManageParams(raw: unknown): ManageValidation {
	if (typeof raw !== "object" || raw === null) return { ok: false, error: "shell_job requires an object argument." };
	const input = raw as Record<string, unknown>;

	if (input.op === "list") {
		return { ok: true, params: { op: "list", limit: readCount(input.limit, MAX_LIST_LIMIT, MAX_LIST_LIMIT) } };
	}

	if (input.op !== "logs" && input.op !== "kill") {
		return { ok: false, error: "'op' must be one of: list, logs, kill." };
	}

	const id = readId(input.id);
	if (id === null) return { ok: false, error: `'op: ${input.op}' requires a job id, such as run-tests.` };

	if (input.op === "kill") {
		return { ok: true, params: { op: "kill", id } };
	}

	const offset = readCount(input.offset, 0, Number.MAX_SAFE_INTEGER);
	const tail = typeof input.tail === "boolean" ? input.tail : input.offset === undefined;
	if (tail && offset > 0) return { ok: false, error: "'offset' cannot be combined with 'tail: true'." };
	const bytes = readCount(input.bytes, LOG_READ_BYTES, LOG_READ_BYTES);
	return { ok: true, params: { op: "logs", id, offset, tail, bytes } };
}

/** Strip control bytes that corrupt terminal or model context, keeping newline and tab. */
export function sanitizeControl(text: string): string {
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * One-line preview of a command for lists, widget rows and completion details.
 * Newlines, tabs and runs of spaces collapse to one space so a multi-line
 * script occupies a single row, and control bytes are stripped first.
 */
export function commandPreview(command: string, maxBytes: number): string {
	return utf8Head(sanitizeControl(command).replace(/\s+/g, " ").trim(), maxBytes);
}

/**
 * A job title flattened to one bounded line, or null when it is absent, not a
 * string, or blank. Renderers see the model's raw arguments, so they apply
 * this too rather than trusting that validation ran.
 */
export function titlePreview(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const flat = commandPreview(raw, MAX_TITLE_BYTES);
	return flat.length > 0 ? flat : null;
}

/** Truncate a string to at most maxBytes UTF-8 bytes without splitting a character. */
export function utf8Head(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let total = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (total + size > maxBytes) break;
		total += size;
		end += char.length;
	}
	return text.slice(0, end);
}

/**
 * Keep the last maxBytes UTF-8 bytes without splitting a character. Used to
 * bound log tails, where the newest output (usually the actual error) matters
 * more than the oldest.
 */
export function utf8Tail(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const chars = [...text];
	let total = 0;
	let start = chars.length;
	for (let index = chars.length - 1; index >= 0; index--) {
		const size = Buffer.byteLength(chars[index], "utf8");
		if (total + size > maxBytes) break;
		total += size;
		start = index;
	}
	return chars.slice(start).join("");
}

/**
 * Bytes the text occupies inside a JSON string, counting escaping. Only the
 * characters sanitizeControl leaves behind can appear, but quote, backslash,
 * newline, carriage return, and tab each double.
 */
export function jsonEscapedBytes(text: string): number {
	let bytes = 0;
	for (const char of text) {
		bytes += char === '"' || char === "\\" || char === "\n" || char === "\r" || char === "\t" ? 2 : Buffer.byteLength(char, "utf8");
	}
	return bytes;
}

export interface TailResult {
	text: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	outputLines: number;
	lastLinePartial: boolean;
}

/**
 * Keep the last lines/bytes of text, mirroring how the built-in bash tool
 * truncates: whole lines only, byte limit honored, and a single oversized last
 * line returned as a trailing fragment so the final diagnostic still shows.
 */
export function tailText(text: string, maxBytes: number, maxLines: number): TailResult {
	const totalBytes = Buffer.byteLength(text, "utf8");
	const lines = text.length === 0 ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { text, truncated: false, truncatedBy: null, outputLines: totalLines, lastLinePartial: false };
	}
	const kept: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;
	for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index--) {
		const lineBytes = Buffer.byteLength(lines[index], "utf8") + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (kept.length === 0) {
				kept.unshift(utf8Tail(lines[index], maxBytes));
				bytes = Buffer.byteLength(kept[0], "utf8");
				lastLinePartial = true;
			}
			break;
		}
		kept.unshift(lines[index]);
		bytes += lineBytes;
	}
	if (kept.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";
	return { text: kept.join("\n"), truncated: true, truncatedBy, outputLines: kept.length, lastLinePartial };
}

/** Human-readable size, matching the built-in tool formatting. */
/**
 * Elapsed time for tool rows and completion messages, in the same shape as
 * Pi's built-in bash footer (0.86+): seconds under a minute, then minutes and
 * hours, so a long job never reads as thousands of seconds.
 */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Matches a duration produced by formatDuration, old bare-seconds form included. */
export const DURATION_PATTERN = "(?:\\d+h )?(?:\\d+m )?\\d+(?:\\.\\d+)?s";

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface LogLineCount {
	totalLines: number;
	lastLineBytes: number;
}

/** Count a log's lines and final-line size by streaming it, for truncation notices. */
export async function countLogLines(logPath: string): Promise<LogLineCount> {
	let newlines = 0;
	let totalBytes = 0;
	let currentLineBytes = 0;
	let endsWithNewline = false;
	for await (const chunk of createReadStream(logPath)) {
		const buffer = chunk as Buffer;
		totalBytes += buffer.length;
		for (const byte of buffer) {
			if (byte === 0x0a) {
				newlines += 1;
				currentLineBytes = 0;
				endsWithNewline = true;
			} else {
				currentLineBytes += 1;
				endsWithNewline = false;
			}
		}
	}
	return { totalLines: totalBytes === 0 ? 0 : newlines + (endsWithNewline ? 0 : 1), lastLineBytes: currentLineBytes };
}

/**
 * The tail of a log, with the same truncation notice wording the built-in bash
 * tool uses. Line numbers refer to the whole log, so the leading partial line
 * of a mid-file window is dropped before anything is counted.
 */
export const TAIL_WINDOW_BYTES = 64 * 1024;

export interface LogTail {
	text: string;
	truncated: boolean;
	notice: string | null;
	totalLines: number;
}

export interface LogWindow {
	text: string;
	/** True when the log is longer than the window and earlier output was left out. */
	truncated: boolean;
	totalBytes: number;
}

/**
 * The last maxBytes of a log, decoded and started on a line boundary so every
 * line shown is a whole one. A missing log reads as empty: callers render
 * from this on a timer and must not throw mid-paint.
 */
export function readLogWindow(logPath: string, maxBytes: number): LogWindow {
	let totalBytes: number;
	try {
		totalBytes = statSync(logPath).size;
	} catch {
		return { text: "", truncated: false, totalBytes: 0 };
	}
	const windowStart = Math.max(0, totalBytes - maxBytes);
	let text = decodeWindow(readRange(logPath, windowStart, totalBytes - windowStart));
	if (windowStart > 0 && text.length > 0) {
		const newline = text.indexOf("\n");
		text = newline === -1 ? "" : text.slice(newline + 1);
	}
	return { text, truncated: windowStart > 0, totalBytes };
}

export async function readLogTail(logPath: string, maxBytes: number, maxLines: number): Promise<LogTail> {
	const window = readLogWindow(logPath, TAIL_WINDOW_BYTES);
	const tail = tailText(window.text, maxBytes, maxLines);
	const truncated = tail.truncated || window.truncated;
	if (!truncated) return { text: tail.text, truncated: false, notice: null, totalLines: tail.outputLines };
	const counts = await countLogLines(logPath);
	const endLine = counts.totalLines;
	const startLine = Math.max(1, endLine - tail.outputLines + 1);
	let notice: string;
	if (tail.lastLinePartial) {
		notice = `[Showing last ${formatSize(Buffer.byteLength(tail.text, "utf8"))} of line ${endLine} (line is ${formatSize(counts.lastLineBytes)}). Full output: ${logPath}]`;
	} else if (tail.truncatedBy === "bytes") {
		notice = `[Showing lines ${startLine}-${endLine} of ${counts.totalLines} (${formatSize(maxBytes)} limit). Full output: ${logPath}]`;
	} else {
		notice = `[Showing lines ${startLine}-${endLine} of ${counts.totalLines}. Full output: ${logPath}]`;
	}
	return { text: tail.text, truncated: true, notice, totalLines: counts.totalLines };
}

export function capPayload(text: string): string {
	if (jsonEscapedBytes(text) <= TEXT_BUDGET_BYTES) return text;
	const budget = TEXT_BUDGET_BYTES - jsonEscapedBytes(TRUNCATION_NOTICE);
	let used = 0;
	let end = 0;
	for (const char of text) {
		const size = jsonEscapedBytes(char);
		if (used + size > budget) break;
		used += size;
		end += char.length;
	}
	return text.slice(0, end) + TRUNCATION_NOTICE;
}

export interface LogPage {
	text: string;
	offset: number;
	nextOffset: number;
	eof: boolean;
	totalBytes: number;
}

function readRange(logPath: string, position: number, length: number): Buffer {
	if (length <= 0) return Buffer.alloc(0);
	const buffer = Buffer.alloc(length);
	const fd = openSync(logPath, "r");
	try {
		const read = readSync(fd, buffer, 0, length, position);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

function decodeWindow(buffer: Buffer): string {
	// A window can begin or end mid-character; drop the replacement chars at the edges.
	return sanitizeControl(buffer.toString("utf8")).replace(/^\uFFFD+|\uFFFD+$/g, "");
}

/**
 * Decode a window, shrinking it until the escaped text fits the response
 * budget. Invalid UTF-8 expands up to 3x (each bad byte becomes U+FFFD), so a
 * byte clamp alone cannot guarantee the budget, and the shrink has to happen
 * before offsets are reported or pagination skips the bytes that were dropped.
 */
function readFittingWindow(logPath: string, start: number, length: number, fromEnd: boolean): { text: string; length: number } {
	let size = length;
	let text = decodeWindow(readRange(logPath, start, size));
	while (jsonEscapedBytes(text) > TEXT_BUDGET_BYTES && size > 1) {
		size = Math.max(1, Math.floor(size / 2));
		const windowStart = fromEnd ? start + length - size : start;
		text = decodeWindow(readRange(logPath, windowStart, size));
	}
	return { text, length: size };
}

export function readLogPage(logPath: string, options: { offset: number; bytes: number; tail: boolean }): LogPage {
	const totalBytes = statSync(logPath).size;
	const budget = Math.max(1, Math.min(options.bytes, LOG_READ_BYTES));
	if (options.tail) {
		const length = Math.min(budget, totalBytes);
		if (length === 0) return { text: "", offset: totalBytes, nextOffset: totalBytes, eof: true, totalBytes };
		const fitted = readFittingWindow(logPath, totalBytes - length, length, true);
		return { text: fitted.text, offset: totalBytes - fitted.length, nextOffset: totalBytes, eof: true, totalBytes };
	}
	const start = Math.min(options.offset, totalBytes);
	const length = Math.min(budget, totalBytes - start);
	if (length === 0) return { text: "", offset: start, nextOffset: start, eof: true, totalBytes };
	const fitted = readFittingWindow(logPath, start, length, false);
	const nextOffset = start + fitted.length;
	return {
		text: fitted.text,
		offset: start,
		nextOffset,
		eof: nextOffset >= totalBytes,
		totalBytes,
	};
}
