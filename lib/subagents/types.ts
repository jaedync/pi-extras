/** Shared shapes for the subagents team. Records are replaced, never mutated. */
import type { Thinking } from "./models.ts";
import type { LaunchStamp } from "./stamp.ts";

/**
 * queued: over the concurrency limit. starting: its session is being made.
 * running: working. asking: blocked on a reply. waiting: its run ended but its
 * own children have not reported yet. idle: finished, and resumable by a
 * message. interrupted: paused after shutdown or unfinished tools, resumable.
 * failed / stopped: ended without a normal report.
 */
export type AgentState = "queued" | "starting" | "running" | "asking" | "waiting" | "idle" | "failed" | "stopped" | "interrupted";

export const ACTIVE_STATES: ReadonlySet<AgentState> = new Set(["starting", "running"]);
export const LIVE_STATES: ReadonlySet<AgentState> = new Set(["queued", "starting", "running", "asking", "waiting"]);

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/**
 * What a running agent's session does now, as main's phase spinner names it:
 * waits for its model, thinks, writes, writes a call, runs a tool, waits on
 * another agent through a tool, compacts, or retries a failed request.
 */
export type AgentWork = "model" | "thinking" | "writing" | "call" | "tool" | "peer" | "compacting" | "retrying";

/** A running agent between replies: its model is asked next. */
export const WAITING_FOR_MODEL = { activity: "waiting for the model", work: "model" } as const satisfies Pick<AgentRecord, "activity" | "work">;

/** Why a model could not serve a run: the failures a fallback model can get past (fallback.ts). */
export type FailureKind = "quota" | "rate-limit" | "overloaded" | "credentials" | "not-found";

/** One switch of a run to a fallback model. */
export interface FallbackStep {
	/** The run it happened in; a report names only its own run's switches. */
	run: number;
	from: string;
	to: string;
	kind: FailureKind;
	/** A few words: `usage limit reached`. */
	reason: string;
	at: number;
}

export interface Worktree {
	path: string;
	branch: string;
	base: string;
}

export interface AgentRecord {
	name: string;
	/** `main` or another agent's name. */
	parent: string;
	depth: number;
	task: string;
	model: string;
	thinking?: Thinking;
	readOnly: boolean;
	/** Its tool allowlist, fixed at spawn so resumes keep it; unset, it gets every tool it could have. */
	tools?: string[];
	/** An isolated workspace, also inherited by helpers sharing their parent's checkout. */
	worktree?: Worktree;
	/**
	 * The directory it starts in when a spawn named one (a real path; for a
	 * worktree made from a cwd, the same directory inside the worktree), also
	 * inherited by its helpers; unset, its worktree's top or the parent session's.
	 */
	cwd?: string;
	/** Its checkout (checkout.ts): its worktree, or git's top level of where it starts, or that directory outside git. */
	checkout?: string;
	/** Captured when a run ends, so reading its report does not stage a later run's files. */
	worktreeReport?: string;
	/** It works in its parent's worktree, which is the parent's to apply and delete: its report has no worktree footer. */
	sharesWorktree?: boolean;
	fork: boolean;
	/** The parent's tool call waits for the report instead of a message. */
	blocking: boolean;
	/** Children main started in the same turn; their reports arrive together. */
	group?: string;
	state: AgentState;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	/** What it is doing now, in a few words: `bash npm test`, `thinking`. */
	activity: string | null;
	/** What its session does now, for its spinner; unset before its session reports. */
	work?: AgentWork;
	/** Who it is waiting on while `asking`. */
	askingWho?: string;
	toolCalls: number;
	usage: Usage;
	contextTokens?: number;
	contextWindow?: number;
	/** The context size at which its session compacts (compaction-point.ts); records saved before it have only the window. */
	compactAt?: number;
	report?: string;
	/** The full report of the latest completed run, never reused by a later run. */
	reportFile?: string;
	error?: string;
	/** Minutes one run may work, and dollars it may spend, before it must report (wrap-up.ts); fixed at spawn so resumes keep them. */
	maxMinutes?: number;
	maxCost?: number;
	/** Why its last run was stopped, when it was not by request: `over its 60-minute budget`. */
	stopReason?: string;
	/** Its last run reached this budget and ended with the report it was asked for then: `over its 60-minute budget`. */
	budgetEnd?: string;
	sessionFile?: string;
	/** Reconstructed from disk, without a live SDK handle yet. */
	restored?: boolean;
	interruptedBy?: "reload" | "signal" | "quit";
	interruptionId?: string;
	interruptedOwner?: string;
	interruptionAnnounced?: boolean;
	autoResumeAttempts?: number;
	/** Main's next message to this paused child waits in its inbox instead of resuming it (team.ts `holdAnswer`); saved, so a renewed host keeps holding it. */
	answerHeld?: boolean;
	lastActivityAt?: number;
	restoreError?: string;
	launchFailures?: number;
	launchError?: string;
	/** A transcript without matching index or parent spawn metadata. Defaults to read-only. */
	orphaned?: boolean;
	/** How many runs: 1, then one more per resume. */
	runs: number;
	/** The message that resumed it, for the report of that run. */
	resumedBy?: { from: string; text: string };
	/**
	 * Main resumed this idle child with a question, and the child answered it and
	 * then only wrote its final text: no tool calls, no new input, no failure. Its
	 * report need not wake main.
	 */
	answeredMain?: boolean;
	/** Messages for its next run. On the record, so the index keeps them across a restart. */
	inbox?: string[];
	/** Who owes it an answer to a question that did not block it; their message to it wakes it. */
	owed?: string[];
	/** Steered into its run but not read yet; Pi holds these only in memory (mailbox.ts). */
	unread?: string[];
	/** Every switch to a fallback model, oldest first; `model` is the one it runs on now. */
	fallbacks?: FallbackStep[];
	/** Agents that must end before its first run starts (after.ts); on the record, so a restore or /reload keeps the wait. */
	after?: string[];
	/** The command the harness runs when a run ends normally, before its report goes up (checks.ts); kept for later runs. */
	check?: CheckSpec;
	/** What the latest check found; a report shows only its own run's. */
	checked?: CheckResult;
	/** What it had spent when its current run began, so main's status lines show the run's own cost (status.ts). */
	runCost?: number;
	/** Its usage and tool calls when its current run began, so the run log holds the run's own (runlog.ts). */
	runStart?: { usage: Usage; toolCalls: number };
	/** The run whose check the harness skipped: it called nothing that can change files since the last check (checks.ts). */
	checkSkipped?: number;
	/** The latest run that changed files (`Team.changed`); without a check, its report says nobody checked them (checks.ts). */
	changedRun?: number;
}

/** A check as a spawn or a message set it (checks.ts). */
export interface CheckSpec {
	command: string;
	/** How many times a failed check goes back to the agent to fix, 0 to 5. */
	fixUntilPass: number;
	/** How long the command may run; unset, CHECK_TIMEOUT_MINUTES. */
	timeoutMinutes?: number;
}

/** A message's new check: what it leaves out stays as stored. */
export type CheckUpdate = Pick<CheckSpec, "command"> & Partial<Pick<CheckSpec, "fixUntilPass" | "timeoutMinutes">>;

/** What one check found. */
export interface CheckResult {
	/** The run it belongs to. */
	run: number;
	command: string;
	/** Null when it timed out or could not run. */
	exitCode: number | null;
	timedOut?: boolean;
	durationMs: number;
	/** The last lines of its combined output, bounded. */
	tail: string;
	/** 1 for the run's first check, one more for each fix round. */
	attempt: number;
	/** The most the run gets: fixUntilPass + 1. */
	attempts: number;
}

/** What a check command did, as the agent's own bash tool reports it. */
export interface CheckRun {
	exitCode: number | null;
	/** Its combined output as the agent's bash shows it, notes included. */
	output: string;
	timedOut?: boolean;
}

export interface SpawnRequest {
	name?: string;
	isolation?: "shared" | "worktree";
	/** Where it starts, as the caller wrote it: absolute or under `~/`. */
	cwd?: string;
	task: string;
	parent: string;
	model: string;
	thinking?: Thinking;
	readOnly: boolean;
	tools?: string[];
	fork: boolean;
	blocking: boolean;
	group?: string;
	maxMinutes?: number;
	maxCost?: number;
	/** Agents that must end before it starts (after.ts). */
	after?: string[];
	check?: CheckSpec;
}

/** What the team needs from a running child session. */
export interface ChildHandle {
	/** Runs until the session settles. */
	prompt(text: string): Promise<void>;
	/** Delivered after the current tool call. Only while running. */
	steer(text: string): void;
	abort(): Promise<void>;
	lastText(): string | undefined;
	/** Steering that arrived too late for the run that just ended. */
	takeQueued(): string[];
	/** The session's messages so far, for the inspector. */
	messages(): readonly unknown[];
	/** The reply being written now, before it joins the messages; for the inspector. */
	streaming?(): unknown;
	/** The definition of one of its tools, which the inspector draws its rows with. */
	tool?(name: string): object | undefined;
	dispose(): Promise<void>;
	sessionFile?: string;
	/** What its launch read (stamp.ts); a launcher compares it with what a launch now would read. */
	stamp?: LaunchStamp;
	/** Whether a tool call of its session runs now; unset, a session can't say. */
	toolsRunning?(): boolean;
	/** Runs a check command as the child's bash would, in its directory and with its shell settings and sandbox. */
	check?(command: string, options: { timeoutMs: number; signal: AbortSignal; id: string }): Promise<CheckRun>;
}

export interface ChildHooks {
	update(patch: Partial<Pick<AgentRecord, "activity" | "work" | "toolCalls" | "usage" | "contextTokens" | "contextWindow" | "compactAt">>): void;
	/**
	 * Called where the run's loop would ask the model again, with the turn's
	 * tool results recorded and no tool running: true ends the run's prompt
	 * there, and the team moves the run to a new session (swap.ts).
	 */
	turnEnded?(): boolean;
	/** A tool call starts, with the tool's name: the team counts the calls that can change files (checks.ts). */
	toolCalled?(tool: string): void;
	/**
	 * While the run wraps up at its budget (wrap-up.ts): why each tool call is
	 * blocked. Mail steered then waits for the next run. Undefined otherwise.
	 */
	wrapUp?(): string | undefined;
}

export interface Launcher {
	launch(record: AgentRecord, hooks: ChildHooks): Promise<ChildHandle>;
	/**
	 * Whether a launch now would make the session `handle` is: the same code,
	 * settings, models and extensions. Without it every open session is current.
	 */
	current?(handle: ChildHandle): boolean;
	/** Whether a launch now would run the code `handle`'s session runs: false after a /reload. Without it, the code counts as current. */
	codeCurrent?(handle: ChildHandle): boolean;
}

/** Something the team hands to the main session. */
export type MainDelivery =
	| { kind: "note"; from: string; text: string }
	| { kind: "question"; from: string; text: string }
	/** An answer to something main asked with expectReply; it wakes main. */
	| { kind: "reply"; from: string; text: string }
	/** The user wrote to a child directly; main is told but not woken. */
	| { kind: "relay"; from: string; to: string; text: string; answered: boolean }
	/** `quiet`: a run a peer started ended idle; main reads it at its next turn instead of being woken. */
	| { kind: "report"; record: AgentRecord; quiet?: boolean };
