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
import { HOST_VERSION, type HostActivity, type HostPorts, type HostState } from "./contract.ts";
import type { SubagentsConfig } from "./config.ts";
import { MainMail } from "./deliver.ts";
import { fallbackChain } from "./fallback.ts";
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

/** Opens a session's subagents from its index, as a session start does; throws when the index can't be read. */
export function openHost(inputs: HostInputs): HostState {
	const { agentDir, sessionId, owner, config } = inputs;
	const binding = new PortBinding(inputs.ports);
	const ports = binding.ports;
	const notify = (message: string) => ports.notify(message, "warning");
	const logFile = runLogPath(agentDir);
	const sessionDir = join(agentDir, "sessions", "subagents", sessionId);
	const index = new ChildIndex(sessionDir, sessionId, inputs.cwd);
	const releaseLease = inputs.lease ?? acquireParent(sessionDir);
	const place: Place = { index, cwd: inputs.cwd, moved: () => index.cwd !== inputs.cwd };
	// The team is made below; the mail only asks it once reports arrive.
	let team!: Team;
	const mail = new MainMail({
		batchMs: config.batchMs,
		groupWaitMs: config.groupWaitMs,
		groupBusy: (group, except) => team.list().some((r) => r.group === group && r.name !== except && LIVE_STATES.has(r.state)),
		port: { send: (message, options) => ports.send(message, options) },
		route: () => ports.route(),
		onChange: () => ports.mailChanged(),
	});
	team = teamFor(inputs, ports, () => mail, place, sessionDir);
	let previousShutdown: string | undefined;
	let previousOwner: string | undefined;
	try {
		restoreRoster(inputs, ports, team, index, sessionDir);
		previousShutdown = index.shutdown;
		previousOwner = index.shutdownOwner;
	} catch (error) {
		mail.dispose();
		if (!inputs.lease) releaseLease();
		throw new Error(`Could not restore ${index.file}: ${(error as Error).message}. The index has been left unchanged.`);
	}
	try {
		appendInterruptedRuns(logFile, team.list(), sessionId, Date.now());
		if (team.list().length > 0) index.save(team.list());
	} catch (error) { notify(`subagents: could not record restored children: ${(error as Error).message}`); }
	const unsubscribe = recordChanges(inputs, ports, team, index, logFile);
	let signalReason: string | undefined;
	const removeSignals = installSignalRecorder((signal) => {
		try {
			signalReason = signal;
			team.interrupt("signal", owner);
			index.save(team.list(), signal, owner);
			appendInterruptedRuns(logFile, team.list(), sessionId, Date.now());
		} catch (error) { notify(`subagents: could not record ${signal}: ${(error as Error).message}`); }
	});
	const activity = inputs.activity ?? new ToolActivity();
	let closed = false;
	let leaseHandedOver = false;
	return {
		version: HOST_VERSION,
		generation: inputs.generation,
		team, mail, activity, ports,
		rebind(next) {
			if (closed || signalReason) throw new Error("This session's subagents are closed.");
			binding.bind(next);
			mail.retry();
			next.teamChanged();
			next.mailChanged();
		},
		park: () => binding.park(),
		quiet: () => !closed && !signalReason && team.quiet() && mail.idle(),
		handOver() {
			index.save(team.list());
			return releaseLease;
		},
		async retire() {
			closed = true;
			leaseHandedOver = true;
			removeSignals();
			unsubscribe();
			binding.close();
			mail.dispose();
			// Quiet, so closing interrupts no one: it only lets the idle sessions go.
			await team.close("reload", owner);
		},
		restore: (reason) => restoreInterrupted({ team, index, config, owner, ports, place, previousShutdown, previousOwner }, reason),
		async close(reason = "quit") {
			if (closed) return;
			closed = true;
			removeSignals();
			binding.close();
			mail.dispose();
			const closing = team.close(signalReason ? "signal" : reason === "reload" ? "reload" : "quit", owner);
			// Saved before anything is awaited, so an exit during the close still finds its children interrupted.
			try { index.save(team.list(), signalReason ?? reason, owner); }
			catch (error) { notify(`subagents: could not save ${index.file}: ${(error as Error).message}`); }
			try { await closing; }
			finally {
				unsubscribe();
				if (!leaseHandedOver) releaseLease();
			}
		},
	};
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
