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
