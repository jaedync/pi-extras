/** Shared shapes for the subagents team. Records are replaced, never mutated. */
import type { Thinking } from "./models.ts";

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
	/** An isolated workspace, also inherited by helpers sharing their parent's checkout. */
	worktree?: Worktree;
	/** Captured when a run ends, so reading its report does not stage a later run's files. */
	worktreeReport?: string;
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
	/** Who it is waiting on while `asking`. */
	askingWho?: string;
	toolCalls: number;
	usage: Usage;
	contextTokens?: number;
	contextWindow?: number;
	report?: string;
	/** The full report of the latest completed run, never reused by a later run. */
	reportFile?: string;
	error?: string;
	/** Minutes one run may work, and dollars it may spend, before it is stopped; fixed at spawn so resumes keep them. */
	maxMinutes?: number;
	maxCost?: number;
	/** Why its last run was stopped, when it was not by request: `over its 60-minute budget`. */
	stopReason?: string;
	sessionFile?: string;
	/** Reconstructed from disk, without a live SDK handle yet. */
	restored?: boolean;
	interruptedBy?: "reload" | "signal" | "quit";
	interruptionId?: string;
	interruptedOwner?: string;
	interruptionAnnounced?: boolean;
	autoResumeAttempts?: number;
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
}

export interface SpawnRequest {
	name?: string;
	isolation?: "shared" | "worktree";
	task: string;
	parent: string;
	model: string;
	thinking?: Thinking;
	readOnly: boolean;
	fork: boolean;
	blocking: boolean;
	group?: string;
	maxMinutes?: number;
	maxCost?: number;
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
}

export interface ChildHooks {
	update(patch: Partial<Pick<AgentRecord, "activity" | "toolCalls" | "usage" | "contextTokens" | "contextWindow">>): void;
}

export interface Launcher {
	launch(record: AgentRecord, hooks: ChildHooks): Promise<ChildHandle>;
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
