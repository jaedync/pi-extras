/**
 * Text facts the tool rows show, read from the results Pi's built-in tools
 * already return. Nothing here styles text or touches the terminal. The
 * patterns mirror the wording in Pi's bash, read, grep, find and ls tools.
 */

export type ShellOutcome =
	| { readonly kind: "ok" }
	| { readonly kind: "exit"; readonly code: number }
	| { readonly kind: "timeout"; readonly seconds: number }
	| { readonly kind: "aborted" }
	| { readonly kind: "killed" }
	| { readonly kind: "failed" };

export interface ShellOutput {
	readonly body: string;
	readonly outcome: ShellOutcome;
	/** The truncation notice, without brackets, when output was cut. */
	readonly notice?: string;
}

const SHELL_STATUS = /(?:^|\n\n)(?:Command exited with code (\d+)|Command timed out after (\d+) seconds|(Command aborted)|(Command terminated without an exit code))$/;
const SHELL_NOTICE = /(?:^|\n\n)\[(Showing [^\n]*Full output: [^\n]*)\]$/;
const TRAILING_NOTICE = /\n\n\[([^\n]*)\]$/;
/** C0 controls except tab and newline, DEL and C1: an escape in agent text must not reach the terminal. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function shellOutcome(match: RegExpExecArray): ShellOutcome {
	if (match[1] !== undefined) return { kind: "exit", code: Number(match[1]) };
	if (match[2] !== undefined) return { kind: "timeout", seconds: Number(match[2]) };
	return match[3] !== undefined ? { kind: "aborted" } : { kind: "killed" };
}

/** Splits a bash result into its output, how the command ended and any truncation notice. */
export function parseShellOutput(text: string, isError: boolean): ShellOutput {
	let body = text;
	let outcome: ShellOutcome = isError ? { kind: "failed" } : { kind: "ok" };
	// Pi appends a status only when the command failed; on success those words are real output.
	const status = isError ? SHELL_STATUS.exec(body) : null;
	if (status) {
		outcome = shellOutcome(status);
		body = body.slice(0, status.index);
	}
	const notice = SHELL_NOTICE.exec(body);
	if (notice) body = body.slice(0, notice.index);
	if (body === "(no output)") body = "";
	return notice ? { body, outcome, notice: notice[1]! } : { body, outcome };
}

export function sanitize(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, "");
}

/** A command as display lines, without trailing blank lines. */
export function commandLines(command: string): string[] {
	const lines = sanitize(command).split("\n");
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}

export interface DiffStats { readonly added: number; readonly removed: number }

/** Counts changed lines in the diff Pi's edit tool returns (`+12 text`, `-12 text`, ` 12 text`). */
export function diffStats(diff: string): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (/^\+\s*\d+ /.test(line)) added++;
		else if (/^-\s*\d+ /.test(line)) removed++;
	}
	return { added, removed };
}

function splitNotice(text: string): { body: string; notice?: string } {
	const match = TRAILING_NOTICE.exec(text);
	return match ? { body: text.slice(0, match.index), notice: match[1]! } : { body: text };
}

export interface GrepSummary { readonly matches: number; readonly files: number; readonly notice?: string }

/** Matches read `path:line: text`; context lines read `path-line- text`. */
export function grepSummary(text: string): GrepSummary {
	const { body, notice } = splitNotice(text.trim());
	const files = new Set<string>();
	let matches = 0;
	for (const line of body.split("\n")) {
		const match = /^(.*?):(\d+): /.exec(line);
		if (!match) continue;
		matches++;
		files.add(match[1]!);
	}
	return notice ? { matches, files: files.size, notice } : { matches, files: files.size };
}

export interface ListSummary { readonly entries: number; readonly dirs: number; readonly notice?: string }

const EMPTY_LISTS = new Set(["No files found matching pattern", "(empty directory)"]);

export function listSummary(text: string): ListSummary {
	const { body, notice } = splitNotice(text.trim());
	const lines = EMPTY_LISTS.has(body.trim()) ? [] : body.split("\n").filter((line) => line.trim() !== "");
	const dirs = lines.filter((line) => line.endsWith("/")).length;
	return notice ? { entries: lines.length, dirs, notice } : { entries: lines.length, dirs };
}

export interface ReadSummary {
	readonly lines: number;
	/** Lines in the whole file, when the read covered only part of it. */
	readonly total?: number;
	/** The first requested line alone was over the size limit, so nothing was returned. */
	readonly longLine?: true;
}

const countLines = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

export function readSummary(text: string): ReadSummary {
	if (/^\[Line \d+ is .*exceeds .* limit/.test(text)) return { lines: 0, longLine: true };
	const { body, notice } = splitNotice(text);
	const showing = notice && /^Showing lines (\d+)-(\d+) of (\d+)/.exec(notice);
	if (showing) return { lines: Number(showing[2]) - Number(showing[1]) + 1, total: Number(showing[3]) };
	const more = notice && /^(\d+) more lines in file\. Use offset=(\d+)/.exec(notice);
	if (more) return { lines: countLines(body), total: Number(more[2]) - 1 + Number(more[1]) };
	// Any other bracketed tail is file content.
	return { lines: countLines(text) };
}
