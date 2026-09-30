/**
 * One JSON line per finished run in `<agentDir>/subagents/runs.jsonl`: which
 * model did what, how long it took, what it cost and how it ended. It is the
 * evidence for tuning the model guide.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRecord } from "./types.ts";

export const TASK_PREVIEW_CHARS = 200;

export const runLogPath = (agentDir: string): string => join(agentDir, "subagents", "runs.jsonl");

export function runLogEntry(record: AgentRecord, now: number, parentSession: string): Record<string, unknown> {
	return {
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
		run: record.runs,
		durationMs: (record.endedAt ?? now) - (record.startedAt ?? record.createdAt),
		toolCalls: record.toolCalls,
		usage: record.usage,
		reportChars: record.report?.length ?? 0,
		error: record.error ?? null,
		sessionFile: record.sessionFile ?? null,
	};
}

/** Throws on a write failure so the caller can say so once. */
export function appendRunLog(file: string, entry: Record<string, unknown>): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export interface ModelStats {
	model: string;
	runs: number;
	ok: number;
	failed: number;
	stopped: number;
	cost: number;
	durationMs: number;
	toolCalls: number;
}

/** Totals per model from the run log's lines; unreadable lines are skipped. */
export function statsByModel(lines: readonly string[]): ModelStats[] {
	const byModel = new Map<string, ModelStats>();
	for (const line of lines) {
		let entry: Record<string, unknown>;
		try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
		if (typeof entry.model !== "string") continue;
		const stats = byModel.get(entry.model) ?? { model: entry.model, runs: 0, ok: 0, failed: 0, stopped: 0, cost: 0, durationMs: 0, toolCalls: 0 };
		const usage = (entry.usage ?? {}) as { cost?: unknown };
		byModel.set(entry.model, {
			...stats,
			runs: stats.runs + 1,
			ok: stats.ok + (entry.state === "idle" ? 1 : 0),
			failed: stats.failed + (entry.state === "failed" ? 1 : 0),
			stopped: stats.stopped + (entry.state === "stopped" ? 1 : 0),
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
		const ended = [s.failed && `${s.failed} failed`, s.stopped && `${s.stopped} stopped`].filter(Boolean).join(", ");
		const count = `${String(s.runs).padStart(4)} ${s.runs === 1 ? "run" : "runs"}${ended ? ` (${ended})` : s.runs === 1 ? " " : ""}`;
		return `${s.model.padEnd(width)}  ${count}  avg ${format(s.durationMs / s.runs)}, ${(s.toolCalls / s.runs).toFixed(1)} tools, $${money(s.cost / s.runs)}  total $${money(s.cost)}`;
	}).join("\n");
}
