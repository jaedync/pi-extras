/**
 * A session's subagents behind ports (contract.ts `HostState`): the team,
 * main's mail, the durable index, the run log, the signal recorder and the
 * lease on the session's children. Nothing here holds Pi's `pi` or `ctx`; the
 * module serving the session binds ports for them (host.ts), so the host can
 * outlive the module that opened it.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { busyInGroup } from "./after.ts";
import { stillWorking } from "./status.ts";
import { HOST_VERSION, type HeldMail, type HostActivity, type HostPorts, type HostState } from "./contract.ts";
import type { SubagentsConfig } from "./config.ts";
import { MainMail } from "./deliver.ts";
import { fallbackChain } from "./fallback.ts";
import { keptQuestionText } from "./format.ts";
import { PortBinding } from "./host.ts";
import { MAIN } from "./names.ts";
import { acquireParent } from "./ownership.ts";
import { recoveryDecision } from "./recovery.ts";
import { ChildIndex, legacyRecords, recoverRoster } from "./restore.ts";
import { appendInterruptedRuns, appendRunLog, loggedRunKeys, runKey, runLogEntry, runLogPath } from "./runlog.ts";
import type { createSessionScanner } from "./session-scan.ts";
import { installSignalRecorder } from "./signals.ts";
import { Team } from "./team.ts";
import { ToolActivity } from "./tool-activity.ts";
import { LIVE_STATES } from "./types.ts";

export interface HostInputs {
	readonly generation: number;
	readonly agentDir: string;
	readonly cwd: string;
	readonly sessionId: string;
	/** Who owns interruptions in this process (recovery.ts). */
	readonly owner: string;
	readonly config: SubagentsConfig;
	/** Main's branch, where versions before the index recorded their children. */
	readonly branch: () => readonly unknown[];
	readonly scanner: ReturnType<typeof createSessionScanner>;
	readonly ports: HostPorts;
	/** From the host this one replaces: main's running calls, and the lease it holds on the children. */
	readonly activity?: HostActivity;
	readonly lease?: () => void;
}

/** What a resume needs to know about where the session is now. */
interface Place {
	readonly index: ChildIndex;
	readonly cwd: string;
	readonly moved: () => boolean;
}

function teamFor(inputs: HostInputs, ports: HostPorts, mail: () => MainMail, place: Place, sessionDir: string): Team {
	const { config, scanner } = inputs;
	const warn = (message: string) => ports.notify(message, "warning");
	const scope = ports.models();
	return new Team({
		warn, cwd: inputs.cwd,
		maxConcurrent: config.maxConcurrent,
		maxDepth: config.maxDepth,
		replyTimeoutMs: config.replyTimeoutMs,
		runBudget: { minutes: config.maxRunMinutes, ...(config.maxRunCost !== null ? { cost: config.maxRunCost } : {}) },
		fallbackModels: fallbackChain(config.fallbackModels, scope.fallbackModel, scope.allowed, warn),
		messagesFor: (record) => record.sessionFile && existsSync(record.sessionFile) && !record.restoreError ? scanner.messages(record.sessionFile) : [],
		prepareResume: (record) => {
			// The scope of the session start serving now, which a /reload may have changed.
			const { allowed, fallbackModel } = ports.models();
			const model = allowed.some((choice) => choice.ref === record.model) ? record.model : fallbackModel;
			if (!model) throw new Error("No current default model is available for this child. Scope a model before resuming.");
			const notes = [model !== record.model ? `Your previous model ${record.model} is out of scope. You are continuing on the current default ${model}.` : "",
				// A child with a cwd of its own keeps it when main's directory moves.
				place.moved() && !record.cwd ? `Your workspace moved from ${place.index.cwd} to ${place.cwd}. Verify files in the parent's current workspace before continuing.` : ""].filter(Boolean);
			const notice = model !== record.model ? `Model ${record.model} is not available now, running on ${model}.` : undefined;
			if (notice) warn(notice);
			return { model, note: notes.join("\n"), ...(notice ? { notice } : {}) };
		},
		sessionFileFor: (name) => join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}_${randomUUID().slice(0, 8)}.jsonl`),
		deliverToMain: (delivery) => mail().deliver(delivery),
		launcher: ports.launcher,
	});
}

/** Puts the saved roster back in the team; throws, leaving the index as it was, when it can't be read. */
function restoreRoster(inputs: HostInputs, ports: HostPorts, team: Team, index: ChildIndex, sessionDir: string): void {
	const warn = (message: string) => ports.notify(message, "warning");
	const badFiles = new Set<string>();
	const readBranch = (file: string) => {
		try { return inputs.scanner.branch(file); }
		catch (error) {
			if (!badFiles.has(file)) warn(`subagents: skipping ${file}: ${(error as Error).message}`);
			badFiles.add(file);
			throw error;
		}
	};
	const records = index.load(warn);
	const roster = records.length > 0 || existsSync(index.file) ? records : legacyRecords(inputs.branch(), sessionDir, MAIN, 1, readBranch, warn);
	team.restore(recoverRoster(roster, sessionDir, readBranch, warn));
	if (index.cwd !== inputs.cwd && index.markWorkspaceNotice(inputs.cwd)) warn(`subagents: workspace changed from ${index.cwd} to ${inputs.cwd}. Auto-resume is paused; inspect and resume children explicitly.`);
}

/** Saves the index on every change and adds each finished run to the run log once. */
function recordChanges(inputs: HostInputs, ports: HostPorts, team: Team, index: ChildIndex, logFile: string): () => void {
	const notify = (message: string) => ports.notify(message, "warning");
	let logged = new Set<string>();
	let logFailed = false;
	try { logged = loggedRunKeys(logFile); }
	catch (error) { notify(`subagents: could not read run log ${logFile}: ${(error as Error).message}`); }
	return team.onChange((record) => {
		ports.teamChanged();
		const saveWarning = (error: unknown) => notify(`subagents: could not save ${index.file}: ${(error as Error).message}`);
		try { index.update(team.list(), saveWarning); }
		catch (error) { saveWarning(error); }
		if (!record || LIVE_STATES.has(record.state)) return;
		const entry = runLogEntry(record, Date.now(), inputs.sessionId);
		const key = runKey(entry);
		if (logged.has(key)) return;
		try {
			appendRunLog(logFile, entry);
			logged.add(key);
		} catch (error) {
			if (!logFailed) notify(`subagents: could not write the run log ${logFile}: ${(error as Error).message}`);
			logFailed = true;
		}
	});
}

/** A signal can end the process before any await, so the interruption is recorded at once. */
function recordSignals(inputs: HostInputs, team: Team, index: ChildIndex, logFile: string, notify: (message: string) => void, signaled: (signal: string) => void): () => void {
	const { owner, sessionId } = inputs;
	return installSignalRecorder((signal) => {
		try {
			signaled(signal);
			team.interrupt("signal", owner);
			index.save(team.list(), signal, owner);
			appendInterruptedRuns(logFile, team.list(), sessionId, Date.now());
		} catch (error) { notify(`subagents: could not record ${signal}: ${(error as Error).message}`); }
	});
}

/** Opens a session's subagents from its index, as a session start does; throws when the index can't be read. */
export function openHost(inputs: HostInputs): HostState {
	return new Host(inputs);
}

/** Main's mail; it asks the team about groups only once reports arrive, so the team may be made after it. */
function mailFor(config: SubagentsConfig, ports: HostPorts, team: () => Team): MainMail {
	return new MainMail({
		batchMs: config.batchMs,
		groupWaitMs: config.groupWaitMs,
		groupBusy: (group, except) => busyInGroup(team().list(), group, except),
		port: { send: (message, options) => ports.send(message, options) },
		route: () => ports.route(),
		onChange: () => ports.mailChanged(),
		status: (except) => stillWorking(team().list(), except, Date.now()),
	});
}

class Host implements HostState {
	readonly version = HOST_VERSION;
	readonly generation: number;
	readonly team: Team;
	readonly mail: MainMail;
	readonly activity: HostActivity;
	readonly ports: HostPorts;
	private readonly inputs: HostInputs;
	private readonly binding: PortBinding;
	private readonly index: ChildIndex;
	private readonly place: Place;
	private readonly releaseLease: () => void;
	/** How the session's last shutdown left the index, read before this host saves it. */
	private readonly previous: { readonly shutdown: string | undefined; readonly owner: string | undefined };
	private readonly unsubscribe: () => void;
	private readonly removeSignals: () => void;
	private signalReason: string | undefined;
	private closed = false;
	private leaseHandedOver = false;

	constructor(inputs: HostInputs) {
		const { agentDir, sessionId } = inputs;
		this.inputs = inputs;
		this.generation = inputs.generation;
		this.binding = new PortBinding(inputs.ports);
		this.ports = this.binding.ports;
		const sessionDir = join(agentDir, "sessions", "subagents", sessionId);
		const index = new ChildIndex(sessionDir, sessionId, inputs.cwd);
		this.index = index;
		this.releaseLease = inputs.lease ?? acquireParent(sessionDir);
		this.place = { index, cwd: inputs.cwd, moved: () => index.cwd !== inputs.cwd };
		this.mail = mailFor(inputs.config, this.ports, () => this.team);
		this.team = teamFor(inputs, this.ports, () => this.mail, this.place, sessionDir);
		this.previous = this.load(sessionDir);
		const logFile = runLogPath(agentDir);
		this.unsubscribe = recordChanges(inputs, this.ports, this.team, index, logFile);
		this.removeSignals = recordSignals(inputs, this.team, index, logFile, (message) => this.notify(message), (signal) => { this.signalReason = signal; });
		this.activity = inputs.activity ?? new ToolActivity();
	}

	rebind(next: HostPorts): void {
		if (this.closed || this.signalReason) throw new Error("This session's subagents are closed.");
		this.binding.bind(next);
		this.mail.retry();
		next.teamChanged();
		next.mailChanged();
	}

	park(log?: (message: string) => void): void {
		this.binding.park(log);
	}

	quiet(): boolean {
		return !this.closed && !this.signalReason && this.team.quiet() && this.mail.idle();
	}

	handOver(): () => void {
		this.index.save(this.team.list());
		return this.releaseLease;
	}

	async retire(): Promise<void> {
		this.closed = true;
		this.leaseHandedOver = true;
		this.removeSignals();
		this.unsubscribe();
		this.binding.close();
		this.mail.dispose();
		// Quiet, so closing interrupts no one: it only lets the idle sessions go.
		await this.team.close("reload", this.inputs.owner);
	}

	async restore(reason: string): Promise<void> {
		const { team, index, place, ports, inputs: { config, owner } } = this;
		await restoreInterrupted({ team, index, config, owner, ports, place, previousShutdown: this.previous.shutdown, previousOwner: this.previous.owner }, reason);
		// After the restore, which says which children it resumed: a kept question depends on what became of its asker.
		postKeptMail(index, team, this.mail, config.resumePolicy, (message) => this.notify(message));
	}

	async close(reason = "quit"): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.removeSignals();
		// Mail and launches stop here; until the close ends, notices reach the module bound now, else the park log.
		const live = this.binding.beginClose();
		this.index.keepMail(handOverMail(this.mail.drain(), live));
		// The team marks its live children interrupted at once, and the run log records them as it does.
		const closing = this.team.close(this.signalReason ? "signal" : reason === "reload" ? "reload" : "quit", this.inputs.owner);
		this.unsubscribe();
		// Saved before anything is awaited, so an exit during the close still finds its children interrupted and its mail kept.
		// A failure is told, as a close told it before handovers: the next start opens the index as it is.
		try { this.index.save(this.team.list(), this.signalReason ?? reason, this.inputs.owner); }
		catch (error) { this.notify(`subagents: could not save ${this.index.file}: ${(error as Error).message}`); }
		try { await closing; }
		finally {
			if (!this.leaseHandedOver) this.releaseLease();
			this.binding.close();
		}
	}

	/** Puts the saved roster back; when it can't, lets go of what this host took and leaves the index as it was. */
	private load(sessionDir: string): Host["previous"] {
		const { inputs, team, index } = this;
		try { restoreRoster(inputs, this.ports, team, index, sessionDir); }
		catch (error) {
			this.mail.dispose();
			if (!inputs.lease) this.releaseLease();
			throw new Error(`Could not restore ${index.file}: ${(error as Error).message}. The index has been left unchanged.`);
		}
		const previous = { shutdown: index.shutdown, owner: index.shutdownOwner };
		try {
			appendInterruptedRuns(runLogPath(inputs.agentDir), team.list(), inputs.sessionId, Date.now());
			if (team.list().length > 0) index.save(team.list());
		} catch (error) { this.notify(`subagents: could not record restored children: ${(error as Error).message}`); }
		return previous;
	}

	private notify(message: string): void {
		this.ports.notify(message, "warning");
	}
}

/**
 * Mail a closing host still holds goes to main now when a module serves the
 * session, as a quiet note in its transcript: the session is ending, so it
 * starts no turn. What can't go is kept in the index for the next start.
 */
function handOverMail(items: readonly HeldMail[], live: HostPorts | undefined): HeldMail[] {
	if (!live) return [...items];
	return items.filter(({ message }) => {
		try { live.send(message, { triggerTurn: false }); return false; }
		catch { return true; }
	});
}

/** Posts the mail an earlier host kept for main, once: the index forgets it before it goes. */
function postKeptMail(index: ChildIndex, team: Team, mail: MainMail, policy: SubagentsConfig["resumePolicy"], notify: (message: string) => void): void {
	const kept = index.takeMail().map((item) => keptForNow(item, team, policy));
	if (kept.length === 0) return;
	try { index.save(team.list()); }
	catch (error) { notify(`subagents: could not save ${index.file}; mail it kept for main may come twice: ${(error as Error).message}`); }
	mail.resend(kept);
}

/**
 * A question kept from before an interruption says what became of its asker,
 * and wakes main only when the asker runs again. Under "notify" the user
 * resumes paused children, so an answer to a paused one waits in its inbox.
 */
function keptForNow(item: HeldMail, team: Team, policy: SubagentsConfig["resumePolicy"]): HeldMail {
	const { details } = item.message;
	const asker = details.kind === "question" ? team.get(details.from) : undefined;
	if (!asker || details.kind !== "question") return item;
	const live = LIVE_STATES.has(asker.state);
	const now = live ? "resumed" : policy === "notify" && asker.state === "interrupted" ? "held" : "paused";
	if (now === "held") team.holdAnswer(asker.name);
	return { message: { ...item.message, content: keptQuestionText(asker.name, details.text, now) }, wakes: live && item.wakes };
}

interface RestoreContext {
	readonly team: Team;
	readonly index: ChildIndex;
	readonly config: SubagentsConfig;
	readonly owner: string;
	readonly ports: HostPorts;
	readonly place: Place;
	readonly previousShutdown: string | undefined;
	readonly previousOwner: string | undefined;
}

/** Announces children an earlier shutdown interrupted, once, and resumes those the policy allows. */
async function restoreInterrupted(context: RestoreContext, reason: string): Promise<void> {
	const { team, config, ports } = context;
	const interrupted = team.list().filter((record) => record.state === "interrupted" && !record.interruptionAnnounced);
	if (interrupted.length === 0) return;
	const allowed = new Set(ports.models().allowed.map((choice) => choice.ref));
	const lines: string[] = [];
	const resumed: string[] = [];
	for (const record of interrupted) {
		const decision = recoveryDecision(record, { reason, policy: config.resumePolicy, shutdown: context.previousShutdown, shutdownOwner: context.previousOwner,
			owner: context.owner, allowed, moved: context.place.moved() });
		if (decision.resume) team.markRecovery(record.name, { autoResumeAttempts: (record.autoResumeAttempts ?? 0) + 1, interruptedBy: undefined });
		let action = decision.why;
		if (decision.resume) {
			const sent = await team.send(MAIN, record.name, "Continue your interrupted task and report the outcome.", { automatic: true });
			if (sent.ok && sent.delivered === "resumed") resumed.push(record.name);
			else action = `Paused: ${sent.ok ? sent.delivered : sent.error}`;
		}
		lines.push(`${record.name}: task ${short(record.task)}; last activity ${short(record.activity ?? record.state)}. ${action}`);
	}
	const notice = `Subagents restored after ${reason}. ${resumed.length ? "Auto-resuming eligible children." : "Not resumed."}\n${lines.join("\n")}\nPaused children require message from their parent or /subagents resume <name>.`;
	ports.send({ customType: "subagent-restore", content: notice, display: true, details: { reason, resumed, names: interrupted.map((record) => record.name) } }, { triggerTurn: false });
	for (const record of interrupted) team.markRecovery(record.name, { interruptionAnnounced: true });
	context.index.save(team.list());
	ports.notify(notice, "warning");
}

const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);
