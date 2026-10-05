/**
 * Each run of a child has a time budget and an optional cost budget, so a hung
 * or runaway child can't keep a headless `pi -p` open forever or spend without
 * bound. Time counts only while the run works: a child blocked on an answer
 * spends nothing, and the one answering it has its own budget. Cost counts
 * only what this run spent. A new run starts with a fresh budget; a run that
 * goes on on a fallback model is the same run and keeps what it has used.
 */
import { formatMoney } from "../status-plus-logic.ts";
import type { AgentState } from "./types.ts";

/** The longest a timer can wait; a later deadline would fire at once. */
export const MAX_RUN_MINUTES = 24 * 60;

export interface RunLimits {
	minutes?: number;
	cost?: number;
}

/** What a run has used of its budget so far. */
export interface BudgetUse {
	readonly costAtStart: number;
	readonly usedMs: number;
}

interface Clock {
	readonly limits: RunLimits;
	readonly costAtStart: number;
	/** Work time banked before the current stretch. */
	readonly usedMs: number;
	/** When the current stretch of work began; undefined while paused. */
	readonly since: number | undefined;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/** Why a budget value is invalid, or undefined; a budget must be a positive number. */
export function budgetError(field: "maxMinutes" | "maxCost", value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) return `${field} must be a positive number.`;
	if (field === "maxMinutes" && value > MAX_RUN_MINUTES) return `maxMinutes can be at most ${MAX_RUN_MINUTES} (24 hours).`;
	return undefined;
}

export const timeReason = (minutes: number): string => `over its ${minutes}-minute budget`;
export const costReason = (cost: number): string => `over its $${formatMoney(cost)} cost budget`;

export class RunBudgets {
	private readonly clocks = new Map<string, Clock>();
	private readonly now: () => number;
	private readonly over: (name: string, reason: string) => void;

	constructor(options: { now: () => number; over(name: string, reason: string): void }) {
		this.now = options.now;
		this.over = options.over;
	}

	/** A run began working; `cost` is what the child had spent before it. A run that goes on carries what it had `used`. */
	start(name: string, limits: RunLimits, cost: number, used?: BudgetUse): void {
		this.end(name);
		if (limits.minutes === undefined && limits.cost === undefined) return;
		this.clocks.set(name, { limits, costAtStart: used?.costAtStart ?? cost, usedMs: used?.usedMs ?? 0, since: undefined, timer: undefined });
		this.resume(name);
	}

	/** What the run has used so far; undefined when it has no budget. */
	used(name: string): BudgetUse | undefined {
		const clock = this.clocks.get(name);
		if (!clock) return undefined;
		return { costAtStart: clock.costAtStart, usedMs: clock.usedMs + (clock.since === undefined ? 0 : this.now() - clock.since) };
	}

	/** Follows the child's state: asking pauses the clock, running resumes it, anything else ends the run. */
	follow(name: string, state: AgentState): void {
		if (state === "running") this.resume(name);
		else if (state === "asking") this.pause(name);
		else this.end(name);
	}

	/** Checked whenever the child's usage updates. */
	spent(name: string, cost: number): void {
		const clock = this.clocks.get(name);
		const limit = clock?.limits.cost;
		if (clock && limit !== undefined && cost - clock.costAtStart >= limit) this.expire(name, costReason(limit));
	}

	end(name: string): void {
		const clock = this.clocks.get(name);
		if (clock?.timer) clearTimeout(clock.timer);
		this.clocks.delete(name);
	}

	clear(): void {
		for (const name of [...this.clocks.keys()]) this.end(name);
	}

	private resume(name: string): void {
		const clock = this.clocks.get(name);
		const minutes = clock?.limits.minutes;
		if (!clock || clock.since !== undefined || minutes === undefined) return;
		const left = Math.max(0, minutes * 60_000 - clock.usedMs);
		const timer = setTimeout(() => this.expire(name, timeReason(minutes)), left);
		timer.unref?.();
		this.clocks.set(name, { ...clock, since: this.now(), timer });
	}

	private pause(name: string): void {
		const clock = this.clocks.get(name);
		if (!clock || clock.since === undefined) return;
		if (clock.timer) clearTimeout(clock.timer);
		this.clocks.set(name, { ...clock, usedMs: clock.usedMs + this.now() - clock.since, since: undefined, timer: undefined });
	}

	private expire(name: string, reason: string): void {
		this.end(name);
		this.over(name, reason);
	}
}
