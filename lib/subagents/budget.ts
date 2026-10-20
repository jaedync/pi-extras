/**
 * Each run of a child has a time budget and an optional cost budget, so a hung
 * or runaway child can't keep a headless `pi -p` open forever or spend without
 * bound. Time counts only while the run works: a child blocked on an answer
 * spends nothing, and the one answering it has its own budget. Cost counts
 * only what this run spent. A new run starts with a fresh budget; a run that
 * goes on on a fallback model, or wakes from waiting on its subagents, is the
 * same run and keeps what it has used.
 * A child can't see a clock, and without one it guesses its time used far
 * too high and stops early. So a run with a time budget is told where it
 * stands: its first prompt gives its start and end on the wall clock
 * (team.ts), notes at shares of the budget give the work minutes used and
 * left, and a wait of a minute or more ends with a note of the new end. The
 * last time note, and the one cost note, ask it to plan its report before its
 * tools stop at the limit (wrap-up.ts).
 */
import { formatMoney } from "../status-plus-logic.ts";
import { clockNote, costNote } from "./format.ts";
import type { AgentState } from "./types.ts";

/** The longest a timer can wait; a later deadline would fire at once. */
export const MAX_RUN_MINUTES = 24 * 60;
/** The share of a budget a run has used when it gets its last note, which asks it to plan its report. */
export const NOTE_SHARE = 0.8;
/**
 * Earlier shares of a time budget with a note of the work minutes used and
 * left. Between notes a child guesses from its own pace and drifts high
 * (scripts/budget-replay.mjs), so a gap is at most a tenth of the budget.
 */
export const PROGRESS_SHARES: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
/** A shorter time budget gets no note: what is left at the last one would be under a minute. */
export const MIN_NOTE_MINUTES = 5;
/** A wait this long moves the end on the wall clock enough to tell the run its new end. */
export const PAUSE_NOTE_MS = 60_000;
const MINUTE_MS = 60_000;

/** When a run gets its notes (tests make these small). */
export interface NoteTimes {
	readonly noteShare: number;
	readonly minNoteMinutes: number;
	readonly progressShares?: readonly number[];
}

/** A note a run got: `cost`, or `time:<share>`. */
const timeKey = (share: number): string => `time:${share}`;

export interface RunLimits {
	minutes?: number;
	cost?: number;
}

/** What a run has used of its budget so far. */
export interface BudgetUse {
	readonly costAtStart: number;
	readonly usedMs: number;
	/** The notes it got: a run that goes on is not told again. */
	readonly noted?: readonly string[];
}

/** A run's time budget and what it used, for its prompts (team.ts). */
export interface BudgetClock {
	readonly usedMs: number;
	readonly minutes: number;
	/** The shares of the budget with a note; none under MIN_NOTE_MINUTES. */
	readonly shares: readonly number[];
}

interface Clock {
	readonly limits: RunLimits;
	readonly costAtStart: number;
	/** Work time banked before the current stretch. */
	readonly usedMs: number;
	/** When the current stretch of work began; undefined while paused. */
	readonly since: number | undefined;
	/** When the current pause began. */
	readonly pausedAt?: number;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
	readonly noted: ReadonlySet<string>;
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
	private readonly notes: Required<NoteTimes>;

	constructor(options: { now: () => number; over(name: string, reason: string): void; near?(name: string, text: string): void; notes?: Partial<NoteTimes> }) {
		this.now = options.now;
		this.over = options.over;
		this.near = options.near ?? (() => undefined);
		this.notes = { noteShare: NOTE_SHARE, minNoteMinutes: MIN_NOTE_MINUTES, progressShares: PROGRESS_SHARES, ...options.notes };
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

	/** The run's time budget and the work time it used; undefined without a time budget. */
	clock(name: string): BudgetClock | undefined {
		const minutes = this.clocks.get(name)?.limits.minutes;
		if (minutes === undefined) return undefined;
		return { usedMs: this.used(name)!.usedMs, minutes, shares: this.shares(minutes) };
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

	/** The clock runs; after a pause, which moved the end on the wall clock, a long one is told the new end. */
	private resume(name: string): void {
		const clock = this.clocks.get(name);
		const minutes = clock?.limits.minutes;
		if (!clock || clock.since !== undefined || minutes === undefined) return;
		const now = this.now();
		const left = Math.max(0, minutes * MINUTE_MS - clock.usedMs);
		const timer = setTimeout(() => this.expire(name, timeReason(minutes)), left);
		timer.unref?.();
		this.clocks.set(name, { ...clock, since: now, pausedAt: undefined, timer, noteTimer: this.noteTimer(name, clock.noted, minutes, clock.usedMs) });
		if (clock.pausedAt !== undefined && now - clock.pausedAt >= PAUSE_NOTE_MS && this.shares(minutes).length > 0) {
			this.near(name, clockNote({ now, usedMs: clock.usedMs, minutes }));
		}
	}

	/** The shares of a time budget with a note; the last asks for a plan to report. */
	private shares(minutes: number): readonly number[] {
		const { noteShare, minNoteMinutes, progressShares } = this.notes;
		return minutes < minNoteMinutes ? [] : [...progressShares.filter((share) => share < noteShare), noteShare];
	}

	/**
	 * The timer of the run's next time note: the first share ahead of it that
	 * it was not told. A progress note it passed untold no longer matters; the
	 * last note does, so it comes at once.
	 */
	private noteTimer(name: string, noted: ReadonlySet<string>, minutes: number, usedMs: number): ReturnType<typeof setTimeout> | undefined {
		const shares = this.shares(minutes);
		const untold = shares.filter((share) => !noted.has(timeKey(share)));
		const last = shares.at(-1);
		const share = untold.find((each) => each * minutes * MINUTE_MS > usedMs) ?? (last !== undefined && untold.includes(last) ? last : undefined);
		if (share === undefined) return undefined;
		const timer = setTimeout(() => this.timeNote(name, share), Math.max(0, share * minutes * MINUTE_MS - usedMs));
		timer.unref?.();
		return timer;
	}

	private timeNote(name: string, share: number): void {
		const clock = this.clocks.get(name);
		const minutes = clock?.limits.minutes;
		if (!clock || clock.since === undefined || minutes === undefined) return;
		const now = this.now();
		const usedMs = clock.usedMs + now - clock.since;
		const noted = new Set([...clock.noted, timeKey(share)]);
		this.clocks.set(name, { ...clock, noted, noteTimer: this.noteTimer(name, noted, minutes, usedMs) });
		this.near(name, clockNote({ now, usedMs, minutes, plan: share === this.shares(minutes).at(-1) }));
	}

	private note(name: string, kind: string, text: string): void {
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
		const now = this.now();
		this.clocks.set(name, { ...clock, usedMs: clock.usedMs + now - clock.since, since: undefined, pausedAt: now, timer: undefined, noteTimer: undefined });
	}

	private expire(name: string, reason: string): void {
		this.end(name);
		this.over(name, reason);
	}
}
