/**
 * Where a message goes (team.ts `send`):
 * - To `main`: handed to `deliverToMain`, which decides whether it wakes.
 * - To a running child: steered in after its current tool call.
 * - To a finished child: a question or anything from its parent or main resumes it;
 *   a sibling's note waits in its inbox for the next run.
 * - A reply to someone blocked on a question resolves that question instead.
 * The inbox, the answers a child is owed and what was steered into it unread
 * live on its record, so the index keeps them across a restart or crash.
 * A run that a peer's message started and that ends idle reports to its
 * parent without waking it (team.ts `finish`).
 */
import { askError, dependsOn, heldBetween } from "./after.ts";
import type { MainAnswers } from "./answers.ts";
import type { RunChecks } from "./checks.ts";
import { noteText, questionText, resumeWarning } from "./format.ts";
import { EVERYONE, MAIN, USER } from "./names.ts";
import type { OpenQuestions } from "./questions.ts";
import type { OpenSessions } from "./sessions.ts";
import type { SendResult } from "./team.ts";
import { type AgentRecord, type CheckUpdate, LIVE_STATES, type MainDelivery } from "./types.ts";
import { workspaceError } from "./worktree.ts";

export interface SendOptions {
	expectReply?: boolean;
	signal?: AbortSignal;
	automatic?: boolean;
	check?: CheckUpdate;
}

/** What routing needs from the team. */
export interface RouteHost {
	readonly questions: OpenQuestions;
	readonly answers: MainAnswers;
	readonly sessions: OpenSessions;
	readonly checks: RunChecks;
	closed(): boolean;
	get(name: string): AgentRecord | undefined;
	list(): AgentRecord[];
	patch(name: string, patch: Partial<AgentRecord>): void;
	under(name: string, ancestor: string): boolean;
	now(): number;
	/** Every agent's name, for an error about one that is not there. */
	known(): string;
	deliverToMain(delivery: MainDelivery): void;
	prepareResume?(record: AgentRecord): { model: string; note?: string; notice?: string };
	/** What the next launch of `name` is prompted with instead of its task: a note, then the message that resumes it. */
	resumeWith(name: string, note: string, message: string): void;
	/** The next launch of `name`, which waits on its subagents or an answer, goes on with the same run. */
	goOn(name: string): void;
	forgetAnswer(name: string): void;
	takeInbox(name: string): string[];
	/** Puts `name`, now queued, in line to start. */
	enqueue(name: string): void;
	/** Starts a run of `name` on the session it holds. */
	run(name: string, text: string): void;
}

/** Why a message to a paused or ended child resumes it. */
interface Resume {
	readonly from: string;
	readonly body: string;
	readonly said: string;
	readonly automatic: boolean;
	readonly peer: boolean;
	readonly stale: boolean;
}

const envelope = (from: string, text: string, expectReply: boolean) => ({
	body: expectReply ? questionText(from, text) : noteText(from, text),
	said: `${expectReply ? "Question" : "Message"} from ${from}: ${text}`,
});

export class Routing {
	/** Children that owe main an answer; their next message to main wakes it. */
	private readonly owesMain = new Set<string>();
	/** Runs a peer's message started; main, its parent or the user writing to it during the run makes it theirs. */
	private readonly peerRuns = new Set<string>();
	private readonly host: RouteHost;

	constructor(host: RouteHost) {
		this.host = host;
	}

	async send(from: string, to: string, text: string, options: SendOptions = {}): Promise<SendResult> {
		const { host } = this;
		if (host.closed()) return { ok: false, error: "The session is shutting down." };
		if (to === from) return { ok: false, error: "That is you." };
		const badCheck = options.check ? host.checks.refusal(from, to, options.check) : undefined;
		if (badCheck) return { ok: false, error: badCheck };
		// A message that is refused leaves the target's check as it was.
		const keepCheck = (result: SendResult): SendResult => {
			if (result.ok && options.check) host.checks.set(from, to, options.check);
			return result;
		};
		if (to === EVERYONE) return this.broadcast(from, text, options.expectReply === true);
		if (this.answers(from, to, text)) return keepCheck({ ok: true, delivered: "replied" });
		// Its parent is blocked on this agent's report: a note would only land after it, and a
		// question could never be answered, so the question ends the wait instead.
		const asker = host.get(from);
		if (asker?.blocking && to === asker.parent) {
			if (!options.expectReply) return { ok: false, error: `${to} is waiting for your report; put this in it instead.` };
			host.patch(from, { blocking: false });
		}
		// A child waits only on main and its parent: they never wait on it, so no loop of waiting
		// agents can form. Anyone else answers by message, which wakes it.
		const waits = options.expectReply === true && (to === MAIN || to === asker?.parent);
		if (options.expectReply && !waits && asker) return keepCheck(this.askPeer(from, to, text, options.automatic));
		if (from === MAIN && options.expectReply) return keepCheck(this.mainAsks(to, text, options.automatic));
		const result = keepCheck(to === MAIN ? this.toMain(from, text, options.expectReply === true) : this.toChild(from, to, text, options.expectReply === true, options.automatic));
		if (!result.ok || !options.expectReply) return result;
		return host.questions.ask(from, to, options.signal);
	}

	/** `name`'s run ended: whether it owed main an answer, and whether a peer's message started it. */
	ended(name: string): { owedMain: boolean; peerRun: boolean } {
		return { owedMain: this.owesMain.delete(name), peerRun: this.peerRuns.delete(name) };
	}

	/** Settles what `from` owed `asker`; true when it owed it an answer. */
	payOwed(asker: string, from: string): boolean {
		const owing = this.host.get(asker)?.owed;
		if (!owing?.includes(from)) return false;
		const rest = owing.filter((agent) => agent !== from);
		this.host.patch(asker, { owed: rest.length > 0 ? rest : undefined });
		return true;
	}

	/** The user can answer any question, whoever it was put to; true when this message did. */
	private answers(from: string, to: string, text: string): boolean {
		const open = this.host.questions.of(to);
		const pending = from === USER ? open[0] : open.find((question) => question.to === from);
		if (!pending) return false;
		pending.resolve(text);
		if (from === USER) this.host.deliverToMain({ kind: "relay", from, to, text, answered: true });
		return true;
	}

	/** A question to a peer or a subagent: delivered, and the asker's report waits for the answer. */
	private askPeer(from: string, to: string, text: string, automatic?: boolean): SendResult {
		const { host } = this;
		const early = askError(host.get(to), (name) => host.get(name)) ?? this.loopError(from, to);
		if (early) return { ok: false, error: early };
		const { body, said } = envelope(from, text, true);
		const result = this.deliver(from, to, body, true, said, automatic);
		if (result.ok) host.patch(from, { owed: [...new Set([...(host.get(from)?.owed ?? []), to])] });
		return result;
	}

	/**
	 * A question to an agent that can't end before the asker does: through its
	 * subagents, answers it is owed, or a spawn it waits for that starts after
	 * the asker ends. Should it end its run without answering, the asker's
	 * report would wait for that answer, and nothing would end (after.ts).
	 */
	private loopError(from: string, to: string): string | undefined {
		const records = this.host.list();
		const held = heldBetween(to, from, records);
		if (held !== undefined) return `${to} waits for you: ${held}, which it waits for, starts after you end. A question could leave each of you waiting for the other. Send a note instead (no expectReply).`;
		if (!dependsOn(to, from, records)) return undefined;
		return `${to} waits for you, directly or through other agents (its subagents or an answer it is owed). A question could leave each of you waiting for the other. Send a note instead (no expectReply).`;
	}

	/** Main never blocks: its question is delivered, and the answer wakes it later. */
	private mainAsks(to: string, text: string, automatic?: boolean): SendResult {
		const idle = this.host.get(to)?.state === "idle";
		const { body, said } = envelope(MAIN, text, true);
		const result = this.deliver(MAIN, to, body, true, said, automatic);
		if (result.ok) this.owesMain.add(to);
		if (result.ok && idle && result.delivered === "resumed") this.host.answers.resumedToAnswer(to);
		return result;
	}

	private toMain(from: string, text: string, expectReply: boolean): SendResult {
		const { host } = this;
		const answering = this.owesMain.delete(from);
		const answerer = host.get(from);
		if (answering && answerer && host.answers.answers(from, answerer.toolCalls, () => host.sessions.onlyMessageCall(from))) host.patch(from, { answeredMain: true });
		host.deliverToMain(expectReply ? { kind: "question", from, text } : answering ? { kind: "reply", from, text } : { kind: "note", from, text });
		return { ok: true, delivered: "main" };
	}

	/** A note, or a question up the tree whose answer the caller then waits for. */
	private toChild(from: string, to: string, text: string, expectReply: boolean, automatic?: boolean): SendResult {
		const { body, said } = envelope(from, text, expectReply);
		const answers = this.payOwed(to, from);
		const result = this.deliver(from, to, body, expectReply || answers, said, automatic);
		// Main should never be surprised by work the user asked for directly.
		if (result.ok && from === USER) this.host.deliverToMain({ kind: "relay", from, to, text, answered: false });
		return result;
	}

	/** `said` is how the report of a run this message starts names it. */
	deliver(from: string, to: string, body: string, wakes: boolean, said = body, automatic = false): SendResult {
		const { host } = this;
		const target = host.get(to);
		if (!target) return { ok: false, error: `No agent named ${to}. ${host.known()}` };
		// Main's next message to a paused child whose answer is held (team.ts `holdAnswer`) waits in its inbox.
		if (from === MAIN && target.answerHeld && target.state === "interrupted") {
			host.patch(to, { answerHeld: undefined, inbox: [...(target.inbox ?? []), body] });
			return { ok: true, delivered: "inbox", notice: `${to} is paused, and resumePolicy is "notify", so it reads this when it resumes. Message it again, or run /subagents resume ${to}, to resume it now.` };
		}
		// Main stands above every agent, so it resumes any of them as a parent does.
		const above = from === target.parent || from === MAIN || from === USER;
		const resumes = wakes || above;
		// An ended run's session is on disk, so its parent, main or the user can take it up again; a peer can't.
		const ended = target.state === "failed" || target.state === "stopped";
		if (ended && !above) return { ok: false, error: `${to} has ${target.state}; only ${target.parent === MAIN ? "" : `${target.parent}, `}main or the user can resume it.` };
		const place = target.cwd ?? target.worktree?.path;
		const missing = resumes && !LIVE_STATES.has(target.state) && place ? workspaceError(place) : undefined;
		if (missing) return { ok: false, error: missing };
		const peer = from !== MAIN && from !== USER && from !== target.parent && !host.under(from, to);
		if (from === MAIN || from === USER || from === target.parent) this.peerRuns.delete(to);
		host.forgetAnswer(to);
		const handle = host.sessions.get(to);
		if ((target.state === "running" || target.state === "asking") && handle) {
			handle.steer(body);
			host.patch(to, { unread: [...(host.get(to)?.unread ?? []), body] });
			return { ok: true, delivered: "steered" };
		}
		return this.wake(target, { from, body, said, automatic, peer, stale: false }, { resumes, ended });
	}

	/** A message to a child that does not run now: it resumes it, or waits in its inbox. */
	private wake(target: AgentRecord, why: Resume, how: { resumes: boolean; ended: boolean }): SendResult {
		const { host } = this;
		const { name: to } = target;
		const handle = host.sessions.get(to);
		const { resumes, ended } = how;
		// Released when it ended; should it still be held, let it go before a fresh launch takes its place.
		if (ended && handle) void host.sessions.release(to);
		// A paused child's session that a launch now would not make goes too, so its next run starts on today's code and settings.
		const stale = !ended && (target.state === "idle" || target.state === "waiting") && host.sessions.stale(to);
		if ((!handle || ended || stale) && resumes && (target.state === "idle" || target.state === "waiting" || target.state === "interrupted" || ended)) {
			const relaunched = this.relaunch(target, { ...why, stale });
			if (relaunched) return relaunched;
		}
		if ((target.state === "idle" || target.state === "waiting") && handle && resumes) {
			// A new run: time it on its own and forget what the last one answered.
			if (target.state === "idle") {
				this.startedBy(to, why.peer);
				host.patch(to, { resumedBy: { from: why.from, text: why.said }, startedAt: host.now(),
					...(!why.automatic && (why.from === MAIN || why.from === USER) ? { interruptionId: undefined, interruptedBy: undefined, interruptionAnnounced: undefined, autoResumeAttempts: 0 } : {}) });
			}
			host.run(to, [...host.takeInbox(to), why.body].join("\n\n"));
			return { ok: true, delivered: "resumed" };
		}
		host.patch(to, { inbox: [...(host.get(to)?.inbox ?? []), why.body] });
		return { ok: true, delivered: target.state === "queued" || target.state === "starting" ? "queued" : "inbox" };
	}

	/**
	 * Queues a run of `target` from its session file, which a message started.
	 * Undefined when a held session that is only stale should take the message
	 * instead: a resume that can't go would otherwise lose it.
	 */
	private relaunch(target: AgentRecord, why: Resume): SendResult | undefined {
		const { host } = this;
		const { name } = target;
		let prepared: { model: string; note?: string; notice?: string } = { model: target.model };
		try { if (!why.automatic) prepared = host.prepareResume?.(target) ?? prepared; }
		catch (error) { return why.stale ? undefined : { ok: false, error: (error as Error).message }; }
		if (why.stale) void host.sessions.release(name);
		// Mail that waited in its inbox came before this message; mail that comes while the relaunch waits follows it.
		host.resumeWith(name, `${resumeWarning(target)}${prepared.note ? `${prepared.note}\n\n` : ""}`, [...host.takeInbox(name), why.body].join("\n\n"));
		if (target.state !== "waiting") this.startedBy(name, why.peer);
		else host.goOn(name);
		host.patch(name, { state: "queued", model: prepared.model, resumedBy: { from: why.from, text: why.said }, startedAt: host.now(), error: undefined, stopReason: undefined, restoreError: undefined, launchError: undefined,
			...(!why.automatic ? { interruptionId: undefined, interruptedBy: undefined, interruptionAnnounced: undefined, autoResumeAttempts: 0 } : {}) });
		host.enqueue(name);
		return { ok: true, delivered: "resumed", ...(prepared.notice ? { notice: prepared.notice } : {}) };
	}

	/** A new run from idle or interrupted; a peer started it unless main, its parent, the user or its own subagent did. */
	private startedBy(name: string, peer: boolean): void {
		if (peer) this.peerRuns.add(name);
		else this.peerRuns.delete(name);
	}

	private broadcast(from: string, text: string, expectReply: boolean): SendResult {
		if (expectReply) return { ok: false, error: `Ask one agent at a time; "${EVERYONE}" cannot reply.` };
		const others = this.host.list().filter((record) => record.name !== from && LIVE_STATES.has(record.state));
		for (const record of others) this.deliver(from, record.name, noteText(from, text), false);
		if (from !== MAIN) this.host.deliverToMain({ kind: "note", from, text });
		return { ok: true, delivered: "steered" };
	}
}
