/**
 * A check: a shell command the harness runs when a child's run ends normally,
 * before its report goes up, so the parent reads evidence from the harness
 * and not only the child's claim. It runs through the child's own bash tool
 * (child.ts): in its directory, with its shell settings, project trust and
 * sandbox, with no stdin and a timeout, and its whole process group killed
 * on a timeout or a stop. Files it changes count as the child's bash changes
 * for the edit locks (bash-guard.ts). With fixUntilPass, a failure goes back
 * to the child as more of the same run, and the check runs again; the parent
 * hears only how the last check ended.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "../shell-jobs-widget.ts";
import type { AgentRecord, CheckResult, CheckRun, CheckSpec, CheckUpdate, ChildHandle } from "./types.ts";

export const MAX_FIX_ROUNDS = 5;
export const CHECK_TIMEOUT_MINUTES = 10;
export const MAX_CHECK_TIMEOUT_MINUTES = 60;
export const MAX_CHECK_CHARS = 4_000;
/** A failure shows more output than a pass: the parent needs to see why. */
const FAILED_TAIL = { lines: 40, chars: 4_000 };
const PASSED_TAIL = { lines: 10, chars: 1_000 };
const STATUS_LINE = /\n*Command exited with code \d+$/m;

/** Why `update` is not a check `target` can have, or undefined. */
export function checkError(update: CheckUpdate, target: { readOnly: boolean }): string | undefined {
	const { command, fixUntilPass, timeoutMinutes } = update;
	if (typeof command !== "string" || !command.trim()) return "check must be a shell command.";
	if (command.length > MAX_CHECK_CHARS || command.includes("\0")) return `check must be at most ${MAX_CHECK_CHARS} characters, with no NUL.`;
	if (fixUntilPass !== undefined && !(Number.isInteger(fixUntilPass) && fixUntilPass >= 0 && fixUntilPass <= MAX_FIX_ROUNDS)) return `fixUntilPass must be a whole number from 0 to ${MAX_FIX_ROUNDS}.`;
	if (timeoutMinutes !== undefined && !(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 && timeoutMinutes <= MAX_CHECK_TIMEOUT_MINUTES)) return `checkTimeoutMinutes must be more than 0 and at most ${MAX_CHECK_TIMEOUT_MINUTES}.`;
	if (target.readOnly && (fixUntilPass ?? 0) > 0) return "A read-only agent can't fix a failed check; leave out fixUntilPass.";
	return undefined;
}

/** The check a message's `update` makes of the `stored` one: what it leaves out stays. */
export function mergeCheck(update: CheckUpdate, stored?: CheckSpec): CheckSpec {
	const timeoutMinutes = update.timeoutMinutes ?? stored?.timeoutMinutes;
	return { command: update.command, fixUntilPass: update.fixUntilPass ?? stored?.fixUntilPass ?? 0, ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}) };
}

const textOf = (content: ReadonlyArray<{ type: string; text?: string }>): string => content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");

/**
 * Runs `command` with the child's bash tool. Pi's tool returns a non-zero
 * exit as an error result and throws on a timeout or an abort, after it
 * killed the command's process group.
 */
export async function bashCheck(bash: ToolDefinition, command: string, options: { timeoutMs: number; signal: AbortSignal; id: string }): Promise<CheckRun> {
	try {
		const result = await bash.execute(options.id, { command, timeout: options.timeoutMs / 1_000 }, options.signal, undefined, undefined as never);
		const exit = (result as { structuredContent?: { exit_code?: unknown } }).structuredContent?.exit_code;
		const failed = (result as { isError?: boolean }).isError === true;
		return { exitCode: typeof exit === "number" ? exit : failed ? 1 : 0, output: textOf(result.content).replace(STATUS_LINE, "") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: null, output: message, ...(/Command timed out after/.test(message) ? { timedOut: true } : {}) };
	}
}

/** The last `lines` lines of `text`, at most `chars` characters. */
export function tailOf(text: string, bounds: { lines: number; chars: number }): string {
	const lines = text.replace(/\s+$/, "").split("\n");
	const kept = lines.slice(-bounds.lines).join("\n");
	return kept.length > bounds.chars ? kept.slice(kept.length - bounds.chars) : kept;
}

async function execute(handle: Pick<ChildHandle, "check">, command: string, options: { timeoutMs: number; signal: AbortSignal; id: string }): Promise<CheckRun> {
	if (!handle.check) return { exitCode: null, output: "This agent's session can't run checks." };
	try { return await handle.check(command, options); }
	catch (error) { return { exitCode: null, output: error instanceof Error ? error.message : String(error) }; }
}

/** Runs `record`'s check as attempt `attempt` of its run. */
export async function runCheck(handle: Pick<ChildHandle, "check">, record: AgentRecord, attempt: number, signal: AbortSignal, now: () => number): Promise<CheckResult> {
	const spec = record.check!;
	const started = now();
	const run = await execute(handle, spec.command, { timeoutMs: (spec.timeoutMinutes ?? CHECK_TIMEOUT_MINUTES) * 60_000, signal, id: `check-${record.runs}-${attempt}` });
	return {
		run: record.runs, command: spec.command, exitCode: run.exitCode, ...(run.timedOut ? { timedOut: true } : {}),
		durationMs: now() - started, tail: tailOf(run.output, run.exitCode === 0 ? PASSED_TAIL : FAILED_TAIL), attempt, attempts: spec.fixUntilPass + 1,
	};
}

/** What the widget shows while the check runs. */
export const checkActivity = (command: string): string => `check: ${command.replace(/\s+/g, " ").trim().slice(0, 60)}`;

/** The check of `record`'s latest run, if one ran. */
export const checkOf = (record: Pick<AgentRecord, "checked" | "runs">): CheckResult | undefined => (record.checked?.run === record.runs ? record.checked : undefined);

function outcome(result: CheckResult): string {
	const took = formatElapsed(result.durationMs);
	const attempt = result.attempts > 1 ? `, attempt ${result.attempt} of ${result.attempts}` : "";
	if (result.exitCode === 0) return `passed (exit 0) in ${took}${attempt}`;
	if (result.timedOut) return `timed out after ${took}${attempt}`;
	if (result.exitCode === null) return `could not run${attempt}`;
	return `failed (exit ${result.exitCode}) in ${took}${attempt}`;
}

/** A fence longer than any run of backticks in `text`. */
const fenceFor = (text: string): string => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));

const fenced = (text: string): string => {
	const fence = fenceFor(text);
	return `${fence}\n${text}\n${fence}`;
};

/** The block a report ends with: the exact command, how it ended and the last lines of its output. */
export function checkBlock(result: CheckResult): string {
	const command = result.command.includes("\n") ? `Command:\n${fenced(result.command)}` : `Command: ${result.command}`;
	const output = result.tail ? `Last lines of output:\n${fenced(result.tail)}` : "No output.";
	return [`Check run by the harness, not by the agent: ${outcome(result)}.`, command, output].join("\n");
}

/** The report as saved and shown: the agent's text, then its run's check. */
export function reportWithCheck(record: Pick<AgentRecord, "report" | "checked" | "runs">): string | undefined {
	const checked = checkOf(record);
	if (!checked) return record.report;
	return [record.report?.trim() ? record.report : undefined, checkBlock(checked)].filter(Boolean).join("\n\n");
}

/** What a child is told when its check failed and it has a fix round left. */
export function fixPrompt(result: CheckResult): string {
	return [
		`The harness ran your check when your run ended, and it failed. Fix the cause, then end your run as before. The check runs again, and your last message is your report, so write the whole report again. This is fix round ${result.attempt} of ${result.attempts - 1}.`,
		checkBlock(result),
	].join("\n\n");
}
