/**
 * External commands for the updater: argument arrays only (no shell), no
 * stdin, a time limit, and git set to never ask for a password. Output stays
 * in memory; only `firstLine` (sanitized) may reach a log or the state file,
 * because raw output can hold credential URLs.
 */
import { spawn } from "node:child_process";

export interface RunOptions {
	readonly cwd?: string;
	readonly timeoutMs: number;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly error?: string;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Enough for `npm view`, `git ls-remote` of a big repository, and an install's error text. */
const OUTPUT_MAX = 4 * 1024 * 1024;
const LINE_MAX = 200;
const KILL_GRACE_MS = 2_000;

/** Set for every command: never ask on a terminal, never wait on a host key or a password. */
export const QUIET_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
};

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		// The command runs in its own group, so npm's and git's children stop with it.
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export const runCommand: Runner = (command, args, options) =>
	new Promise((resolveResult) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, ...QUIET_ENV },
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid, "SIGTERM");
			setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
		}, options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < OUTPUT_MAX) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < OUTPUT_MAX) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveResult({ code: null, stdout, stderr, timedOut, error: `${(error as NodeJS.ErrnoException).code ?? "error"}: ${sanitize(error.message)}` });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveResult({ code: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
		});
	});

const SECRET_PATTERNS: readonly [RegExp, string][] = [
	// user:password@ or token@ in a URL.
	[/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@"],
	[/(_auth(?:Token)?\s*=\s*)\S+/gi, "$1***"],
	[/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/g, "$1***"],
	// "token <value>" only for a long value, so "unexpected token in JSON" stays readable.
	[/(\btoken\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1***"],
	// Well-known token shapes: GitHub, GitLab, npm, Slack, OpenAI-like keys.
	[/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g, "***"],
];

/** Removes credentials from text that may reach a log or the state file. */
export function sanitize(text: string): string {
	return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** One sanitized line of a command's output: the first that names an error, else the last. */
export function firstLine(text: string): string {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const line = lines.find((candidate) => /\b(error|fatal|failed|ERR!)/i.test(candidate)) ?? lines.at(-1) ?? "";
	return sanitize(line).slice(0, LINE_MAX);
}

/** "exit 1: npm error code E404", for the log and `lastError`. */
export function describeFailure(result: RunResult): string {
	if (result.timedOut) return "timed out";
	if (result.error) return result.error.slice(0, LINE_MAX);
	return `exit ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout)}`;
}
