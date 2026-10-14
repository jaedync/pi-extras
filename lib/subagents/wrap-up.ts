/**
 * A run at its time or cost budget (budget.ts) gets to write a report instead
 * of being cut off. At the limit its tool calls are blocked (child.ts) and its
 * own subagents stop without a report. A tool call that runs gets a grace
 * period, then the run's prompt is aborted; a reply that streams may finish.
 * At the next turn boundary, the session's loop ends as for a swap, and the
 * same session is asked for a report. A reply that called no tool needs no
 * extra turn: it is the report, unless subagents were stopped, which that
 * reply could not know of. Mail that comes meanwhile waits for the next
 * run. A run that keeps calling tools, fails, or has not ended at the backstop
 * stops as before, so a hung child still can't keep a headless `pi -p` open.
 * No swap, fallback model or check runs during a wrap-up.
 */
import { stopOrder } from "./after.ts";
import { MIN_NOTE_MINUTES, NOTE_SHARE, type NoteTimes } from "./budget.ts";
import { BUDGET_BLOCKED, wrapUpPrompt, type StoppedSubagent } from "./format.ts";
import { type AgentRecord, type ChildHandle, LIVE_STATES } from "./types.ts";

/** How long a tool call that runs at the limit may go on before the run's prompt is aborted. */
export const TOOL_GRACE_MS = 60_000;
/** The longest a wrap-up may take from the limit: the tool grace and 3 minutes for the report. */
export const BACKSTOP_MS = 4 * 60_000;
/** Replies after the wrap-up prompt whose tool calls are blocked before the run stops: each one is a reply over the budget. */
export const BLOCKED_ROUNDS = 2;

export interface WrapUpTimes extends NoteTimes {
	readonly toolGraceMs: number;
	readonly backstopMs: number;
	readonly blockedRounds: number;
}

export const WRAP_UP_TIMES: WrapUpTimes = {
	noteShare: NOTE_SHARE, minNoteMinutes: MIN_NOTE_MINUTES, toolGraceMs: TOOL_GRACE_MS, backstopMs: BACKSTOP_MS, blockedRounds: BLOCKED_ROUNDS,
};

/** What the widget shows while a run wraps up. */
export const wrapUpActivity = (reason: string): string => `wrapping up: ${reason}`;

/** What the wrap-ups need from the team. */
export interface WrapUpHost {
	get(name: string): AgentRecord | undefined;
	list(): AgentRecord[];
	patch(name: string, patch: Partial<AgentRecord>): void;
	handle(name: string): ChildHandle | undefined;
	/** The current run's messages (sessions.ts). */
	runMessages(name: string): readonly unknown[];
	stop(name: string, options: { by?: string; reason?: string }): Promise<unknown>;
	warn(message: string): void;
	abortCheck(name: string): void;
	/** The run wrote its report at its budget, and ends as a normal run does. */
	ended(name: string, reason: string): void;
}

/**
 * limit: tools are blocked, and the loop ends at the next turn boundary.
 * ended: the loop ended there. prompting: the session was asked for its report.
 */
type Phase = "limit" | "ended" | "prompting";

interface WrapUp {
	readonly reason: string;
	readonly phase: Phase;
	readonly rounds: number;
	readonly subagents: readonly StoppedSubagent[];
	readonly timers: readonly ReturnType<typeof setTimeout>[];
}

interface ReplyLike { role?: string; stopReason?: string; content?: unknown }

/** Whether the run's last reply ended on its own with no tool call: then it is the report. */
export function finishedReply(messages: readonly unknown[]): boolean {
	const last = [...messages].reverse().find((message) => (message as ReplyLike).role === "assistant") as ReplyLike | undefined;
	if (!last || ["aborted", "error", "length"].includes(last.stopReason ?? "")) return false;
	return !Array.isArray(last.content) || !last.content.some((part) => (part as { type?: unknown }).type === "toolCall");
}

export class RunWrapUps {
	private readonly runs = new Map<string, WrapUp>();
	private readonly host: WrapUpHost;
	private readonly times: WrapUpTimes;

	constructor(host: WrapUpHost, times: Partial<WrapUpTimes> = {}) {
		this.host = host;
		this.times = { ...WRAP_UP_TIMES, ...times };
	}

	active(name: string): boolean {
		return this.runs.has(name);
	}

	/** The budget `name`'s run reached, while it wraps up. */
	reason(name: string): string | undefined {
		return this.runs.get(name)?.reason;
	}

	/** Why each tool call of `name` is blocked now; undefined while it does not wrap up. */
	blocked(name: string): string | undefined {
		return this.runs.has(name) ? BUDGET_BLOCKED : undefined;
	}

	/** What the widget shows instead of a session's own activity while `name` wraps up. */
	shown(name: string, patch: Partial<AgentRecord>): Partial<AgentRecord> {
		const wrap = this.runs.get(name);
		return wrap && patch.activity !== undefined ? { activity: wrapUpActivity(wrap.reason) } : {};
	}

	/** `name`'s run reached its budget for `reason`. One with no session at work stops as before. */
	begin(name: string, reason: string): void {
		const { host } = this;
		const record = host.get(name);
		if (!record || this.runs.has(name)) return;
		if (record.state !== "running" || !host.handle(name)) return void host.stop(name, { reason });
		const live = stopOrder(host.list().filter((entry) => entry.parent === name && LIVE_STATES.has(entry.state)));
		const subagents = live.map((entry) => ({ name: entry.name, state: entry.state, ...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {}) }));
		const grace = setTimeout(() => this.graceOver(name), this.times.toolGraceMs);
		const backstop = setTimeout(() => { if (this.runs.has(name)) void host.stop(name, { reason }); }, this.times.backstopMs);
		for (const timer of [grace, backstop]) timer.unref?.();
		this.runs.set(name, { reason, phase: "limit", rounds: 0, subagents, timers: [grace, backstop] });
		host.patch(name, { activity: wrapUpActivity(reason) });
		host.abortCheck(name);
		// Stopped by their parent, they send no report. All start now, as a failed run's do (team.ts `fail`): a stop
		// that hangs on its abort must not hold up the others, nor stop a later run of one that a resume started.
		for (const entry of live) {
			host.stop(entry.name, { by: name }).catch((error) => host.warn(`subagents: could not stop ${entry.name} when ${name} reached its budget: ${(error as Error).message}`));
		}
	}

	/**
	 * At a turn boundary of `name`'s run (team.ts `turnEnded`): whether its
	 * loop ends there. Undefined while it does not wrap up. At the limit it
	 * ends; after the wrap-up prompt, each turn of blocked calls is a round.
	 */
	turnEnded(name: string): boolean | undefined {
		const wrap = this.runs.get(name);
		if (!wrap) return undefined;
		if (wrap.phase !== "prompting") {
			this.runs.set(name, { ...wrap, phase: "ended" });
			return true;
		}
		this.runs.set(name, { ...wrap, rounds: wrap.rounds + 1 });
		return wrap.rounds + 1 >= this.times.blockedRounds;
	}

	/**
	 * Ends `name`'s run once its prompt came back at the budget: with the
	 * reply it wrote, or after it is asked for one in the same session. Never
	 * true: the run ends here, one way or another.
	 */
	async finish(name: string, handle: ChildHandle, gone: () => boolean): Promise<false> {
		const wrap = this.runs.get(name);
		if (!wrap) return false;
		try {
			// A reply that ended on its own was written before its subagents were stopped: it can't report on them.
			if (wrap.subagents.length > 0 || !finishedReply(this.host.runMessages(name))) {
				this.runs.set(name, { ...wrap, phase: "prompting" });
				await handle.prompt(wrapUpPrompt({ reason: wrap.reason, parent: this.host.get(name)?.parent ?? "", subagents: wrap.subagents }));
			}
		} catch {
			// A model error ends the run as a stop at the budget would: no fallback model takes the wrap-up.
			if (!gone()) void this.host.stop(name, { reason: wrap.reason });
			return false;
		}
		if (gone()) return false;
		if (finishedReply(this.host.runMessages(name))) this.host.ended(name, wrap.reason);
		else void this.host.stop(name, { reason: wrap.reason });
		return false;
	}

	/** At the end of the grace, a tool call that still runs is cut short, so the session can write the report. */
	private graceOver(name: string): void {
		const handle = this.host.handle(name);
		if (this.runs.get(name)?.phase !== "limit" || !handle) return;
		// A session that can't say counts as one whose tools still run.
		if (handle.toolsRunning?.() === false) return;
		void handle.abort().catch(() => undefined);
	}

	/** The run ended, or was stopped: its timers go. */
	end(name: string): void {
		for (const timer of this.runs.get(name)?.timers ?? []) clearTimeout(timer);
		this.runs.delete(name);
	}

	clear(): void {
		for (const name of [...this.runs.keys()]) this.end(name);
	}
}
