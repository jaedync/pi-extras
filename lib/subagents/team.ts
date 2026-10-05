/**
 * The team: every child agent's record, the concurrency queue, nesting, and
 * message routing between `main`, children and siblings. Sessions are made by
 * an injected launcher, so all of this runs in tests without a model.
 *
 * Delivery rules:
 * - To `main`: handed to `deliverToMain`, which decides whether it wakes.
 * - To a running child: steered in after its current tool call.
 * - To a finished child: a question or anything from its parent resumes it;
 *   a sibling's note waits in its inbox for the next run.
 * - A reply to someone blocked on a question resolves that question instead.
 * The inbox, the answers a child is owed and what was steered into it unread
 * live on its record, so the index keeps them across a restart or crash.
 * A run whose model can't serve it goes on, as the same run, on a fallback
 * model (fallback.ts).
 * A child is not done until its own children have reported. A run that a
 * peer's message started and that ends idle reports to its parent without
 * waking it: main reads it at its next turn, a child parent at its next run.
 *
 * Sessions are released once a child ends: at once when it failed or was
 * stopped, after a quiet spell when it finished, since a follow-up often
 * comes quickly. A message to a released child relaunches it from its
 * session file with its context, so a long session's memory stays bounded.
 */
import { randomUUID } from "node:crypto";
import { EVERYONE, MAIN, nameFor, USER } from "./names.ts";
import { noteText, questionText, reportText } from "./format.ts";
import { budgetError, type BudgetUse, RunBudgets, type RunLimits } from "./budget.ts";
import { EditLocks } from "./edit-lock.ts";
import { fallbackNote, planFallback } from "./fallback.ts";
import { stillUnread, unreadToInbox } from "./mailbox.ts";
import { saveReport } from "./reports.ts";
import { createWorktree, workspaceError } from "./worktree.ts";
import {
	ACTIVE_STATES, type AgentRecord, type ChildHandle, LIVE_STATES, type Launcher, type MainDelivery, NO_USAGE, type SpawnRequest,
} from "./types.ts";

export interface TeamOptions {
	launcher: Launcher;
	/** Main's checkout; helpers inherit their parent's isolated workspace. */
	cwd?: string;
	deliverToMain(delivery: MainDelivery): void;
	maxConcurrent: number;
	maxDepth: number;
	replyTimeoutMs: number;
	/**
	 * The child's session file, fixed before it starts so the spawn result can
	 * name it and Status Plus counts the child's usage as it accrues.
	 */
	sessionFileFor?: (name: string) => string | undefined;
	now?: () => number;
	warn?: (message: string) => void;
	/** Restored sessions have no handle until resumed, but their inspector still has a transcript. */
	messagesFor?: (record: AgentRecord) => readonly unknown[];
	prepareResume?: (record: AgentRecord) => { model: string; note?: string; notice?: string };
	/** How long a finished child keeps its session in memory before it is released; default IDLE_RELEASE_MS. */
	idleReleaseMs?: number;
	/** Each run's limits when the spawn names none; without them a run has no limit. */
	runBudget?: RunLimits;
	/** Model references a run goes on with, in order, when its model can't serve it (fallback.ts); unset or empty turns fallback off. */
	fallbackModels?: readonly string[];
}

/** A follow-up to a report usually comes within a minute or two; after that a relaunch costs less than holding the session. */
export const IDLE_RELEASE_MS = 120_000;

export type SendResult =
	| { ok: true; delivered: "steered" | "resumed" | "queued" | "replied" | "main" | "inbox"; reply?: string; notice?: string }
	| { ok: false; error: string };

interface Pending {
	to: string;
	resolve(reply: string): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

type Listener = (record: AgentRecord | null) => void;

const CHECK_FIRST = "Its last tool call may not have completed and files may have changed. Verify the current state before continuing.";

/** What a resumed agent is told first about how its last run ended, when that run did not finish. */
function resumeWarning(target: AgentRecord): string {
	if (target.state === "interrupted") return `Your previous run was interrupted. ${CHECK_FIRST}\n\n`;
	if (target.state === "failed") return `Your previous run failed: ${target.error ?? "unknown error"}. ${CHECK_FIRST}\n\n`;
	if (target.state === "stopped" && target.stopReason) return `Your previous run was stopped ${target.stopReason}. This run has a fresh budget. ${CHECK_FIRST}\n\n`;
	if (target.state === "stopped") return `Your previous run was stopped. ${CHECK_FIRST}\n\n`;
	return "";
}

export class Team {
	private readonly records = new Map<string, AgentRecord>();
	private readonly handles = new Map<string, ChildHandle>();
	/** Pi rebuilds shorter message lists on compaction, but retains message identities. */
	private readonly runStarts = new Map<string, ReadonlySet<unknown>>();
	private readonly opening = new Set<Promise<ChildHandle | null>>();
	/** Open questions by asker; a child may wait on several agents at once. */
	private readonly questions = new Map<string, Pending[]>();
	private readonly waiters = new Map<string, Array<(record: AgentRecord) => void>>();
	private readonly listeners = new Set<Listener>();
	private readonly queue: string[] = [];
	/** Children that owe main an answer; their next message to main wakes it. */
	private readonly owesMain = new Set<string>();
	/** Stops between marking the record stopped and handing its report up. */
	private readonly ending = new Set<string>();
	/** Children main resumed from idle with a question: only that answer can stand in for the run's report. */
	private readonly resumedToAnswer = new Set<string>();
	/** Tool calls a child had finished when it gave that answer. */
	private readonly answeredAt = new Map<string, number>();
	private closed = false;
	private closing: Promise<void> | undefined;
	private readonly resumePrompts = new Map<string, string>();
	/** Runs a peer's message started; main, its parent or the user writing to it during the run makes it theirs. */
	private readonly peerRuns = new Set<string>();
	/** Stopped by their own parent, which already knows; no report goes up. */
	private readonly stoppedByParent = new Set<string>();
	private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Runs moving to a fallback model, with what they had used of their budget: the same run goes on. */
	private readonly continuing = new Map<string, BudgetUse | undefined>();
	private readonly budgets: RunBudgets;
	private readonly locks = new EditLocks(this);
	private readonly now: () => number;
	private readonly options: TeamOptions;

	constructor(options: TeamOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.budgets = new RunBudgets({ now: this.now, over: (name, reason) => void this.stop(name, { reason }) });
	}

	get(name: string): AgentRecord | undefined {
		return this.records.get(name);
	}

	list(): AgentRecord[] {
		return [...this.records.values()];
	}

	live(): AgentRecord[] {
		return this.list().filter((record) => LIVE_STATES.has(record.state));
	}

	onChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Restored records reserve names without starting work or replaying reports; what they were steered and never read waits for their next run. */
	restore(records: readonly AgentRecord[]): void {
		for (const record of records) {
			if (this.records.has(record.name)) continue;
			const unread = record.unread?.length ? unreadToInbox(record, this.options.messagesFor?.(record) ?? []) : {};
			this.put({ ...record, blocking: false, usage: { ...record.usage }, ...unread });
		}
	}

	markRecovery(name: string, patch: Partial<AgentRecord>): void { this.patch(name, patch); }

	/** Validates depth, names the child, and starts or queues it. */
	spawn(request: SpawnRequest): { ok: true; record: AgentRecord } | { ok: false; error: string } {
		if (this.closed) return { ok: false, error: "The session is shutting down." };
		const parent = request.parent === MAIN ? null : this.records.get(request.parent);
		if (request.parent !== MAIN && !parent) return { ok: false, error: `Unknown parent ${request.parent}.` };
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > this.options.maxDepth) return { ok: false, error: `Subagents cannot start subagents here (depth limit ${this.options.maxDepth}).` };
		const name = nameFor(request.name, request.task, (candidate) => this.records.has(candidate));
		if (request.isolation !== undefined && request.isolation !== "shared" && request.isolation !== "worktree") return { ok: false, error: "Unknown isolation. Use shared or worktree." };
		const badBudget = budgetError("maxMinutes", request.maxMinutes) ?? budgetError("maxCost", request.maxCost);
		if (badBudget) return { ok: false, error: badBudget };
		const maxMinutes = request.maxMinutes ?? this.options.runBudget?.minutes;
		const maxCost = request.maxCost ?? this.options.runBudget?.cost;
		let worktree = parent?.worktree;
		if (request.isolation === "worktree") {
			const cwd = parent?.worktree?.path ?? this.options.cwd;
			if (!cwd) return { ok: false, error: "Worktree isolation needs a git repository in the parent's workspace." };
			try { worktree = createWorktree(cwd, name); }
			catch (error) { return { ok: false, error: (error as Error).message }; }
		}
		const sessionFile = this.options.sessionFileFor?.(name);
		// A read-only agent can't get write tools through a subagent of its own: its subagents are read-only too.
		const record: AgentRecord = {
			name, parent: request.parent, depth, task: request.task, model: request.model, readOnly: request.readOnly || parent?.readOnly === true,
			fork: request.fork, blocking: request.blocking, state: "queued", createdAt: this.now(), activity: "queued",
			toolCalls: 0, usage: NO_USAGE, runs: 0, autoResumeAttempts: 0, ...(request.thinking ? { thinking: request.thinking } : {}),
			...(sessionFile ? { sessionFile } : {}),
			...(request.group ? { group: request.group } : {}),
			...(request.tools ? { tools: [...request.tools] } : {}),
			...(worktree ? { worktree: { ...worktree } } : {}),
			...(maxMinutes !== undefined ? { maxMinutes } : {}),
			...(maxCost !== undefined ? { maxCost } : {}),
		};
		this.put(record);
		this.queue.push(name);
		this.pump();
		return { ok: true, record: this.records.get(name)! };
	}

	/** Before a child's `edit` or `write` call: takes its workspace's lock, or says who holds it (edit-lock.ts). */
	claimEdit(name: string): string | undefined {
		return this.locks.claim(name);
	}

	/** Resolves once the child reaches idle, failed or stopped. */
	whenDone(name: string): Promise<AgentRecord> {
		const record = this.records.get(name);
		if (!record) return Promise.reject(new Error(`Unknown agent ${name}.`));
		if (!LIVE_STATES.has(record.state)) return Promise.resolve(record);
		return new Promise((resolve) => this.waiters.set(name, [...(this.waiters.get(name) ?? []), resolve]));
	}

	/** Detach a blocking parent: its report now arrives as a message instead. */
	detach(name: string): void {
		const record = this.records.get(name);
		if (record?.blocking) this.patch(name, { blocking: false });
	}

	async send(from: string, to: string, text: string, options: { expectReply?: boolean; signal?: AbortSignal; automatic?: boolean } = {}): Promise<SendResult> {
		if (this.closed) return { ok: false, error: "The session is shutting down." };
		if (to === from) return { ok: false, error: "That is you." };
		if (to === EVERYONE) return this.broadcast(from, text, options.expectReply === true);
		// The user can answer any question, whoever it was put to.
		const open = this.questions.get(to) ?? [];
		const pending = from === USER ? open[0] : open.find((question) => question.to === from);
		if (pending) {
			pending.resolve(text);
			if (from === USER) this.options.deliverToMain({ kind: "relay", from, to, text, answered: true });
			return { ok: true, delivered: "replied" };
		}
		// Its parent is blocked on this agent's report: a note would only land after it, and a
		// question could never be answered, so the question ends the wait instead.
		const asker = this.records.get(from);
		if (asker?.blocking && to === asker.parent) {
			if (!options.expectReply) return { ok: false, error: `${to} is waiting for your report; put this in it instead.` };
			this.patch(from, { blocking: false });
		}
		// A child waits only on main and its parent: they never wait on it, so no loop of waiting
		// agents can form. Anyone else answers by message, which wakes it.
		const waits = options.expectReply === true && (to === MAIN || to === asker?.parent);
		const body = options.expectReply ? questionText(from, text) : noteText(from, text);
		const said = `${options.expectReply ? "Question" : "Message"} from ${from}: ${text}`;
		if (options.expectReply && !waits && asker) {
			const result = this.deliverToChild(from, to, body, true, said, options.automatic);
			if (result.ok) this.patch(from, { owed: [...new Set([...(this.records.get(from)?.owed ?? []), to])] });
			return result;
		}
		// Main never blocks: its question is delivered, and the answer wakes it later.
		if (from === MAIN && options.expectReply) {
			const idle = this.records.get(to)?.state === "idle";
			const result = this.deliverToChild(from, to, body, true, said, options.automatic);
			if (result.ok) this.owesMain.add(to);
			if (result.ok && idle && result.delivered === "resumed") this.resumedToAnswer.add(to);
			return result;
		}
		let result: SendResult;
		if (to === MAIN) {
			const answering = this.owesMain.delete(from);
			const answerer = this.records.get(from);
			if (answering && answerer && this.resumedToAnswer.delete(from) && this.answerStandsAlone(from)) {
				this.answeredAt.set(from, answerer.toolCalls);
				this.patch(from, { answeredMain: true });
			}
			this.options.deliverToMain(options.expectReply ? { kind: "question", from, text } : answering ? { kind: "reply", from, text } : { kind: "note", from, text });
			result = { ok: true, delivered: "main" };
		} else {
			const answers = this.payOwed(to, from);
			result = this.deliverToChild(from, to, body, options.expectReply === true || answers, said, options.automatic);
			// Main should never be surprised by work the user asked for directly.
			if (result.ok && from === USER) this.options.deliverToMain({ kind: "relay", from, to, text, answered: false });
		}
		if (!result.ok || !options.expectReply) return result;
		return this.awaitReply(from, to, options.signal);
	}

	/** The child's messages so far; empty before it starts. */
	messages(name: string): readonly unknown[] {
		const record = this.records.get(name);
		return this.handles.get(name)?.messages() ?? (record ? this.options.messagesFor?.(record) ?? [] : []);
	}

	/** The reply a live child is writing now; none for a child with no session in this process. */
	streaming(name: string): unknown {
		return this.handles.get(name)?.streaming?.();
	}

	/** A live child's own definition of one of its tools. */
	tool(name: string, toolName: string): object | undefined {
		return this.handles.get(name)?.tool?.(toolName);
	}

	/**
	 * Stops a child and everything under it, and returns it as it ended;
	 * undefined when it had already ended. Stopped `by` its own parent, no
	 * report goes up: the parent asked for it and has the record. A `reason`
	 * (a run over its budget) goes into that report.
	 */
	async stop(name: string, options: { by?: string; reason?: string } = {}): Promise<AgentRecord | undefined> {
		const record = this.records.get(name);
		if (!record || (!LIVE_STATES.has(record.state) && record.state !== "interrupted")) return undefined;
		if (options.by !== undefined && options.by === record.parent) this.stoppedByParent.add(name);
		for (const child of this.list().filter((entry) => entry.parent === name)) await this.stop(child.name, { by: name });
		this.queue.splice(0, this.queue.length, ...this.queue.filter((queued) => queued !== name));
		this.resumePrompts.delete(name);
		for (const question of this.questions.get(name) ?? []) question.reject(new Error("stopped"));
		const handle = this.handles.get(name);
		this.ending.add(name);
		this.patch(name, { state: "stopped", endedAt: this.now(), activity: null, stopReason: options.reason, report: this.runText(name), ...this.unreadLeft(name) });
		await handle?.abort().catch(() => undefined);
		this.patch(name, { report: this.runText(name) });
		this.finish(name);
		return this.records.get(name);
	}

	/** Whether a stop is still aborting a child whose report has not been handed up yet. */
	stopping(): boolean {
		return this.ending.size > 0;
	}

	/** Whether `name` is `ancestor` or sits anywhere under it. */
	under(name: string, ancestor: string): boolean {
		for (let current = this.records.get(name); current; current = this.records.get(current.parent)) {
			if (current.parent === ancestor) return true;
		}
		return false;
	}

	/** Freeze records before aborting, so SDK cancellation cannot turn shutdown into a failure. */
	interrupt(reason: AgentRecord["interruptedBy"] = "quit", owner?: string): void {
		this.closed = true;
		for (const record of this.live()) this.patch(record.name, { state: "interrupted", endedAt: this.now(), blocking: false,
			interruptedBy: reason, interruptionId: randomUUID(), interruptedOwner: owner, interruptionAnnounced: false,
			autoResumeAttempts: record.autoResumeAttempts ?? 0 });
		this.queue.splice(0);
		for (const questions of this.questions.values()) for (const question of questions) question.reject(new Error("interrupted"));
		for (const [name, waiters] of this.waiters) for (const resolve of waiters) resolve(this.records.get(name)!);
		this.waiters.clear();
	}

	/** Releases sessions without sending misleading stopped reports to the old parent. */
	close(reason: AgentRecord["interruptedBy"] = "quit", owner?: string): Promise<void> {
		if (this.closing) return this.closing;
		this.interrupt(reason, owner);
		this.budgets.clear();
		for (const timer of this.releaseTimers.values()) clearTimeout(timer);
		this.releaseTimers.clear();
		return this.closing = (async () => {
			await Promise.all([
				Promise.allSettled([...this.handles.values()].map(async (handle) => {
					try { await handle.abort(); } finally { await handle.dispose(); }
				})),
				Promise.allSettled([...this.opening]),
			]);
			this.handles.clear();
		})();
	}

	private put(record: AgentRecord): void {
		this.records.set(record.name, record);
		this.budgets.follow(record.name, record.state);
		this.locks.follow(record);
		for (const listener of this.listeners) listener(record);
	}

	private patch(name: string, patch: Partial<AgentRecord>): void {
		const current = this.records.get(name);
		if (current) this.put({ ...current, ...patch });
	}

	private pump(): void {
		let active = this.list().filter((record) => ACTIVE_STATES.has(record.state)).length;
		while (!this.closed && active < this.options.maxConcurrent && this.queue.length > 0) {
			const name = this.queue.shift()!;
			if (this.records.get(name)?.state !== "queued") continue;
			active++;
			void this.start(name);
		}
	}

	private async start(name: string): Promise<void> {
		const startedAt = this.continuing.has(name) ? this.records.get(name)?.startedAt : undefined;
		this.patch(name, { state: "starting", startedAt: startedAt ?? this.now(), activity: "starting" });
		const opening = this.open(name);
		this.opening.add(opening);
		let handle: ChildHandle | null;
		try { handle = await opening; }
		catch (error) {
			if (!this.closed) {
				// A fallback model that can't launch is one more model that can't serve the run.
				if (this.continuing.has(name)) this.failOrFallBack(name, error);
				else if (this.resumePrompts.has(name)) this.resumeFailed(name, error);
				else this.fail(name, error);
			}
			return;
		} finally { this.opening.delete(opening); }
		if (!handle || this.closed) return;
		this.patch(name, handle.sessionFile ? { sessionFile: handle.sessionFile } : {});
		const inbox = this.takeInbox(name);
		const saved = this.records.get(name)!;
		const resumed = this.resumePrompts.get(name);
		const unstarted = saved.runs === 0 || !handle.messages().some((message) => (message as { role?: string }).role === "user");
		const prompt = resumed ? `${unstarted ? `${saved.task}\n\n` : ""}${resumed}` : saved.task;
		this.resumePrompts.delete(name);
		await this.run(name, [prompt, ...inbox].join("\n\n"));
	}

	/** Launch failures are not completed child runs and must not publish over a prior report. */
	private resumeFailed(name: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const previous = this.records.get(name)!;
		this.resumePrompts.delete(name);
		this.runStarts.delete(name);
		this.peerRuns.delete(name);
		this.forgetAnswer(name);
		this.patch(name, { state: "interrupted", error: message, restoreError: message, launchError: message,
			launchFailures: (previous.launchFailures ?? 0) + 1, endedAt: this.now(), activity: `resume launch failed: ${message}`,
			interruptedBy: "quit", interruptionId: randomUUID(), interruptionAnnounced: false });
		const record = this.records.get(name)!;
		for (const resolve of this.waiters.get(name) ?? []) resolve(record);
		this.waiters.delete(name);
		this.owesMain.delete(name);
		const failure = { ...record, reportFile: undefined,
			report: `Resume launch failed: ${message}. The child remains interrupted; fix the problem and resume it again.` };
		const asked = this.questions.get(record.parent)?.find((question) => question.to === name);
		if (asked) asked.resolve(reportText(failure, this.now()));
		else if (record.parent === MAIN) this.options.deliverToMain({ kind: "report", record: failure });
		else this.deliverToChild(name, record.parent, reportText(failure, this.now()), true);
		this.pump();
	}

	/** Shutdown must wait for launchers too, or they can write into a newly reopened transcript. */
	private async open(name: string): Promise<ChildHandle | null> {
		const handle = await this.options.launcher.launch(this.records.get(name)!, {
			update: (patch) => {
				const record = this.records.get(name);
				if (!record || !LIVE_STATES.has(record.state)) return;
				this.patch(name, { ...patch, lastActivityAt: this.now(), ...(this.workedSinceAnswer(name, patch) ? { answeredMain: undefined } : {}) });
				if (patch.usage) this.budgets.spent(name, patch.usage.cost);
				this.forgetRead(name);
			},
		});
		if (this.closed || this.records.get(name)?.state === "stopped") {
			await handle.dispose();
			return null;
		}
		this.handles.set(name, handle);
		return handle;
	}

	private async run(name: string, text: string): Promise<void> {
		const handle = this.handles.get(name);
		if (!handle) return;
		this.keep(name);
		const record = this.records.get(name)!;
		this.runStarts.set(name, new Set(handle.messages()));
		const used = this.continuing.get(name);
		const continued = this.continuing.delete(name);
		this.patch(name, { state: "running", activity: "thinking", runs: continued ? record.runs : record.runs + 1, endedAt: undefined });
		this.budgets.start(name, this.limits(record), record.usage.cost, used);
		try {
			let next: string | null = text;
			while (next !== null) {
				await handle.prompt(next);
				if (this.closed || this.records.get(name)?.state === "stopped") return;
				const late = [...handle.takeQueued(), ...this.takeInbox(name)];
				next = late.length > 0 ? late.join("\n\n") : null;
			}
		} catch (error) {
			if (!this.closed && this.records.get(name)?.state !== "stopped") this.failOrFallBack(name, error);
			return;
		}
		this.settle(name, this.runText(name));
	}

	/**
	 * A run its model can't serve goes on from its session on the next fallback
	 * model, the way a resume does, and stays the same run; any other failure, or
	 * one with no fallback left, ends it.
	 */
	private failOrFallBack(name: string, error: unknown): void {
		const record = this.records.get(name)!;
		const plan = planFallback(record, error instanceof Error ? error.message : String(error), this.options.fallbackModels ?? [], this.now());
		if (!plan.ok) {
			this.continuing.delete(name);
			this.resumePrompts.delete(name);
			return this.fail(name, plan.error);
		}
		const { step } = plan;
		// Read before the state change below ends the clock; a launch that failed has none left to read.
		this.continuing.set(name, this.continuing.get(name) ?? this.budgets.used(name));
		this.resumePrompts.set(name, fallbackNote(step));
		this.patch(name, { ...this.unreadLeft(name), state: "queued", model: step.to, fallbacks: [...(record.fallbacks ?? []), step], activity: `switching to ${step.to}` });
		void this.release(name);
		this.queue.push(name);
		this.pump();
	}

	/** Limits fixed at spawn; records saved before budgets existed get today's defaults. */
	private limits(record: AgentRecord): RunLimits {
		return { minutes: record.maxMinutes ?? this.options.runBudget?.minutes, cost: record.maxCost ?? this.options.runBudget?.cost };
	}

	/** A run that ended normally read everything steered into it, or took it as its last prompt. */
	private settle(name: string, report: string | undefined): void {
		const hasLiveChildren = this.list().some((entry) => entry.parent === name && LIVE_STATES.has(entry.state));
		const owing = this.records.get(name)?.owed ?? [];
		if (hasLiveChildren || owing.length > 0) {
			// Its report waits for what it is still owed; that arrival resumes it.
			const activity = hasLiveChildren ? "waiting on its subagents" : `waiting for ${owing.join(", ")} to answer`;
			this.patch(name, { state: "waiting", activity, report, unread: undefined });
			this.pump();
			return;
		}
		this.patch(name, { state: "idle", endedAt: this.now(), activity: null, report, unread: undefined });
		this.finish(name);
	}

	private fail(name: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		// A failure after an answer is news main has not heard.
		this.patch(name, { state: "failed", endedAt: this.now(), activity: null, error: message, answeredMain: undefined, report: this.runText(name), ...this.unreadLeft(name) });
		this.finish(name);
	}

	/** This run's messages, which are where a steered message shows up once the child reads it. */
	private runMessages(name: string): readonly unknown[] {
		const start = this.runStarts.get(name);
		return this.handles.get(name)?.messages().filter((message) => !start?.has(message)) ?? [];
	}

	/** Drops from `unread` what the child has now read. */
	private forgetRead(name: string): void {
		const unread = this.records.get(name)?.unread;
		if (!unread?.length) return;
		const left = stillUnread(unread, this.runMessages(name));
		if (left.length < unread.length) this.patch(name, { unread: left.length > 0 ? left : undefined });
	}

	/** For a run that ends early: its session's queue goes with it, so what it never read waits in its inbox. */
	private unreadLeft(name: string): Partial<AgentRecord> {
		const record = this.records.get(name);
		return record ? unreadToInbox(record, this.runMessages(name)) : {};
	}

	/**
	 * The call that carried the answer ends right after it; any call after that is
	 * work main has not heard about, so the report must wake main after all.
	 */
	private workedSinceAnswer(name: string, patch: { toolCalls?: number }): boolean {
		const at = this.answeredAt.get(name);
		if (at === undefined || patch.toolCalls === undefined || patch.toolCalls <= at + 1) return false;
		this.answeredAt.delete(name);
		return true;
	}

	/**
	 * Whether the response carrying the answer made only this `message` call. Its
	 * other calls may finish before the answer is sent (sequential execution) or
	 * run inside another tool, so neither shows up as work after the answer.
	 */
	private answerStandsAlone(name: string): boolean {
		const messages = this.handles.get(name)?.messages() ?? [];
		const last = [...messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant") as { content?: unknown } | undefined;
		const calls = Array.isArray(last?.content) ? last.content.filter((part) => (part as { type?: unknown }).type === "toolCall") : [];
		return calls.length === 1 && (calls[0] as { name?: unknown }).name === "message";
	}

	/** Anything delivered to a child (steering, a note, a subagent's report, a resume) is new work its report must tell main about. */
	private forgetAnswer(name: string): void {
		this.resumedToAnswer.delete(name);
		this.answeredAt.delete(name);
		if (this.records.get(name)?.answeredMain) this.patch(name, { answeredMain: undefined });
	}

	private runText(name: string): string | undefined {
		const start = this.runStarts.get(name);
		if (start === undefined) return undefined;
		const messages = this.handles.get(name)?.messages().filter((message) => !start.has(message)) ?? [];
		const last = [...messages].reverse().find((message) => {
			const entry = message as { role?: unknown; stopReason?: unknown; content?: unknown };
			return entry.role === "assistant" && !(entry.stopReason === "aborted" && Array.isArray(entry.content) && entry.content.length === 0);
		}) as { content?: unknown } | undefined;
		const text = typeof last?.content === "string" ? last.content : Array.isArray(last?.content)
			? last.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") : "";
		return text.trim() || undefined;
	}

	/** Hands the report up and frees the slot. */
	private finish(name: string): void {
		this.ending.delete(name);
		this.continuing.delete(name);
		// Answers still owed to it die with its run; a message resumes it to ask again.
		const record = saveReport({ ...this.records.get(name)!, owed: undefined }, this.options.warn ?? console.warn);
		this.runStarts.delete(name);
		this.put(record);
		this.answeredAt.delete(name);
		this.resumedToAnswer.delete(name);
		for (const resolve of this.waiters.get(name) ?? []) resolve(record);
		this.waiters.delete(name);
		// The report answers anything main was waiting on.
		const owedMain = this.owesMain.delete(name);
		const unanswered: string[] = [];
		let parentAsked = false;
		for (const asker of this.list().filter((entry) => entry.owed?.includes(name)).map((entry) => entry.name)) {
			if (!this.payOwed(asker, name)) continue;
			if (asker === record.parent) parentAsked = true;
			else unanswered.push(asker);
		}
		// A peer's run that ended quietly is news for the parent's next turn, unless it answers the parent or main.
		const quiet = this.peerRuns.delete(name) && record.state === "idle" && !parentAsked && !owedMain;
		// A parent waiting on this child's answer gets the report as that answer.
		const asked = this.questions.get(record.parent)?.find((question) => question.to === name);
		const silent = this.stoppedByParent.delete(name);
		if (asked) {
			asked.resolve(reportText(record, this.now()));
		} else if (silent) {
			// Its parent stopped it and has the record from that call.
		} else if (record.parent === MAIN) {
			if (!record.blocking) this.options.deliverToMain({ kind: "report", record, ...(quiet ? { quiet } : {}) });
		} else if (!record.blocking) {
			this.deliverToChild(record.name, record.parent, reportText(record, this.now()), !quiet, `Report from ${record.name}`);
		}
		// Its parent has the report; anyone else it owed an answer gets how its run ended instead.
		for (const asker of unanswered) this.deliverToChild(name, asker, `${name} ended without answering you. ${reportText(record, this.now())}`, true, `Report from ${name}`);
		// Anyone else waiting on it would wait out the whole timeout for an answer that can't come.
		for (const [asker, questions] of this.questions) {
			if (asker === record.parent) continue;
			for (const question of questions.filter((open) => open.to === name)) question.reject(new Error(`${name} ended without answering (${record.state}). Continue without its answer, or message it again: a finished agent resumes to handle a message.`));
		}
		this.scheduleRelease(name, record.state);
		this.pump();
	}

	/** A failed or stopped child's session goes at once; a finished one's after a quiet spell. */
	private scheduleRelease(name: string, state: AgentRecord["state"]): void {
		if (!this.handles.has(name)) return;
		if (state === "failed" || state === "stopped") return void this.release(name);
		if (state !== "idle") return;
		this.keep(name);
		const timer = setTimeout(() => {
			this.releaseTimers.delete(name);
			if (this.records.get(name)?.state === "idle") void this.release(name);
		}, this.options.idleReleaseMs ?? IDLE_RELEASE_MS);
		timer.unref?.();
		this.releaseTimers.set(name, timer);
	}

	/** A new run keeps the session it is about to use. */
	private keep(name: string): void {
		const timer = this.releaseTimers.get(name);
		if (timer) clearTimeout(timer);
		this.releaseTimers.delete(name);
	}

	private async release(name: string): Promise<void> {
		const handle = this.handles.get(name);
		if (!handle) return;
		this.handles.delete(name);
		this.keep(name);
		try { await handle.dispose(); }
		catch (error) { (this.options.warn ?? console.warn)(`subagents: releasing ${name}'s session failed: ${(error as Error).message}`); }
	}

	/** Settles what `from` owed `asker`; true when it owed it an answer. */
	private payOwed(asker: string, from: string): boolean {
		const owing = this.records.get(asker)?.owed;
		if (!owing?.includes(from)) return false;
		const rest = owing.filter((agent) => agent !== from);
		this.patch(asker, { owed: rest.length > 0 ? rest : undefined });
		return true;
	}

	/** `said` is how the report of a run this message starts names it. */
	private deliverToChild(from: string, to: string, body: string, wakes: boolean, said = body, automatic = false): SendResult {
		const target = this.records.get(to);
		if (!target) return { ok: false, error: `No agent named ${to}. ${this.knownNames()}` };
		const resumes = wakes || from === target.parent || from === USER;
		// An ended run's session is on disk, so its parent or the user can take it up again; a peer can't.
		const ended = target.state === "failed" || target.state === "stopped";
		if (ended && !(from === target.parent || from === USER)) return { ok: false, error: `${to} has ${target.state}; only ${target.parent} or the user can resume it.` };
		const missing = resumes && !LIVE_STATES.has(target.state) && target.worktree ? workspaceError(target.worktree.path) : undefined;
		if (missing) return { ok: false, error: missing };
		const peer = from !== MAIN && from !== USER && from !== target.parent && !this.under(from, to);
		if (from === MAIN || from === USER || from === target.parent) this.peerRuns.delete(to);
		this.forgetAnswer(to);
		const handle = this.handles.get(to);
		if ((target.state === "running" || target.state === "asking") && handle) {
			handle.steer(body);
			this.patch(to, { unread: [...(this.records.get(to)?.unread ?? []), body] });
			return { ok: true, delivered: "steered" };
		}
		// Released when it ended; should it still be held, let it go before a fresh launch takes its place.
		if (ended && handle) void this.release(to);
		if ((!handle || ended) && resumes && (target.state === "idle" || target.state === "waiting" || target.state === "interrupted" || ended)) {
			const warning = resumeWarning(target);
			let prepared: { model: string; note?: string; notice?: string } = { model: target.model };
			try { if (!automatic) prepared = this.options.prepareResume?.(target) ?? prepared; }
			catch (error) { return { ok: false, error: (error as Error).message }; }
			this.resumePrompts.set(to, `${warning}${prepared.note ? `${prepared.note}\n\n` : ""}${body}`);
			if (target.state !== "waiting") this.startedBy(to, peer);
			this.patch(to, { state: "queued", model: prepared.model, resumedBy: { from, text: said }, startedAt: this.now(), error: undefined, stopReason: undefined, restoreError: undefined, launchError: undefined,
				...(!automatic ? { interruptionId: undefined, interruptedBy: undefined, interruptionAnnounced: undefined, autoResumeAttempts: 0 } : {}) });
			this.queue.push(to);
			this.pump();
			return { ok: true, delivered: "resumed", ...(prepared.notice ? { notice: prepared.notice } : {}) };
		}
		if ((target.state === "idle" || target.state === "waiting") && handle && resumes) {
			// A new run: time it on its own and forget what the last one answered.
			if (target.state === "idle") {
				this.startedBy(to, peer);
				this.patch(to, { resumedBy: { from, text: said }, startedAt: this.now(),
					...(!automatic && (from === MAIN || from === USER) ? { interruptionId: undefined, interruptedBy: undefined, interruptionAnnounced: undefined, autoResumeAttempts: 0 } : {}) });
			}
			void this.run(to, [...this.takeInbox(to), body].join("\n\n"));
			return { ok: true, delivered: "resumed" };
		}
		this.patch(to, { inbox: [...(this.records.get(to)?.inbox ?? []), body] });
		return { ok: true, delivered: target.state === "queued" || target.state === "starting" ? "queued" : "inbox" };
	}

	/** A new run from idle or interrupted; a peer started it unless main, its parent, the user or its own subagent did. */
	private startedBy(name: string, peer: boolean): void {
		if (peer) this.peerRuns.add(name);
		else this.peerRuns.delete(name);
	}

	private async broadcast(from: string, text: string, expectReply: boolean): Promise<SendResult> {
		if (expectReply) return { ok: false, error: `Ask one agent at a time; "${EVERYONE}" cannot reply.` };
		const others = this.list().filter((record) => record.name !== from && LIVE_STATES.has(record.state));
		for (const record of others) this.deliverToChild(from, record.name, noteText(from, text), false);
		if (from !== MAIN) this.options.deliverToMain({ kind: "note", from, text });
		return { ok: true, delivered: "steered" };
	}

	private awaitReply(from: string, to: string, signal?: AbortSignal): Promise<SendResult> {
		return new Promise<SendResult>((resolve) => {
			const done = (result: SendResult) => {
				clearTimeout(pending.timer);
				signal?.removeEventListener("abort", onAbort);
				const rest = (this.questions.get(from) ?? []).filter((question) => question !== pending);
				if (rest.length > 0) this.questions.set(from, rest);
				else this.questions.delete(from);
				this.showAsking(from);
				resolve(result);
			};
			const onAbort = () => done({ ok: false, error: "Stopped waiting for a reply." });
			const pending: Pending = {
				to,
				resolve: (reply) => done({ ok: true, delivered: "replied", reply }),
				reject: (error) => done({ ok: false, error: error.message }),
				timer: setTimeout(() => done({
					ok: false,
					error: `No reply from ${to} within ${Math.round(this.options.replyTimeoutMs / 60_000)} min. Continue with your best judgment and say so in your report.`,
				}), this.options.replyTimeoutMs),
			};
			this.questions.set(from, [...(this.questions.get(from) ?? []), pending]);
			this.showAsking(from);
			// An asking agent frees its slot for a queued one.
			this.pump();
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** An asker's state follows its open questions. */
	private showAsking(name: string): void {
		const current = this.records.get(name);
		if (!current) return;
		const waitingOn = (this.questions.get(name) ?? []).map((question) => question.to);
		if (waitingOn.length > 0) {
			this.patch(name, { state: "asking", askingWho: waitingOn.join(", "), activity: `asking ${waitingOn.join(", ")}` });
		} else if (current.state === "asking") {
			this.patch(name, { state: "running", askingWho: undefined, activity: "thinking" });
		}
	}

	private takeInbox(name: string): string[] {
		const inbox = this.records.get(name)?.inbox ?? [];
		if (inbox.length > 0) this.patch(name, { inbox: undefined });
		return inbox;
	}

	private knownNames(): string {
		const names = this.list().map((record) => record.name);
		return names.length > 0 ? `Agents: ${[MAIN, ...names].join(", ")}.` : "There are no subagents.";
	}
}

