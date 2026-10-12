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
import { MAIN } from "./names.ts";
import { type AgentRecord, type CheckResult, type CheckRun, type CheckSpec, type CheckUpdate, type ChildHandle, WAITING_FOR_MODEL } from "./types.ts";

export const MAX_FIX_ROUNDS = 5;
export const CHECK_TIMEOUT_MINUTES = 10;
export const MAX_CHECK_TIMEOUT_MINUTES = 60;
export const MAX_CHECK_CHARS = 4_000;
/** A failure shows more output than a pass: the parent needs to see why. */
const FAILED_TAIL = { lines: 40, chars: 4_000 };
/** What a report says when the harness skipped the check at the end of its run. */
export const SKIPPED_LINE = "Check skipped: no changes since the last check.";
/**
 * Tools that can't change files: Pi's tools that only read, and this
 * extension's messages and stops. Any other tool can, `subagent` too, and
 * a subagent's calls count for each agent above it (`RunChecks.called`).
 */
const UNCHANGING_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "message", "stop_subagent"]);
const PASSED_TAIL = { lines: 10, chars: 1_000 };

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
		const exitCode = typeof exit === "number" ? exit : failed ? 1 : 0;
		return { exitCode, output: withoutStatus(textOf(result.content), exitCode) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: null, output: message, ...(/Command timed out after/.test(message) ? { timedOut: true } : {}) };
	}
}

/** Pi ends a failed command's text with its exit status, which the block says itself; output that looks like it stays. */
function withoutStatus(text: string, exitCode: number): string {
	const status = `Command exited with code ${exitCode}`;
	const at = exitCode === 0 ? -1 : text.lastIndexOf(status);
	return at < 0 ? text : `${text.slice(0, at).replace(/\n+$/, "")}${text.slice(at + status.length)}`;
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

/** Whether `record`'s latest run had a check that did not pass: news its parent must hear, whoever started the run. */
export function checkFailed(record: Pick<AgentRecord, "checked" | "runs">): boolean {
	// A null exit code is a check that timed out or could not run: not a pass.
	const checked = checkOf(record);
	return checked !== undefined && checked.exitCode !== 0;
}

/** How a check ended, in a few words: `failed (exit 1)`, `timed out`. */
export function checkVerdict(result: Pick<CheckResult, "exitCode" | "timedOut">): string {
	if (result.exitCode === 0) return "passed (exit 0)";
	if (result.timedOut) return "timed out";
	return result.exitCode === null ? "could not run" : `failed (exit ${result.exitCode})`;
}

function outcome(result: CheckResult): string {
	const took = formatElapsed(result.durationMs);
	const attempt = result.attempts > 1 ? `, attempt ${result.attempt} of ${result.attempts}` : "";
	const when = result.timedOut ? ` after ${took}` : result.exitCode === null ? "" : ` in ${took}`;
	return `${checkVerdict(result)}${when}${attempt}`;
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

/** How a report ends: its run's check, then whether the harness skipped the check at the run's end. */
export function checkLines(record: Pick<AgentRecord, "checked" | "runs" | "checkSkipped">): string | undefined {
	const checked = checkOf(record);
	const lines = [checked ? checkBlock(checked) : undefined, record.checkSkipped === record.runs ? SKIPPED_LINE : undefined].filter(Boolean);
	return lines.length > 0 ? lines.join("\n\n") : undefined;
}

/** The report as saved and shown: the agent's text, then its run's check. */
export function reportWithCheck(record: Pick<AgentRecord, "report" | "checked" | "runs" | "checkSkipped">): string | undefined {
	const check = checkLines(record);
	if (!check) return record.report;
	return [record.report?.trim() ? record.report : undefined, check].filter(Boolean).join("\n\n");
}

/** What a child is told when its check failed and it has a fix round left. */
export function fixPrompt(result: CheckResult): string {
	return [
		`The harness ran your check when your run ended, and it failed. Fix the cause, then end your run as before. The check runs again, and your last message is your report, so write the whole report again. This is fix round ${result.attempt} of ${result.attempts - 1}.`,
		checkBlock(result),
	].join("\n\n");
}

/** What the check runner needs from the team. */
export interface CheckHost {
	get(name: string): AgentRecord | undefined;
	patch(name: string, patch: Partial<AgentRecord>): void;
	under(name: string, ancestor: string): boolean;
	/** Whether the run ended some other way meanwhile: it was stopped, or the team closed. */
	gone(name: string): boolean;
	now(): number;
	/** Every agent's name, for an error about one that is not there. */
	known(): string;
}

/**
 * The team's checks: the ones running now, the fix rounds of each run, the
 * checks messages set, and which agents changed nothing since their last
 * check. That is kept in memory only: after a restart the next check runs.
 * Calls are counted as they start (child.ts), not read from the session's
 * messages, which a compaction can take out of its context.
 */
export class RunChecks {
	private readonly running = new Map<string, AbortController>();
	private readonly rounds = new Map<string, number>();
	/** How many calls that can change files each agent and the subagents under it made. */
	private readonly changes = new Map<string, number>();
	/** How many of those calls each agent's last check came after. */
	private readonly checkedAt = new Map<string, number>();
	private readonly host: CheckHost;

	constructor(host: CheckHost) {
		this.host = host;
	}

	/**
	 * The run ended: its next one starts its count of fix rounds again. Until
	 * then the count goes on, across a wait for its subagents or an answer and
	 * a move to another session.
	 */
	end(name: string): void {
		this.rounds.delete(name);
	}

	/**
	 * `name` starts a call of `tool`. One that can change files is work its
	 * last check did not see, and work of each agent above it: a subagent that
	 * `subagent` started or a message resumed changes files for its caller.
	 */
	called(name: string, tool: string): void {
		if (UNCHANGING_TOOLS.has(tool)) return;
		const counted = new Set<string>();
		for (let record = this.host.get(name); record && !counted.has(record.name); record = this.host.get(record.parent)) {
			counted.add(record.name);
			this.changes.set(record.name, (this.changes.get(record.name) ?? 0) + 1);
		}
	}

	/** Aborts `name`'s running check, or every one, which kills its process group. */
	abort(name?: string): void {
		for (const [running, controller] of this.running) if (name === undefined || running === name) controller.abort();
	}

	/**
	 * A message's check replaces the stored one, and applies when the run under
	 * way or the next one ends. Only main or an agent above `to` may set it: a
	 * check runs in `to`'s directory and sandbox, which a peer must not choose.
	 */
	set(from: string, to: string, update: CheckUpdate): string | undefined {
		const target = this.host.get(to);
		if (!target) return `No agent named ${to}. ${this.host.known()}`;
		if (from !== MAIN && !this.host.under(to, from)) return `Only main or an agent ${to} works for can set its check.`;
		const error = checkError(update, target);
		if (error) return error;
		this.host.patch(to, { check: mergeCheck(update, target.check) });
		return undefined;
	}

	/** Runs `name`'s check, if it has one: the prompt of a fix round when it failed and the run has one left. */
	async run(name: string, handle: Pick<ChildHandle, "check">): Promise<string | null> {
		const record = this.host.get(name);
		if (!record?.check) return null;
		// Nothing to check: a run that only answered or sent messages. Should the last check have failed, it would fail again.
		if (this.covered(record)) {
			this.host.patch(name, { checkSkipped: record.runs });
			return null;
		}
		const controller = new AbortController();
		// A subagent's call during the check comes after what the check sees.
		const changes = this.changes.get(name) ?? 0;
		const fixes = this.rounds.get(name) ?? 0;
		this.running.set(name, controller);
		this.host.patch(name, { activity: checkActivity(record.check.command), work: "tool" });
		let result: CheckResult;
		try { result = await runCheck(handle, record, fixes + 1, controller.signal, () => this.host.now()); }
		finally { this.running.delete(name); }
		if (this.host.gone(name)) return null;
		// A failed check is news main has not heard, even when the run only answered main.
		this.host.patch(name, { checked: result, checkSkipped: undefined, ...WAITING_FOR_MODEL, ...(result.exitCode !== 0 ? { answeredMain: undefined } : {}) });
		this.checkedAt.set(name, changes);
		// A check that could not run is the harness's problem, which no fix round of the child repairs.
		const fixable = result.exitCode !== 0 && (result.exitCode !== null || result.timedOut === true);
		if (!fixable || fixes >= record.check.fixUntilPass) return null;
		this.rounds.set(name, fixes + 1);
		return fixPrompt(result);
	}

	/** Whether its last check ran this command, and it called nothing that can change files since. */
	private covered(record: AgentRecord): boolean {
		const last = record.checked;
		return this.checkedAt.get(record.name) === (this.changes.get(record.name) ?? 0) && last !== undefined && last.exitCode !== null && last.command === record.check?.command;
	}
}
