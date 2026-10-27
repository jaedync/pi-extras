/**
 * A child's bash call that begins with a long `sleep`: the child only waits,
 * so the team lends its slot to the next agent in line for the sleep
 * (team.ts `rest`) and the bash tool runs what follows. A child has no
 * background jobs, so a sleep is how it waits for CI, a review or a build;
 * without this, each such wait would hold a slot that a queued agent needs.
 * The transcript keeps the command the child wrote.
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Shorter sleeps run in bash: lending a slot for them would only churn the line. */
export const MIN_REST_MS = 15_000;
/** The longest delay a Node timer keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

const UNIT_MS: Readonly<Record<string, number>> = { "": 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** One `sleep N[smhd]` first, then `;`, `&&`, a new line or the end; `rest` is what follows. */
const LEADING_SLEEP = /^\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)[ \t]*(?:(;|&&|\n)\s*([\s\S]*))?$/;

/** Undefined for any other form, and for one bash would refuse (a carriage return, `&&` with nothing after it, `;;`), so bash gives its own error at once. */
export function leadingSleep(command: string): { ms: number; rest: string } | undefined {
	const match = command.includes("\r") ? null : LEADING_SLEEP.exec(command);
	if (!match) return undefined;
	const ms = Number(match[1]) * UNIT_MS[match[2] ?? ""]!;
	const rest = (match[4] ?? "").trim();
	if ((match[3] === "&&" && !rest) || /^[;&|)]/.test(rest)) return undefined;
	return ms >= MIN_REST_MS && ms <= MAX_TIMER_MS ? { ms, rest } : undefined;
}

/**
 * Waits `ms` with the child's slot lent out. True once the child holds a slot
 * again; false when an abort, a stop or a close ended the wait, so nothing
 * more of the command runs.
 */
export type Rest = (ms: number, signal?: AbortSignal) => Promise<boolean>;

interface BashParams { command: string; timeout?: number }

/** `alone` says whether this call is the child's only tool call now: one that runs beside other calls keeps its slot, since they work. */
export function restingBash<T extends ToolDefinition<any, any, any>>(definition: T, rest: Rest, alone: () => boolean): T {
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const { command, timeout } = params as BashParams;
			const sleep = typeof command === "string" ? leadingSleep(command) : undefined;
			// A sleep the timeout would cut, or a timeout bash refuses, fails in bash as written.
			const cut = timeout !== undefined && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout * 1000 > (sleep?.ms ?? 0) && timeout * 1000 <= MAX_TIMER_MS);
			if (!sleep || cut || !alone()) return definition.execute(toolCallId, params, signal, onUpdate, ctx);
			// The words of Pi's bash tool for an aborted command.
			if (!(await rest(sleep.ms, signal))) throw new Error("Command aborted");
			// `:` gives the bash tool's own result for a command with no output.
			const next: BashParams = { ...(params as BashParams), command: sleep.rest || ":",
				...(timeout !== undefined ? { timeout: Math.max(1, Math.ceil(timeout - sleep.ms / 1000)) } : {}) };
			return definition.execute(toolCallId, next, signal, onUpdate, ctx);
		},
	};
}
