/**
 * The team: every child agent's record, the concurrency queue, nesting, and
 * the runs of its children. Messages between `main`, children and siblings go
 * where routing.ts says. Sessions are made by an injected launcher, so all of
 * this runs in tests without a model.
 * A run whose model can't serve it goes on, as the same run, on a fallback
 * model (fallback.ts); one whose session went stale moves to a new session at
 * its next turn boundary (swap.ts).
 * A child is not done until its own children have reported. A run that a
 * peer's message started and that ends idle reports to its parent without
 * waking it: main reads it at its next turn, a child parent at its next run
 * (hand-up.ts).
 * When a child's session is held and when it goes is sessions.ts's to say.
 */
import { randomUUID } from "node:crypto";
import { afterBlock, afterError, queuedActivity, stopOrder } from "./after.ts";
import { MAIN, nameFor } from "./names.ts";
import { budgetError, type BudgetUse, RunBudgets, type RunLimits } from "./budget.ts";
import type { HostTeam } from "./contract.ts";
import { checkError, mergeCheck, RunChecks } from "./checks.ts";
import { checkoutOf } from "./checkout.ts";
import { EditLocks } from "./edit-lock.ts";
import { fallbackNote, planFallback } from "./fallback.ts";
import { messagesSince, stillUnread, unreadToInbox } from "./mailbox.ts";
import { MainAnswers } from "./answers.ts";
import { OpenQuestions } from "./questions.ts";
import { launchPrompt, ResumePrompts } from "./resume-prompts.ts";
import { Slots } from "./slots.ts";
import { handUp, handUpFailure, type HandUpHost } from "./hand-up.ts";
import { saveReport } from "./reports.ts";
import { causeWords, staleCauses, SWAP_NOTE, swapActivity, swapDue, TurnSwaps } from "./swap.ts";
import { Routing, type SendOptions } from "./routing.ts";
import { OpenSessions } from "./sessions.ts";
import { WorkTrees } from "./work-trees.ts";
import { placeChild } from "./placement.ts";
import {
	type AgentRecord, type ChildHandle, LIVE_STATES, type Launcher, type MainDelivery, NO_USAGE, type SpawnRequest, WAITING_FOR_MODEL,
} from "./types.ts";

export interface TeamOptions {
	launcher: Launcher;
	/** Main's working directory; children start there unless a spawn names a cwd, and helpers inherit their parent's. */
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
	/** How long a finished child keeps its session in memory before it is released; default IDLE_RELEASE_MS (sessions.ts). */
	idleReleaseMs?: number;
	/** Each run's limits when the spawn names none; without them a run has no limit. */
	runBudget?: RunLimits;
	/** Model references a run goes on with, in order, when its model can't serve it (fallback.ts); unset or empty turns fallback off. */
	fallbackModels?: readonly string[];
	/** Whether a running child whose session went stale moves to a new session at its next turn boundary (swap.ts); default true. */
	swapAtTurn?: boolean;
	/** Whether a launch now would take `model`; a run on one it would not keeps its session. Unset: every model. */
	modelAllowed?(model: string): boolean;
	/** Writes one line to the operational log: each swap. */
	log?(message: string): void;
}

export type SendResult =
	| { ok: true; delivered: "steered" | "resumed" | "queued" | "replied" | "main" | "inbox"; reply?: string; notice?: string }
	| { ok: false; error: string };

type Listener = (record: AgentRecord | null) => void;

export class Team implements HostTeam {
	private readonly records = new Map<string, AgentRecord>();
	private readonly sessions: OpenSessions;
	private readonly opening = new Set<Promise<ChildHandle | null>>();
	private readonly questions: OpenQuestions;
	private readonly waiters = new Map<string, Array<(record: AgentRecord) => void>>();
	private readonly listeners = new Set<Listener>();
	private readonly slots: Slots;
	/** Stops between marking the record stopped and handing its report up. */
	private readonly ending = new Set<string>();
	private readonly answers = new MainAnswers();
	private closed = false;
	private closing: Promise<void> | undefined;
	private readonly resumePrompts = new ResumePrompts();
	/** Each child's latest launch: a launch or run from before a stop and a relaunch is stale, and ends quietly. */
	private readonly launches = new Map<string, number>();
	/** Stopped by their own parent, which already knows; no report goes up. */
	private readonly stoppedByParent = new Set<string>();
	/** Runs going on in a new session, on a fallback model or after a swap, with what they had used of their budget: the same run goes on. */
	private readonly continuing = new Map<string, BudgetUse | undefined>();
	/** Runs that waited on their subagents or an answer and relaunch to go on, with what they had used: a launch that fails is a failed resume. */
	private readonly woken = new Map<string, BudgetUse | undefined>();
	/** Askers whose answers came, until they have a slot to go on in. */
	private readonly answered = new Map<string, Promise<void>>();
	private readonly swaps = new TurnSwaps();
	private readonly checks = new RunChecks({
		get: (name) => this.records.get(name), patch: (name, patch) => this.patch(name, patch), under: (name, ancestor) => this.under(name, ancestor),
		gone: (name) => this.gone(name), now: () => this.now(), known: () => this.knownNames(),
	});
	private readonly budgets: RunBudgets;
	private readonly locks = new EditLocks(this);
	private readonly workTrees = new WorkTrees();
	private readonly routing: Routing;
	private readonly handUpHost: HandUpHost;
	/** The checkout of main's working directory, looked up at the first need; undefined without one. */
	private mainCheckout: { value: string | undefined } | undefined;
	private readonly now: () => number;
	private readonly options: TeamOptions;

	constructor(options: TeamOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		// An asking agent frees its slot for a queued one.
		this.questions = new OpenQuestions({ replyTimeoutMs: options.replyTimeoutMs, changed: (asker, waitingOn) => { this.showAsking(asker, waitingOn); this.pump(); } });
		this.slots = new Slots({ maxConcurrent: options.maxConcurrent, closed: () => this.closed, list: () => this.list(), get: this.lookup, start: (name) => void this.start(name) });
		this.budgets = new RunBudgets({ now: this.now, over: (name, reason) => void this.stop(name, { reason }) });
		this.sessions = new OpenSessions({ launcher: options.launcher, idle: (name) => this.records.get(name)?.state === "idle", warn: options.warn ?? console.warn,
			...(options.idleReleaseMs !== undefined ? { idleReleaseMs: options.idleReleaseMs } : {}) });
		this.routing = this.router();
		this.handUpHost = { questions: this.questions, routing: this.routing, list: () => this.list(), get: this.lookup, deliverToMain: (delivery) => options.deliverToMain(delivery), now: () => this.now() };
	}

	/** Routing's view of the team (routing.ts). */
	private router(): Routing {
		const { options } = this;
		return new Routing({
			questions: this.questions, answers: this.answers, sessions: this.sessions, checks: this.checks,
			closed: () => this.closed, get: this.lookup, list: () => this.list(), patch: (name, patch) => this.patch(name, patch),
			under: (name, ancestor) => this.under(name, ancestor), now: () => this.now(), known: () => this.knownNames(),
			deliverToMain: (delivery) => options.deliverToMain(delivery),
			...(options.prepareResume ? { prepareResume: (record: AgentRecord) => options.prepareResume!(record) } : {}),
			resumeWith: (name, note, message) => { this.resumePrompts.set(name, { note, message }); },
			goOn: (name) => { this.woken.set(name, this.budgets.used(name)); },
			forgetAnswer: (name) => this.forgetAnswer(name), takeInbox: (name) => this.takeInbox(name),
			enqueue: (name) => { this.slots.enqueue(name); this.pump(); },
			run: (name, text) => this.runWhenFree(name, text),
		});
	}

	get(name: string): AgentRecord | undefined {
		return this.records.get(name);
	}

	private readonly lookup = (name: string): AgentRecord | undefined => this.records.get(name);

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
			const unread = record.unread?.length ? unreadToInbox(record, messagesSince(this.options.messagesFor?.(record) ?? [], record.startedAt)) : {};
			// A checkout follows where the child works: its worktree, its own cwd, or main's directory now,
			// where one without a cwd resumes (child.ts) even when main moved since it was saved.
			const checkout = record.worktree?.path ?? (record.cwd ? record.checkout ?? checkoutOf(record.cwd) : this.sessionCheckout());
			this.put({ ...record, blocking: false, usage: { ...record.usage }, ...unread, ...(checkout ? { checkout } : {}) });
		}
	}

	markRecovery(name: string, patch: Partial<AgentRecord>): void { this.patch(name, patch); }

	/**
	 * Main's next message to `name`, which is paused, waits in its inbox instead
	 * of resuming it: main is answering what it asked before an interruption,
	 * and the policy leaves resuming to the user (host-state.ts).
	 */
	holdAnswer(name: string): void { if (this.records.get(name)?.state === "interrupted") this.patch(name, { answerHeld: true }); }

	/** Validates depth, names the child, and starts or queues it. */
	spawn(request: SpawnRequest): { ok: true; record: AgentRecord } | { ok: false; error: string } {
		if (this.closed) return { ok: false, error: "The session is shutting down." };
		const parent = request.parent === MAIN ? null : this.records.get(request.parent);
		if (request.parent !== MAIN && !parent) return { ok: false, error: `Unknown parent ${request.parent}.` };
		// A tool call still in flight when its agent stopped: a subagent it started now would outlive the stop.
		if (parent && (this.ending.has(parent.name) || parent.state === "stopped")) return { ok: false, error: `${parent.name} is stopping; it can't start subagents now.` };
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > this.options.maxDepth) return { ok: false, error: `Subagents cannot start subagents here (depth limit ${this.options.maxDepth}).` };
		const name = nameFor(request.name, request.task, (candidate) => this.records.has(candidate));
		if (request.isolation !== undefined && request.isolation !== "shared" && request.isolation !== "worktree") return { ok: false, error: "Unknown isolation. Use shared or worktree." };
		const badBudget = budgetError("maxMinutes", request.maxMinutes) ?? budgetError("maxCost", request.maxCost);
		if (badBudget) return { ok: false, error: badBudget };
		const badAfter = request.after?.length ? afterError({ ...request, after: request.after }, this.list(), () => this.knownNames()) : undefined;
		if (badAfter) return { ok: false, error: badAfter };
		const after = request.after?.length ? [...new Set(request.after)] : undefined;
		const badCheck = request.check ? checkError(request.check, { readOnly: request.readOnly || parent?.readOnly === true }) : undefined;
		if (badCheck) return { ok: false, error: badCheck };
		const maxMinutes = request.maxMinutes ?? this.options.runBudget?.minutes;
		const maxCost = request.maxCost ?? this.options.runBudget?.cost;
		const placed = placeChild(request, parent ?? null, name, { ...(this.options.cwd ? { cwd: this.options.cwd } : {}), checkout: () => this.sessionCheckout() });
		if (!placed.ok) return placed;
		const { worktree, cwd: startsIn, checkout } = placed.place;
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
			...(startsIn ? { cwd: startsIn } : {}),
			...(checkout ? { checkout } : {}),
			...(maxMinutes !== undefined ? { maxMinutes } : {}),
			...(maxCost !== undefined ? { maxCost } : {}),
			...(after ? { after } : {}),
			...(request.check ? { check: mergeCheck(request.check) } : {}),
		};
		this.put(record);
		// A subagent its parent blocks on runs in the parent's slot (slots.ts), so it goes ahead of the line.
		this.slots.enqueue(name, request.blocking && parent !== null);
		this.pump();
		return { ok: true, record: this.records.get(name)! };
	}

	/** Before a child's `edit` or `write` of the absolute `target`: takes the lock of its work tree, or says who holds it (edit-lock.ts). */
	claimEdit(name: string, target?: string): string | undefined {
		return this.locks.claim(name, target === undefined ? undefined : this.workTrees.topOf(target));
	}

	/** Whether `name` may edit in the work tree `root` now without taking its lock; its bash calls there are not checked then. */
	mayEdit(name: string, root?: string): boolean {
		return this.locks.holds(name, root);
	}

	/** After `name`'s bash call changed `paths` in the work tree `root`: takes its lock as an edit would, or warns and returns a note for the call's result. */
	bashChanged(name: string, paths: readonly string[], root: string): string | undefined {
		return this.locks.bashChanged(name, paths, root, this.options.warn ?? console.warn);
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

	async send(from: string, to: string, text: string, options: SendOptions = {}): Promise<SendResult> {
		const result = await this.routing.send(from, to, text, options);
		// An asker that got its answer goes on only once a slot is free.
		const slot = this.answered.get(from);
		this.answered.delete(from);
		await slot;
		return result;
	}

	/** The child's messages so far; empty before it starts. */
	messages(name: string): readonly unknown[] {
		const record = this.records.get(name);
		return this.sessions.get(name)?.messages() ?? (record ? this.options.messagesFor?.(record) ?? [] : []);
	}

	/** The reply a live child is writing now; none for a child with no session in this process. */
	streaming(name: string): unknown {
		return this.sessions.get(name)?.streaming?.();
	}

	/** A live child's own definition of one of its tools. */
	tool(name: string, toolName: string): object | undefined {
		return this.sessions.get(name)?.tool?.(toolName);
	}

	/**
	 * Stops a child and everything under it, and returns it as it ended;
	 * undefined when it had already ended. Stopped `by` its own parent, no
	 * report goes up: the parent asked for it and has the record. A `reason`
	 * (a run over its budget) goes into that report.
	 */
	async stop(name: string, options: { by?: string; reason?: string } = {}): Promise<AgentRecord | undefined> {
		const record = this.records.get(name);
		if (!record || this.ending.has(name) || (!LIVE_STATES.has(record.state) && record.state !== "interrupted")) return undefined;
		if (options.by !== undefined && options.by === record.parent) this.stoppedByParent.add(name);
		// Ending before its subagents stop: it can't start another meanwhile, and a second stop finds it ending.
		this.ending.add(name);
		this.slots.remove(name);
		this.parkResume(name);
		for (const question of this.questions.of(name)) question.reject(new Error("stopped"));
		this.checks.abort(name);
		const handle = this.sessions.get(name);
		const launch = this.launches.get(name);
		// An interrupted child has no run in this process; its last report stays.
		const report = () => this.sessions.runText(name) ?? (record.state === "interrupted" ? record.report : undefined);
		this.patch(name, { state: "stopped", endedAt: this.now(), activity: null, stopReason: options.reason, report: report(), ...this.unreadLeft(name) });
		for (const child of stopOrder(this.list().filter((entry) => entry.parent === name))) await this.stop(child.name, { by: name });
		await handle?.abort().catch(() => undefined);
		// A message relaunched it during the abort: the new run is what its parent hears of.
		if (this.launches.get(name) !== launch) {
			this.ending.delete(name);
			this.stoppedByParent.delete(name);
			return this.records.get(name);
		}
		this.patch(name, { report: report() });
		this.finish(name);
		return this.records.get(name);
	}

	/** Whether a stop is still aborting a child whose report has not been handed up yet. */
	stopping(): boolean {
		return this.ending.size > 0;
	}

	/**
	 * No child works, starts, stops or waits on an answer, so closing the team
	 * would interrupt no one. What the team holds beside its records (owed
	 * answers, peer runs, budgets) belongs to live runs, so the index keeps all
	 * that is left.
	 */
	quiet(): boolean {
		return !this.closed && this.live().length === 0 && this.opening.size === 0 && this.ending.size === 0 && this.questions.size === 0;
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
		for (const name of this.resumePrompts.names()) this.parkResume(name);
		for (const record of this.live()) this.patch(record.name, { state: "interrupted", endedAt: this.now(), blocking: false,
			interruptedBy: reason, interruptionId: randomUUID(), interruptedOwner: owner, interruptionAnnounced: false,
			autoResumeAttempts: record.autoResumeAttempts ?? 0 });
		this.slots.clear();
		this.questions.rejectAll(new Error("interrupted"));
		for (const [name, waiters] of this.waiters) for (const resolve of waiters) resolve(this.records.get(name)!);
		this.waiters.clear();
	}

	/** Releases sessions without sending misleading stopped reports to the old parent. */
	close(reason: AgentRecord["interruptedBy"] = "quit", owner?: string): Promise<void> {
		if (this.closing) return this.closing;
		this.interrupt(reason, owner);
		this.budgets.clear();
		this.checks.abort();
		this.sessions.stopTimers();
		return this.closing = (async () => {
			await Promise.all([
				Promise.allSettled(this.sessions.all().map(async (handle) => {
					try { await handle.abort(); } finally { await handle.dispose(); }
				})),
				Promise.allSettled([...this.opening]),
			]);
			this.sessions.clear();
		})();
	}

	private put(next: AgentRecord): void {
		// A held answer is for the paused child that asked; once anything resumes it, main's messages work as usual.
		const record = next.answerHeld && next.state !== "interrupted" ? { ...next, answerHeld: undefined } : next;
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
		this.slots.pump();
		this.showWaits();
	}

	/**
	 * `name` goes on in the session it holds with `go` once a slot is free, so
	 * maxConcurrent holds (slots.ts); resolves when it goes on, or when a stop
	 * or close takes it out of line.
	 */
	private goOnWhenFree(name: string, go: () => void): Promise<void> {
		if (this.slots.free()) { go(); return Promise.resolve(); }
		// Waiting on its subagents, its clock paused; the same run goes on (run()).
		if (this.records.get(name)?.state === "waiting") this.woken.set(name, this.budgets.used(name));
		this.patch(name, { state: "queued", activity: "waiting for a free slot" });
		return new Promise((resolve) => this.slots.goOn(name, () => { go(); resolve(); }, resolve));
	}

	/** A run on the session `name` holds, which a message started; while it waits for a slot, the message waits in its inbox. */
	private runWhenFree(name: string, text: string): void {
		if (this.slots.free()) return void this.run(name, text);
		this.patch(name, { inbox: [text, ...(this.records.get(name)?.inbox ?? [])] });
		void this.goOnWhenFree(name, () => void this.run(name, this.takeInbox(name).join("\n\n")));
	}

	/** A queued spawn says which after agents it still waits for, as the widget shows it. */
	private showWaits(): void {
		for (const record of this.slots.queued().map(this.lookup)) {
			const activity = record?.state === "queued" ? queuedActivity(record, this.lookup) : record?.activity;
			if (record && activity !== record.activity) this.patch(record.name, { activity });
		}
	}

	private async start(name: string): Promise<void> {
		const startedAt = this.continuing.has(name) ? this.records.get(name)?.startedAt : undefined;
		// The same run going on keeps saying why it moves: a fallback model, or a swap.
		this.patch(name, { state: "starting", startedAt: startedAt ?? this.now(), activity: startedAt !== undefined ? this.records.get(name)?.activity ?? "starting" : "starting" });
		const launch = (this.launches.get(name) ?? 0) + 1;
		this.launches.set(name, launch);
		const opening = this.open(name, launch);
		this.opening.add(opening);
		let handle: ChildHandle | null;
		try { handle = await opening; }
		catch (error) {
			if (!this.gone(name, launch)) {
				// A fallback model that can't launch is one more model that can't serve the run.
				if (this.continuing.has(name)) this.failOrFallBack(name, error);
				else if (this.resumePrompts.has(name)) this.resumeFailed(name, error);
				else this.fail(name, error);
			}
			return;
		} finally { this.opening.delete(opening); }
		if (!handle || this.gone(name, launch)) return;
		this.patch(name, handle.sessionFile ? { sessionFile: handle.sessionFile } : {});
		const inbox = this.takeInbox(name);
		const saved = this.records.get(name)!;
		const resumed = this.resumePrompts.take(name);
		const unstarted = saved.runs === 0 || !handle.messages().some((message) => (message as { role?: string }).role === "user");
		const after = saved.runs === 0 && saved.after?.length ? `\n\n${afterBlock(saved, this.lookup)}` : "";
		await this.run(name, launchPrompt({ ...(!resumed || unstarted ? { task: saved.task } : {}), after, ...(resumed ? { resumed } : {}), inbox }));
	}

	/** Launch failures are not completed child runs and must not publish over a prior report. */
	private resumeFailed(name: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const previous = this.records.get(name)!;
		this.parkResume(name);
		this.woken.delete(name);
		this.checks.end(name);
		this.swaps.end(name);
		this.sessions.endRun(name);
		const { owedMain } = this.routing.ended(name);
		this.forgetAnswer(name);
		this.patch(name, { state: "interrupted", error: message, restoreError: message, launchError: message,
			launchFailures: (previous.launchFailures ?? 0) + 1, endedAt: this.now(), activity: `resume launch failed: ${message}`,
			interruptedBy: "quit", interruptionId: randomUUID(), interruptionAnnounced: false });
		const record = this.records.get(name)!;
		for (const resolve of this.waiters.get(name) ?? []) resolve(record);
		this.waiters.delete(name);
		const failure = { ...record, reportFile: undefined,
			report: `Resume launch failed: ${message}. The child remains interrupted; fix the problem and resume it again.` };
		handUpFailure(this.handUpHost, failure, owedMain);
		this.pump();
	}

	/** Shutdown must wait for launchers too, or they can write into a newly reopened transcript. */
	private async open(name: string, launch: number): Promise<ChildHandle | null> {
		const handle = await this.options.launcher.launch(this.records.get(name)!, {
			turnEnded: () => this.turnEnded(name),
			toolCalled: (tool) => this.checks.called(name, tool),
			update: (patch) => {
				const record = this.records.get(name);
				if (!record || this.launches.get(name) !== launch) return;
				// The request a stop aborts still says what it used.
				if (record.state === "stopped" && this.ending.has(name) && patch.usage) return this.patch(name, { usage: patch.usage });
				if (!LIVE_STATES.has(record.state)) return;
				this.patch(name, { ...patch, lastActivityAt: this.now(), ...(this.answers.workedSince(name, patch.toolCalls) ? { answeredMain: undefined } : {}) });
				if (patch.usage) this.budgets.spent(name, patch.usage.cost);
				this.forgetRead(name);
			},
		});
		if (this.gone(name, launch)) {
			await handle.dispose();
			return null;
		}
		this.sessions.hold(name, handle);
		return handle;
	}

	private async run(name: string, text: string): Promise<void> {
		const handle = this.sessions.get(name);
		if (!handle) return;
		this.sessions.startRun(name, handle);
		const launch = this.launches.get(name);
		const record = this.records.get(name)!;
		// A run woken from waiting on its subagents or an answer goes on, with the budget it has left (budget.ts).
		const waking = record.state === "waiting";
		const used = this.continuing.get(name) ?? this.woken.get(name) ?? (waking ? this.budgets.used(name) : undefined);
		const continued = [this.continuing.delete(name), this.woken.delete(name), waking].some(Boolean);
		// A spawn group gathers its first runs' reports (deliver.ts); a later run reports on its own.
		const leavesGroup = !continued && record.runs > 0 && record.group !== undefined;
		this.patch(name, { state: "running", ...WAITING_FOR_MODEL, runs: continued ? record.runs : record.runs + 1, endedAt: undefined,
			...(continued ? {} : { runCost: record.usage.cost, runStart: { usage: { ...record.usage }, toolCalls: record.toolCalls } }), ...(leavesGroup ? { group: undefined } : {}) });
		this.budgets.start(name, this.limits(record), record.usage.cost, used);
		try {
			if (!(await this.work(name, handle, text, launch))) return;
		} catch (error) {
			if (!this.gone(name, launch)) this.failOrFallBack(name, error);
			return;
		}
		this.settle(name, this.sessions.runText(name));
	}

	/**
	 * Prompts until the run has read everything sent to it and, when it would
	 * end idle, its check passed or used its fix rounds (checks.ts). False when
	 * it was stopped, relaunched or the team closed meanwhile.
	 */
	private async work(name: string, handle: ChildHandle, text: string, launch: number | undefined): Promise<boolean> {
		let next: string | null = text;
		while (next !== null) {
			await handle.prompt(next);
			if (this.gone(name, launch)) return false;
			// Its session ended the prompt at a turn boundary to move; what it had not read goes along. Should Pi have
			// gone on after the end (to compact) to an answer, the run ends here instead, and its session goes at the end.
			const causes = this.swaps.take(name);
			if (causes && this.sessions.lastCalls(name).length > 0) return this.swap(name, causes, SWAP_NOTE, false);
			next = this.late(name, handle);
			if (next !== null && this.swapBefore(name, next)) return false;
			if (next !== null || this.waitsFor(name)) continue;
			const fix = await this.checks.run(name, handle);
			if (this.gone(name, launch)) return false;
			// Mail that came during the check goes first, with a fix round's prompt; the check runs again after it.
			const late = this.late(name, handle);
			next = late !== null && fix !== null ? `${late}\n\n${fix}` : late ?? fix;
			if (next !== null && this.swapBefore(name, next)) return false;
		}
		return true;
	}

	/**
	 * At a turn boundary of `name`'s run (child.ts): whether it ends there to
	 * move to a new session (swap.ts). Pi waits on this, so it never throws.
	 */
	private turnEnded(name: string): boolean {
		if (this.swaps.ending(name)) return true;
		const record = this.records.get(name);
		const handle = this.sessions.get(name);
		if (!record || !handle) return false;
		try {
			const causes = staleCauses(handle.stamp, !this.sessions.stale(name), this.sessions.newCode(name));
			if (!swapDue({ enabled: this.options.swapAtTurn !== false, state: record.state, asking: this.questions.of(name).length > 0,
				blocked: this.list().some((entry) => entry.parent === name && entry.blocking && LIVE_STATES.has(entry.state)),
				ending: this.closed || this.ending.has(name), launchable: this.options.modelAllowed?.(record.model) ?? true,
				causes, handled: this.swaps.done(name) })) return false;
			this.swaps.request(name, causes);
			this.patch(name, { activity: swapActivity(causes), work: "model" });
			return true;
		} catch (error) {
			(this.options.warn ?? console.warn)(`subagents: could not tell whether ${name} should move to a new session: ${(error as Error).message}`);
			return false;
		}
	}

	/** Before the run's next prompt, a stale session moves too, and the new one gets that prompt. */
	private swapBefore(name: string, prompt: string): boolean {
		if (!this.turnEnded(name)) return false;
		this.swap(name, this.swaps.take(name)!, prompt, true);
		return true;
	}

	/**
	 * Moves the run to a new session from its session file, on current code and
	 * settings, the way a fallback model goes on: the same run with its budget,
	 * check rounds, mail and edit lock, and the slot it holds. `prompt` comes
	 * first; steering the old session had not read follows, unless the prompt
	 * already carries it.
	 */
	private swap(name: string, causes: readonly string[], prompt: string, carriesUnread: boolean): false {
		this.swaps.swapped(name, causes);
		this.options.log?.(`${name}: run ${this.records.get(name)!.runs} moved to a new session at a turn boundary (${causeWords(causes)})`);
		// Read before the state change in start() ends the clock.
		this.continuing.set(name, this.continuing.get(name) ?? this.budgets.used(name));
		// A prompt that carries mail or a fix round is a message, which a launch that can't go keeps.
		this.resumePrompts.set(name, carriesUnread ? { note: "", message: prompt } : { note: prompt });
		this.patch(name, { ...(carriesUnread ? {} : this.unreadLeft(name)), activity: swapActivity(causes) });
		void this.sessions.release(name);
		void this.start(name);
		return false;
	}

	/** Whether the team closed, `name` was stopped, or a later launch than `launch` took its place. */
	private gone(name: string, launch?: number): boolean {
		return this.closed || this.records.get(name)?.state === "stopped" || (launch !== undefined && this.launches.get(name) !== launch);
	}

	/** Steering that came too late for the prompt that just ended, and the inbox, as the run's next prompt. */
	private late(name: string, handle: ChildHandle): string | null {
		const late = [...handle.takeQueued(), ...this.takeInbox(name)];
		return late.length > 0 ? late.join("\n\n") : null;
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
			this.parkResume(name);
			return this.fail(name, plan.error);
		}
		const { step } = plan;
		this.swaps.take(name);
		// Read before the state change below ends the clock; a launch that failed has none left to read.
		this.continuing.set(name, this.continuing.get(name) ?? this.budgets.used(name));
		this.resumePrompts.set(name, { note: fallbackNote(step), message: this.resumePrompts.message(name) });
		this.patch(name, { ...this.unreadLeft(name), state: "queued", model: step.to, fallbacks: [...(record.fallbacks ?? []), step], activity: `switching to ${step.to}` });
		void this.sessions.release(name);
		this.slots.enqueue(name);
		this.pump();
	}

	/** Limits fixed at spawn; records saved before budgets existed get today's defaults. */
	private limits(record: AgentRecord): RunLimits {
		return { minutes: record.maxMinutes ?? this.options.runBudget?.minutes, cost: record.maxCost ?? this.options.runBudget?.cost };
	}

	/**
	 * What a run that ends now would still wait for: its live subagents, or
	 * answers it is owed by agents that still run; undefined when nothing. One
	 * that ended or is paused can't answer until something resumes it.
	 */
	private waitsFor(name: string): string | undefined {
		if (this.list().some((entry) => entry.parent === name && LIVE_STATES.has(entry.state))) return "waiting on its subagents";
		const owing = (this.records.get(name)?.owed ?? []).filter((other) => LIVE_STATES.has(this.records.get(other)?.state ?? "idle"));
		return owing.length > 0 ? `waiting for ${owing.join(", ")} to answer` : undefined;
	}

	/** A run that ended normally read everything steered into it, or took it as its last prompt. */
	private settle(name: string, report: string | undefined): void {
		const activity = this.waitsFor(name);
		if (activity) {
			// Its report waits for what it is still owed; that arrival resumes it.
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
		this.patch(name, { state: "failed", endedAt: this.now(), activity: null, error: message, answeredMain: undefined, report: this.sessions.runText(name), ...this.unreadLeft(name) });
		this.finish(name);
		// Its subagents stop as a stop's would, but each report goes on up (hand-up.ts), since this one can't read it.
		for (const child of this.list().filter((entry) => entry.parent === name)) void this.stop(child.name, { reason: `because its parent ${name} failed` });
	}

	/** This run's messages, which are where a steered message shows up once the child reads it. */
	/** Drops from `unread` what the child has now read. */
	private forgetRead(name: string): void {
		const unread = this.records.get(name)?.unread;
		if (!unread?.length) return;
		const left = stillUnread(unread, this.sessions.runMessages(name));
		if (left.length < unread.length) this.patch(name, { unread: left.length > 0 ? left : undefined });
	}

	/** For a run that ends early: its session's queue goes with it, so what it never read waits in its inbox. */
	private unreadLeft(name: string): Partial<AgentRecord> {
		const record = this.records.get(name);
		return record ? unreadToInbox(record, this.sessions.runMessages(name)) : {};
	}

	/** Anything delivered to a child (steering, a note, a subagent's report, a resume) is new work its report must tell main about. */
	private forgetAnswer(name: string): void {
		this.answers.forget(name);
		if (this.records.get(name)?.answeredMain) this.patch(name, { answeredMain: undefined });
	}

	/** Hands the report up and frees the slot. */
	private finish(name: string): void {
		this.ending.delete(name);
		this.continuing.delete(name);
		this.woken.delete(name);
		this.checks.end(name);
		this.swaps.end(name);
		// Answers still owed to it die with its run; a message resumes it to ask again.
		const record = saveReport({ ...this.records.get(name)!, owed: undefined }, this.options.warn ?? console.warn);
		this.sessions.endRun(name);
		this.put(record);
		this.answers.forget(name);
		for (const resolve of this.waiters.get(name) ?? []) resolve(record);
		this.waiters.delete(name);
		handUp(this.handUpHost, record, this.stoppedByParent.delete(name));
		this.sessions.ended(name, record.state);
		this.pump();
	}

	/** An asker's state follows its open questions. */
	private showAsking(name: string, waitingOn: readonly string[]): void {
		const current = this.records.get(name);
		if (!current) return;
		if (waitingOn.length > 0) {
			this.patch(name, { state: "asking", askingWho: waitingOn.join(", "), activity: `asking ${waitingOn.join(", ")}` });
		} else if (current.state === "asking" && !this.ending.has(name) && !this.closed) {
			// Its slot went to another while it asked; the answer reaches it once one is free (send()).
			this.answered.set(name, this.goOnWhenFree(name, () => this.patch(name, { state: "running", askingWho: undefined, ...WAITING_FOR_MODEL })));
		}
	}

	/** A launch that will not go keeps the message that asked for it in the child's inbox, for its next run (resume-prompts.ts). */
	private parkResume(name: string): void {
		const message = this.resumePrompts.park(name);
		const record = this.records.get(name);
		if (message !== undefined && record) this.patch(name, { inbox: [...(record.inbox ?? []), message] });
	}

	private takeInbox(name: string): string[] {
		const inbox = this.records.get(name)?.inbox ?? [];
		if (inbox.length > 0) this.patch(name, { inbox: undefined });
		return inbox;
	}

	private sessionCheckout(): string | undefined {
		this.mainCheckout ??= { value: this.options.cwd ? checkoutOf(this.options.cwd) : undefined };
		return this.mainCheckout.value;
	}

	private knownNames(): string {
		const names = this.list().map((record) => record.name);
		return names.length > 0 ? `Agents: ${[MAIN, ...names].join(", ")}.` : "There are no subagents.";
	}
}

