/**
 * Waits for a ChatGPT plan reset, held by the parent harness. A child's own
 * session never sleeps (rate-limit-recovery/child.ts): at a plan usage limit
 * it fails at once, and its guard keeps the limit it met, with the reset that
 * Codex sent. When no fallback model is left for the run (fallback.ts), the
 * team holds the run instead of failing it: the run lets its session and slot
 * go, waits for the reset plus resumeMarginSeconds, and goes on as the same
 * run on the same model (team.ts). The wait counts against the run's
 * rateLimitRecovery maxWaitSeconds and maxRecoveries, not its maxMinutes.
 * A stop, a close or a message from one who may resume it ends the wait first.
 */
import { formatDuration } from "../status-plus-logic.ts";
import { type RecoveryConfig, subagentPlanWaitOn } from "../rate-limit-recovery/config.ts";
import { type CapturedLimit, planWait, type WaitRefusal } from "../rate-limit-recovery/core.ts";
import { planLimited } from "../rate-limit-recovery/plan-limit.ts";
import { isQuotaError } from "../rate-limit-recovery/transient.ts";
import type { AgentRecord, PlanWaitState } from "./types.ts";

/** Sets and clears the wait's timer; tests give their own. */
export interface PlanTimer {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const REAL_TIMER: PlanTimer = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type PlanWaitPlan = { ok: true; wait: PlanWaitState; delayMs: number } | { ok: false; error: string };

const sentence = (text: string): string => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
const iso = (ms: number | undefined): string => ms === undefined ? "an unknown time" : new Date(ms).toISOString();

function refusal(why: WaitRefusal, config: RecoveryConfig, waits: number): string {
	const head = "The parent did not wait for the plan reset:";
	if (why === "unknown-reset") return `${head} the reset time is unknown.`;
	if (why === "too-long") return `${head} it is more than ${config.maxWaitSeconds} seconds away (rateLimitRecovery.maxWaitSeconds).`;
	if (why === "attempt-limit") return waits === 0 ? `${head} rateLimitRecovery.maxRecoveries is 0.` : `${head} this run already waited ${waits} time${waits === 1 ? "" : "s"} (rateLimitRecovery.maxRecoveries).`;
	return `${head} the waits of this run would pass ${config.maxWaitSeconds} seconds (rateLimitRecovery.maxWaitSeconds, planWaitBudget "run").`;
}

/**
 * Whether a run that failed with `error` waits for a plan reset, and how long;
 * else the error it fails with. Only a ChatGPT plan limit that the child's
 * guard captured counts, never prose. With the feature off the error stays as
 * it is; with it on, a refusal says why the parent did not wait.
 */
export function decidePlanWait(record: Pick<AgentRecord, "runs" | "planWait">, limit: CapturedLimit | undefined, error: string, config: RecoveryConfig | undefined, now: number): PlanWaitPlan {
	if (!config || !subagentPlanWaitOn(config) || limit?.kind !== "plan" || !planLimited(limit.provider) || !isQuotaError(error)) return { ok: false, error };
	const prior = record.planWait?.run === record.runs ? record.planWait : undefined;
	const waits = prior?.waits ?? 0;
	const waitedMs = prior?.waitedMs ?? 0;
	const plan = planWait(limit, config, waitedMs, waits, now);
	if (typeof plan === "string") return { ok: false, error: `${sentence(error)} ${refusal(plan, config, waits)}` };
	return { ok: true, delayMs: plan.delayMs, wait: { run: record.runs, waits: waits + 1, waitedMs, pausedAt: now, resetAt: limit.resetAtMs, resumeAt: plan.resumeAtMs,
		...(limit.window !== undefined ? { window: limit.window } : {}) } };
}

/** The row's words while the run waits: when it goes on, in UTC. */
export function planWaitActivity(wait: PlanWaitState): string {
	return `waiting for the ChatGPT plan reset until ${iso(wait.resumeAt).slice(11, 16)} UTC`;
}

/** The record once its wait ended at `now`: its counts stay for the run, the wait under way goes. */
export function endedWait(wait: PlanWaitState, now: number): PlanWaitState {
	const { pausedAt, resetAt: _resetAt, resumeAt: _resumeAt, ...kept } = wait;
	return { ...kept, waitedMs: wait.waitedMs + Math.max(0, now - (pausedAt ?? now)) };
}

/** A patch that ends the wait under way, if any. */
export function endWait(record: Pick<AgentRecord, "planWait"> | undefined, now: number): Partial<AgentRecord> {
	return record?.planWait?.pausedAt !== undefined ? { planWait: endedWait(record.planWait, now) } : {};
}

/** What the run reads first when it goes on: how long it waited, in plain words. */
export function planWaitNote(wait: PlanWaitState, resumedAt: number): string {
	const early = wait.resumeAt !== undefined && resumedAt < wait.resumeAt;
	const took = formatDuration(Math.max(0, resumedAt - (wait.pausedAt ?? resumedAt)), true);
	return [
		`You waited for the ChatGPT plan usage limit to reset, from ${iso(wait.pausedAt)} to ${iso(resumedAt)} (UTC). That is ${took}.`,
		early ? `A message resumed you before the expected reset at ${iso(wait.resetAt)}, so the plan can still be limited.` : "The expected reset time has passed.",
		"You go on with the same run on the same model. Check the current state of files before you continue your work.",
	].join(" ");
}

/** The note of a restored child that was waiting when Pi stopped. */
export function restoredWaitNote(record: Pick<AgentRecord, "planWait">): string {
	const wait = record.planWait;
	return wait?.pausedAt === undefined ? "" : `It was waiting for the ChatGPT plan reset at ${iso(wait.resetAt)}.`;
}

/** One timer for each run that waits; `due` ends the wait. */
export class PlanWaits {
	private readonly timers = new Map<string, unknown>();
	private readonly timer: PlanTimer;
	private readonly due: (name: string) => void;

	constructor(timer: PlanTimer, due: (name: string) => void) {
		this.timer = timer;
		this.due = due;
	}

	arm(name: string, ms: number): void {
		this.end(name);
		const handle = this.timer.set(() => {
			this.timers.delete(name);
			this.due(name);
		}, ms);
		this.timers.set(name, handle);
	}

	waiting(name: string): boolean {
		return this.timers.has(name);
	}

	end(name: string): void {
		if (!this.timers.has(name)) return;
		const handle = this.timers.get(name);
		this.timers.delete(name);
		this.timer.clear(handle);
	}

	clear(): void {
		for (const name of [...this.timers.keys()]) this.end(name);
	}
}
