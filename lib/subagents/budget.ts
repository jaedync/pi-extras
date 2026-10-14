/**
 * Each run of a child has a time budget and an optional cost budget, so a hung
 * or runaway child can't keep a headless `pi -p` open forever or spend without
 * bound. Time counts only while the run works: a child blocked on an answer
 * spends nothing, and the one answering it has its own budget. Cost counts
 * only what this run spent. A new run starts with a fresh budget; a run that
 * goes on on a fallback model, or wakes from waiting on its subagents, is the
 * same run and keeps what it has used.
 * Near the end of a budget the run gets one note, so it can plan its report
 * before its tools stop at the limit (wrap-up.ts).
 */
import { formatMoney } from "../status-plus-logic.ts";
import { costNote, timeNote } from "./format.ts";
import type { AgentState } from "./types.ts";

/** The longest a timer can wait; a later deadline would fire at once. */
export const MAX_RUN_MINUTES = 24 * 60;
/** The share of a budget a run has used when it gets its note. */
export const NOTE_SHARE = 0.8;
/** A shorter time budget gets no note: what is left at the note would be under a minute. */
export const MIN_NOTE_MINUTES = 5;

export type BudgetKind = "time" | "cost";

/** When a run gets its note (tests make these small). */
export interface NoteTimes {
	readonly noteShare: number;
	readonly minNoteMinutes: number;
}

export interface RunLimits {
	minutes?: number;
	cost?: number;
}

/** What a run has used of its budget so far. */
export interface BudgetUse {
	readonly costAtStart: number;
	readonly usedMs: number;
	/** The notes it got: a run that goes on is not told again. */
	readonly noted?: readonly BudgetKind[];
}

interface Clock {
	readonly limits: RunLimits;
	readonly costAtStart: number;
	/** Work time banked before the current stretch. */
	readonly usedMs: number;
	/** When the current stretch of work began; undefined while paused. */
	readonly since: number | undefined;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
	readonly noted: ReadonlySet<BudgetKind>;
	readonly noteTimer: ReturnType<typeof setTimeout> | undefined;
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
	private readonly near: (name: string, text: string) => void;
	private readonly notes: NoteTimes;

	constructor(options: { now: () => number; over(name: string, reason: string): void; near?(name: string, text: string): void; notes?: Partial<NoteTimes> }) {
		this.now = options.now;
		this.over = options.over;
		this.near = options.near ?? (() => undefined);
		this.notes = { noteShare: NOTE_SHARE, minNoteMinutes: MIN_NOTE_MINUTES, ...options.notes };
	}

	/** A run began working; `cost` is what the child had spent before it. A run that goes on carries what it had `used`. */
	start(name: string, limits: RunLimits, cost: number, used?: BudgetUse): void {
		this.end(name);
		if (limits.minutes === undefined && limits.cost === undefined) return;
		this.clocks.set(name, { limits, costAtStart: used?.costAtStart ?? cost, usedMs: used?.usedMs ?? 0, since: undefined, timer: undefined,
			noted: new Set(used?.noted), noteTimer: undefined });
		this.resume(name);
	}

	/** What the run has used so far; undefined when it has no budget. */
	used(name: string): BudgetUse | undefined {
		const clock = this.clocks.get(name);
		if (!clock) return undefined;
		return { costAtStart: clock.costAtStart, usedMs: clock.usedMs + (clock.since === undefined ? 0 : this.now() - clock.since), noted: [...clock.noted] };
	}

	/**
	 * Follows the child's state: running resumes the clock; asking, waiting on
	 * its subagents, or waiting in line for a slot pauses it; anything else
	 * ends the run.
	 */
	follow(name: string, state: AgentState): void {
		if (state === "running") this.resume(name);
		else if (state === "asking" || state === "waiting" || state === "queued") this.pause(name);
		else this.end(name);
	}

	/** Checked whenever the child's usage updates. */
	spent(name: string, cost: number): void {
		const clock = this.clocks.get(name);
		const limit = clock?.limits.cost;
		if (!clock || limit === undefined) return;
		const run = cost - clock.costAtStart;
		if (run >= limit) this.expire(name, costReason(limit));
		else if (run >= limit * this.notes.noteShare) this.note(name, "cost", costNote(limit - run, limit));
	}

	end(name: string): void {
		const clock = this.clocks.get(name);
		if (clock?.timer) clearTimeout(clock.timer);
		if (clock?.noteTimer) clearTimeout(clock.noteTimer);
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
		this.clocks.set(name, { ...clock, since: this.now(), timer, noteTimer: this.noteTimer(name, clock, minutes) });
	}

	/** The timer of the run's time note, if it still gets one. */
	private noteTimer(name: string, clock: Clock, minutes: number): ReturnType<typeof setTimeout> | undefined {
		const { noteShare, minNoteMinutes } = this.notes;
		if (clock.noted.has("time") || minutes < minNoteMinutes) return undefined;
		const timer = setTimeout(() => this.note(name, "time", timeNote(minutes * (1 - noteShare))), Math.max(0, minutes * 60_000 * noteShare - clock.usedMs));
		timer.unref?.();
		return timer;
	}

	private note(name: string, kind: BudgetKind, text: string): void {
		const clock = this.clocks.get(name);
		if (!clock || clock.noted.has(kind)) return;
		this.clocks.set(name, { ...clock, noted: new Set([...clock.noted, kind]) });
		this.near(name, text);
	}

	private pause(name: string): void {
		const clock = this.clocks.get(name);
		if (!clock || clock.since === undefined) return;
		if (clock.timer) clearTimeout(clock.timer);
		if (clock.noteTimer) clearTimeout(clock.noteTimer);
		this.clocks.set(name, { ...clock, usedMs: clock.usedMs + this.now() - clock.since, since: undefined, timer: undefined, noteTimer: undefined });
	}

	private expire(name: string, reason: string): void {
		this.end(name);
		this.over(name, reason);
	}
}
