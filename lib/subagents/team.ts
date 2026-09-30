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
 * A child is not done until its own children have reported.
 */
import { EVERYONE, MAIN, nameFor, USER } from "./names.ts";
import { noteText, questionText, reportText } from "./format.ts";
import {
	ACTIVE_STATES, type AgentRecord, type ChildHandle, LIVE_STATES, type Launcher, type MainDelivery, NO_USAGE, type SpawnRequest,
} from "./types.ts";

export interface TeamOptions {
	launcher: Launcher;
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
}

export type SendResult =
	| { ok: true; delivered: "steered" | "resumed" | "queued" | "replied" | "main" | "inbox"; reply?: string }
	| { ok: false; error: string };

interface Pending {
	to: string;
	resolve(reply: string): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

type Listener = (record: AgentRecord | null) => void;

export class Team {
	private readonly records = new Map<string, AgentRecord>();
	private readonly handles = new Map<string, ChildHandle>();
	private readonly inboxes = new Map<string, string[]>();
	private readonly questions = new Map<string, Pending>();
	private readonly waiters = new Map<string, Array<(record: AgentRecord) => void>>();
	private readonly listeners = new Set<Listener>();
	private readonly queue: string[] = [];
	/** Children that owe main an answer; their next message to main wakes it. */
	private readonly owesMain = new Set<string>();
	private closed = false;
	private readonly now: () => number;
	private readonly options: TeamOptions;

	constructor(options: TeamOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
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

	/** Validates depth, names the child, and starts or queues it. */
	spawn(request: SpawnRequest): { ok: true; record: AgentRecord } | { ok: false; error: string } {
		if (this.closed) return { ok: false, error: "The session is shutting down." };
		const parent = request.parent === MAIN ? null : this.records.get(request.parent);
		if (request.parent !== MAIN && !parent) return { ok: false, error: `Unknown parent ${request.parent}.` };
		const depth = (parent?.depth ?? 0) + 1;
		if (depth > this.options.maxDepth) return { ok: false, error: `Subagents cannot start subagents here (depth limit ${this.options.maxDepth}).` };
		const name = nameFor(request.name, request.task, (candidate) => this.records.has(candidate));
		const sessionFile = this.options.sessionFileFor?.(name);
		const record: AgentRecord = {
			name, parent: request.parent, depth, task: request.task, model: request.model, readOnly: request.readOnly,
			fork: request.fork, blocking: request.blocking, state: "queued", createdAt: this.now(), activity: "queued",
			toolCalls: 0, usage: NO_USAGE, runs: 0, ...(request.thinking ? { thinking: request.thinking } : {}),
			...(sessionFile ? { sessionFile } : {}),
			...(request.group ? { group: request.group } : {}),
		};
		this.put(record);
		this.queue.push(name);
		this.pump();
		return { ok: true, record: this.records.get(name)! };
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

	async send(from: string, to: string, text: string, options: { expectReply?: boolean; signal?: AbortSignal } = {}): Promise<SendResult> {
		if (to === from) return { ok: false, error: "That is you." };
		if (to === EVERYONE) return this.broadcast(from, text, options.expectReply === true);
		const pending = this.questions.get(to);
		// The user can answer any question, whoever it was put to.
		if (pending && (pending.to === from || from === USER)) {
			pending.resolve(text);
			if (from === USER) this.options.deliverToMain({ kind: "relay", from, to, text, answered: true });
			return { ok: true, delivered: "replied" };
		}
		const body = options.expectReply ? questionText(from, text) : noteText(from, text);
		const said = `${options.expectReply ? "Question" : "Message"} from ${from}: ${text}`;
		// Main never blocks: its question is delivered, and the answer wakes it later.
		if (from === MAIN && options.expectReply) {
			const result = this.deliverToChild(from, to, body, true, said);
			if (result.ok) this.owesMain.add(to);
			return result;
		}
		let result: SendResult;
		if (to === MAIN) {
			const answering = this.owesMain.delete(from);
			if (answering && this.records.get(from)?.resumedBy?.from === MAIN) this.patch(from, { answeredMain: true });
			this.options.deliverToMain(options.expectReply ? { kind: "question", from, text } : answering ? { kind: "reply", from, text } : { kind: "note", from, text });
			result = { ok: true, delivered: "main" };
		} else {
			result = this.deliverToChild(from, to, body, options.expectReply === true, said);
			// Main should never be surprised by work the user asked for directly.
			if (result.ok && from === USER) this.options.deliverToMain({ kind: "relay", from, to, text, answered: false });
		}
		if (!result.ok || !options.expectReply) return result;
		return this.awaitReply(from, to, options.signal);
	}

	/** The child's messages so far; empty before it starts. */
	messages(name: string): readonly unknown[] {
		return this.handles.get(name)?.messages() ?? [];
	}

	/** Stops a child and everything under it. */
	async stop(name: string): Promise<void> {
		const record = this.records.get(name);
		if (!record || !LIVE_STATES.has(record.state)) return;
		for (const child of this.list().filter((entry) => entry.parent === name)) await this.stop(child.name);
		this.queue.splice(0, this.queue.length, ...this.queue.filter((queued) => queued !== name));
		this.questions.get(name)?.reject(new Error("stopped"));
		const handle = this.handles.get(name);
		this.patch(name, { state: "stopped", endedAt: this.now(), activity: null, report: handle?.lastText() });
		await handle?.abort().catch(() => undefined);
		this.finish(name);
	}

	/** Stops every child and releases their sessions. */
	async close(): Promise<void> {
		this.closed = true;
		for (const record of this.list().filter((entry) => entry.parent === MAIN)) await this.stop(record.name);
		await Promise.allSettled([...this.handles.values()].map((handle) => handle.dispose()));
		this.handles.clear();
	}

	private put(record: AgentRecord): void {
		this.records.set(record.name, record);
		for (const listener of this.listeners) listener(record);
	}

	private patch(name: string, patch: Partial<AgentRecord>): void {
		const current = this.records.get(name);
		if (current) this.put({ ...current, ...patch });
	}

	private pump(): void {
		let active = this.list().filter((record) => ACTIVE_STATES.has(record.state)).length;
		while (active < this.options.maxConcurrent && this.queue.length > 0) {
			const name = this.queue.shift()!;
			if (this.records.get(name)?.state !== "queued") continue;
			active++;
			void this.start(name);
		}
	}

	private async start(name: string): Promise<void> {
		this.patch(name, { state: "starting", startedAt: this.now(), activity: "starting" });
		let handle: ChildHandle;
		try {
			handle = await this.options.launcher.launch(this.records.get(name)!, {
				update: (patch) => {
					const record = this.records.get(name);
					if (record && LIVE_STATES.has(record.state)) this.patch(name, patch);
				},
			});
		} catch (error) {
			this.fail(name, error);
			return;
		}
		if (this.records.get(name)?.state === "stopped") {
			await handle.dispose().catch(() => undefined);
			return;
		}
		this.handles.set(name, handle);
		this.patch(name, handle.sessionFile ? { sessionFile: handle.sessionFile } : {});
		const inbox = this.takeInbox(name);
		await this.run(name, [this.records.get(name)!.task, ...inbox].join("\n\n"));
	}

	private async run(name: string, text: string): Promise<void> {
		const handle = this.handles.get(name);
		if (!handle) return;
		const record = this.records.get(name)!;
		this.patch(name, { state: "running", activity: "thinking", runs: record.runs + 1, endedAt: undefined });
		try {
			let next: string | null = text;
			while (next !== null) {
				await handle.prompt(next);
				if (this.records.get(name)?.state === "stopped") return;
				const late = [...handle.takeQueued(), ...this.takeInbox(name)];
				next = late.length > 0 ? late.join("\n\n") : null;
			}
		} catch (error) {
			if (this.records.get(name)?.state !== "stopped") this.fail(name, error);
			return;
		}
		this.settle(name, handle.lastText());
	}

	private settle(name: string, report: string | undefined): void {
		const hasLiveChildren = this.list().some((entry) => entry.parent === name && LIVE_STATES.has(entry.state));
		if (hasLiveChildren) {
			this.patch(name, { state: "waiting", activity: "waiting on its subagents", report });
			this.pump();
			return;
		}
		this.patch(name, { state: "idle", endedAt: this.now(), activity: null, report });
		this.finish(name);
	}

	private fail(name: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.patch(name, { state: "failed", endedAt: this.now(), activity: null, error: message });
		this.finish(name);
	}

	/** Hands the report up and frees the slot. */
	private finish(name: string): void {
		const record = this.records.get(name)!;
		for (const resolve of this.waiters.get(name) ?? []) resolve(record);
		this.waiters.delete(name);
		// The report answers anything main was waiting on.
		this.owesMain.delete(name);
		if (record.parent === MAIN) {
			if (!record.blocking) this.options.deliverToMain({ kind: "report", record });
		} else if (!record.blocking) {
			this.deliverToChild(record.name, record.parent, reportText(record, this.now()), true, `Report from ${record.name}`);
		}
		this.pump();
	}

	/** `said` is how the report of a run this message starts names it. */
	private deliverToChild(from: string, to: string, body: string, wakes: boolean, said = body): SendResult {
		const target = this.records.get(to);
		if (!target) return { ok: false, error: `No agent named ${to}. ${this.knownNames()}` };
		if (target.state === "failed" || target.state === "stopped") return { ok: false, error: `${to} has ${target.state}.` };
		const handle = this.handles.get(to);
		if ((target.state === "running" || target.state === "asking") && handle) {
			handle.steer(body);
			return { ok: true, delivered: "steered" };
		}
		const resumes = wakes || from === target.parent || from === USER;
		if ((target.state === "idle" || target.state === "waiting") && handle && resumes) {
			// A new run: time it on its own and forget what the last one answered.
			if (target.state === "idle") this.patch(to, { resumedBy: { from, text: said }, startedAt: this.now(), answeredMain: undefined });
			void this.run(to, [...this.takeInbox(to), body].join("\n\n"));
			return { ok: true, delivered: "resumed" };
		}
		this.inboxes.set(to, [...(this.inboxes.get(to) ?? []), body]);
		return { ok: true, delivered: target.state === "queued" || target.state === "starting" ? "queued" : "inbox" };
	}

	private async broadcast(from: string, text: string, expectReply: boolean): Promise<SendResult> {
		if (expectReply) return { ok: false, error: `Ask one agent at a time; "${EVERYONE}" cannot reply.` };
		const others = this.list().filter((record) => record.name !== from && LIVE_STATES.has(record.state));
		for (const record of others) this.deliverToChild(from, record.name, noteText(from, text), false);
		if (from !== MAIN) this.options.deliverToMain({ kind: "note", from, text });
		return { ok: true, delivered: "steered" };
	}

	private awaitReply(from: string, to: string, signal?: AbortSignal): Promise<SendResult> {
		const asker = this.records.get(from);
		if (asker) this.patch(from, { state: "asking", askingWho: to, activity: `asking ${to}` });
		this.pump();
		return new Promise<SendResult>((resolve) => {
			const done = (result: SendResult) => {
				clearTimeout(pending.timer);
				signal?.removeEventListener("abort", onAbort);
				this.questions.delete(from);
				const current = this.records.get(from);
				if (current?.state === "asking") this.patch(from, { state: "running", askingWho: undefined, activity: "thinking" });
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
			this.questions.set(from, pending);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private takeInbox(name: string): string[] {
		const inbox = this.inboxes.get(name) ?? [];
		this.inboxes.delete(name);
		return inbox;
	}

	private knownNames(): string {
		const names = this.list().map((record) => record.name);
		return names.length > 0 ? `Agents: ${[MAIN, ...names].join(", ")}.` : "There are no subagents.";
	}
}

