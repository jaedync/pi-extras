/**
 * One JSON line per finished run in `<agentDir>/subagents/runs.jsonl`: which
 * model did what, how long it took, what it cost and how it ended. It is the
 * evidence for tuning the model guide. Lines of format 2 hold the run's own
 * usage and tool calls. Lines with no format, written before it or for a
 * record saved before runs kept their start, hold the child's totals so far.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { NO_USAGE, type AgentRecord, type Usage } from "./types.ts";

/** Lines whose usage and tool calls are the run's own. */
export const RUN_LOG_FORMAT = 2;

const since = (total: Usage, start: Usage): Usage => ({
	input: Math.max(0, total.input - start.input), output: Math.max(0, total.output - start.output),
	cacheRead: Math.max(0, total.cacheRead - start.cacheRead), cacheWrite: Math.max(0, total.cacheWrite - start.cacheWrite),
	cost: Math.max(0, total.cost - start.cost),
});

/** The run's own usage and tool calls, when the record knows where the run began. */
function runUse(record: AgentRecord): { format?: number; usage: Usage; toolCalls: number } {
	const start = record.runStart;
	if (!start) return { usage: record.usage, toolCalls: record.toolCalls };
	return { format: RUN_LOG_FORMAT, usage: since(record.usage, start.usage), toolCalls: Math.max(0, record.toolCalls - start.toolCalls) };
}

export const TASK_PREVIEW_CHARS = 200;

export const runLogPath = (agentDir: string): string => join(agentDir, "subagents", "runs.jsonl");

export function runLogEntry(record: AgentRecord, now: number, parentSession: string): Record<string, unknown> {
	const launchFailed = record.state === "interrupted" && !!record.launchError;
	const use = runUse(record);
	return {
		...(use.format !== undefined ? { format: use.format } : {}),
		at: new Date(now).toISOString(),
		parentSession,
		name: record.name,
		parent: record.parent,
		depth: record.depth,
		model: record.model,
		thinking: record.thinking ?? null,
		readOnly: record.readOnly,
		fork: record.fork,
		blocking: record.blocking,
		task: record.task.slice(0, TASK_PREVIEW_CHARS),
		state: record.state,
		...(launchFailed ? { event: "resume_launch_failed", launchAttempt: record.launchFailures } : {}),
		run: record.runs,
		durationMs: (record.endedAt ?? now) - (record.startedAt ?? record.createdAt),
		toolCalls: launchFailed ? 0 : use.toolCalls,
		usage: launchFailed ? NO_USAGE : use.usage,
		reportChars: launchFailed ? 0 : record.report?.length ?? 0,
		error: record.error ?? null,
		...(record.budgetEnd ? { budgetEnd: record.budgetEnd } : {}),
		sessionFile: record.sessionFile ?? null,
	};
}

/** Throws on a write failure so the caller can say so once. Tasks are private, so the log is the user's alone. */
export function appendRunLog(file: string, entry: Record<string, unknown>): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
}

/** A name can be reused across parents; the session file distinguishes its durable run. */
export function runKey(entry: Record<string, unknown>): string {
	return JSON.stringify([entry.parentSession, entry.sessionFile, entry.name, entry.run,
		...(entry.event === "resume_launch_failed" ? [entry.event, entry.launchAttempt] : [])]);
}

export function loggedRunKeys(file: string): Set<string> {
	if (!existsSync(file)) return new Set();
	return new Set(readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
		try { return [runKey(JSON.parse(line))]; } catch { return []; }
	}));
}

export function appendInterruptedRuns(file: string, records: readonly AgentRecord[], parentSession: string, now: number): void {
	const logged = loggedRunKeys(file);
	for (const record of records) {
		if (record.state !== "interrupted") continue;
		const entry = runLogEntry(record, now, parentSession);
		const key = runKey(entry);
		if (logged.has(key)) continue;
		appendRunLog(file, entry);
		logged.add(key);
	}
}

export interface ModelStats {
	model: string;
	runs: number;
	ok: number;
	/** Runs that ended idle with a report written at their budget (wrap-up.ts); not counted as ok. */
	atBudget: number;
	failed: number;
	stopped: number;
	interrupted: number;
	cost: number;
	durationMs: number;
	toolCalls: number;
}

/**
 * Totals per model from the run log's lines; unreadable lines are skipped.
 * Lines with no format hold a child's totals so far, not its run's own, so a
 * child with many runs counts too much there. They are read as they are: what
 * each run used can't be told from them.
 */
export function statsByModel(lines: readonly string[]): ModelStats[] {
	const byModel = new Map<string, ModelStats>();
	for (const line of lines) {
		let entry: Record<string, unknown>;
		try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
		if (typeof entry.model !== "string") continue;
		const stats = byModel.get(entry.model) ?? { model: entry.model, runs: 0, ok: 0, atBudget: 0, failed: 0, stopped: 0, interrupted: 0, cost: 0, durationMs: 0, toolCalls: 0 };
		const usage = (entry.usage ?? {}) as { cost?: unknown };
		byModel.set(entry.model, {
			...stats,
			runs: stats.runs + 1,
			ok: stats.ok + (entry.state === "idle" && !entry.budgetEnd ? 1 : 0),
			atBudget: stats.atBudget + (entry.state === "idle" && entry.budgetEnd ? 1 : 0),
			failed: stats.failed + (entry.state === "failed" ? 1 : 0),
			stopped: stats.stopped + (entry.state === "stopped" ? 1 : 0),
			interrupted: stats.interrupted + (entry.state === "interrupted" ? 1 : 0),
			cost: stats.cost + (typeof usage.cost === "number" ? usage.cost : 0),
			durationMs: stats.durationMs + (typeof entry.durationMs === "number" ? entry.durationMs : 0),
			toolCalls: stats.toolCalls + (typeof entry.toolCalls === "number" ? entry.toolCalls : 0),
		});
	}
	return [...byModel.values()].sort((a, b) => b.runs - a.runs);
}

export function statsText(stats: readonly ModelStats[], format: (ms: number) => string, money: (value: number) => string): string {
	if (stats.length === 0) return "No subagent runs logged yet.";
	const width = Math.max(...stats.map((s) => s.model.length));
	return stats.map((s) => {
		const ended = [s.atBudget && `${s.atBudget} at budget`, s.failed && `${s.failed} failed`, s.stopped && `${s.stopped} stopped`, s.interrupted && `${s.interrupted} interrupted`].filter(Boolean).join(", ");
		const count = `${String(s.runs).padStart(4)} ${s.runs === 1 ? "run" : "runs"}${ended ? ` (${ended})` : s.runs === 1 ? " " : ""}`;
		return `${s.model.padEnd(width)}  ${count}  avg ${format(s.durationMs / s.runs)}, ${(s.toolCalls / s.runs).toFixed(1)} tools, $${money(s.cost / s.runs)}  total $${money(s.cost)}`;
	}).join("\n");
}
