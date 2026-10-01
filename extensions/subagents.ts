/**
 * subagents: background child agents on the model of your choice, which talk
 * to main and to each other, with a live band per agent above the editor.
 *
 * Children are Pi sessions in this process. Which models they may use comes
 * from the session's scoped models; which model suits what comes from the
 * user's guide file. Both are read at session start and on /reload only, so
 * the tool description never changes mid-session. Child transcripts and their
 * roster survive reloads and restarts, with interrupted work verified on resume.
 */
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelRuntime, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLauncher, childExtensionPaths, childToolNames, describeTool } from "../lib/subagents/child.ts";
import { GUIDE_FILE, loadConfig, readGuide, type SubagentsConfig } from "../lib/subagents/config.ts";
import { MainMail, MESSAGE_TYPE, REPORT_TYPE } from "../lib/subagents/deliver.ts";
import { childInstructions, conversationDigest, rosterText } from "../lib/subagents/format.ts";
import { allowedModels, modelTable, refOf, resolveModel, type ThinkingSettings } from "../lib/subagents/models.ts";
import { commandCompletions, MAIN, USER } from "../lib/subagents/names.ts";
import { type InspectorHost, openAgentInspector } from "../lib/subagents/inspector.ts";
import { watchRun } from "../lib/run-watch.ts";
import { announceBackground, BACKGROUND_REQUEST_EVENT } from "../lib/tab-status/events.ts";
import { createMessageRenderer, createReportRenderer, messageCallRow, messageResultRow, rememberAgent, subagentCallRow, subagentResultRow } from "../lib/subagents/render.ts";
import { offerRows } from "../lib/late-rows.ts";
import { markRow } from "../lib/tool-row.ts";
import { appendRunLog, appendInterruptedRuns, loggedRunKeys, runKey, runLogEntry, runLogPath, statsByModel, statsText } from "../lib/subagents/runlog.ts";
import { formatTime } from "../lib/band/band.ts";
import type { ShownOverlay } from "../lib/band/modal.ts";
import { formatMoney } from "../lib/status-plus-logic.ts";
import { acquireParent } from "../lib/subagents/ownership.ts";
import { installSignalRecorder } from "../lib/subagents/signals.ts";
import { Team } from "../lib/subagents/team.ts";
import { latestReportFile } from "../lib/subagents/reports.ts";
import { recoveryOwner, recoveryDecision } from "../lib/subagents/recovery.ts";
import { createSessionScanner } from "../lib/subagents/session-scan.ts";
import { ChildIndex, legacyRecords, recoverRoster } from "../lib/subagents/restore.ts";
import { childMessageTool, mainMessageTool, subagentTool, type ToolContext } from "../lib/subagents/tools.ts";
import { LIVE_STATES, type AgentRecord } from "../lib/subagents/types.ts";
import { createAgentsWidget, listLabel } from "../lib/subagents/widget.ts";

const markdown = () => sdk.getMarkdownTheme();

const RECONCILE_MS = 1_000;

const GUIDE_TEMPLATE = `# Subagent model guide

What is true today about which model to use for what. Read at session start
and on /reload. Edit freely.

- (model): (when to use it)
`;

interface SessionState {
	team: Team;
	mail: MainMail;
	tools: ToolContext;
	config: SubagentsConfig;
	restore(reason: string): Promise<void>;
	close(reason?: string): Promise<void>;
}

function thinkingSettings(cwd: string, agentDir: string): ThinkingSettings {
	try {
		const settings = sdk.SettingsManager.create(cwd, agentDir) as unknown as {
			getAllModelThinkingLevels?: () => ThinkingSettings["modelThinkingLevels"];
			getDefaultThinkingLevel?: () => string | undefined;
		};
		return {
			modelThinkingLevels: settings.getAllModelThinkingLevels?.() ?? {},
			...(settings.getDefaultThinkingLevel?.() ? { defaultThinkingLevel: settings.getDefaultThinkingLevel!()! } : {}),
		};
	} catch {
		return {};
	}
}

/** The parent's model runtime when Pi exposes it, so children share auth and providers. */
function runtimeSource(ctx: ExtensionContext): () => Promise<ModelRuntime> {
	let own: Promise<ModelRuntime> | null = null;
	const parent = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
	return () => {
		if (parent && typeof (parent as { refresh?: unknown }).refresh === "function") return Promise.resolve(parent);
		own ??= sdk.ModelRuntime.create();
		return own;
	};
}

export default function subagents(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENTS === "off") return;
	let state: SessionState | null = null;
	let backgroundCtx: ExtensionContext | undefined;
	// Resumed children keep `restored` provenance; only their current live state means work.
	const publishBackground = () => { if (state && backgroundCtx) announceBackground(pi, backgroundCtx, "subagents", state.team.list().filter((r) => LIVE_STATES.has(r.state)).length); };
	pi.events?.on(BACKGROUND_REQUEST_EVENT, publishBackground);
	const widget = createAgentsWidget();
	let mainRun = 0;
	pi.on("agent_start", async () => { mainRun++; });
	let inspectorUi: InspectorHost | null = null;
	let inspected: ShownOverlay | undefined;

	/** One at a time, as the other sheets are; one Pi took off screen without closing it no longer counts. */
	const inspect = (name: string): void => {
		const current = state;
		if (!inspectorUi || !current || inspected?.isOpen()) return;
		const shown = openAgentInspector(inspectorUi, {
			record: () => current.team.get(name),
			messages: () => current.team.messages(name),
			describe: describeTool,
			stop: () => current.team.stop(name),
			async send(text) {
				const result = await current.team.send(USER, name, text);
				if (!result.ok) throw new Error(result.error);
				return result.delivered === "replied" ? "Answered its question." : result.delivered === "resumed" ? "It resumed to handle your message." : "Delivered after its current step.";
			},
		});
		inspected = shown;
		shown.closed.catch(() => undefined).finally(() => { if (inspected === shown) inspected = undefined; });
	};

	type RowContext = Parameters<typeof subagentCallRow>[2];
	/** A row that opens the inspector on click, once its agent is known. */
	const clickable = (component: Component, context: RowContext): Component => ({
		render: (width) => component.render(width),
		invalidate: () => component.invalidate(),
		handleMouse: (event: { type: string; button: string }) => {
			const name = (context?.state as { agent?: string } | undefined)?.agent;
			if (event.type !== "click" || event.button !== "left" || !name || !state?.team.get(name) || !inspectorUi) return undefined;
			inspect(name);
			return { handled: true };
		},
	} as Component);

	const run = watchRun(pi);
	const withRows = (tool: ToolDefinition): ToolDefinition => markRow({
		...tool,
		renderShell: "self" as const,
		renderCall: (args: unknown, theme: Theme, context?: RowContext) => tool.name === "subagent"
			? clickable(subagentCallRow(args, theme, context, (name) => state?.team.get(name), run.streaming), context)
			: messageCallRow(args, theme, context, run.streaming),
		renderResult: (result: unknown, _options: { expanded: boolean }, theme: Theme, context?: RowContext) => {
			if (tool.name !== "subagent") return messageResultRow(result, theme, context);
			rememberAgent(context, (result as { details?: unknown } | null)?.details);
			return clickable(subagentResultRow(result, theme, context, markdown), context);
		},
	} as ToolDefinition, "band");

	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(MESSAGE_TYPE, createMessageRenderer(markdown));
		pi.registerMessageRenderer(REPORT_TYPE, createReportRenderer(markdown));
	}

	const build = (ctx: ExtensionContext): SessionState => {
		const agentDir = sdk.getAgentDir();
		const cwd = ctx.cwd;
		const config = loadConfig();
		const thinking = thinkingSettings(cwd, agentDir);
		const allowed = allowedModels(ctx.scopedModels ?? [], ctx.model);
		const parentRef = ctx.model ? refOf(ctx.model) : null;
		const configured = config.defaultModel ? resolveModel(config.defaultModel, allowed) : null;
		if (configured && !configured.ok) ctx.ui.notify(`subagents.defaultModel: ${configured.error}`, "warning");
		const fallbackModel = configured?.ok ? configured.choice.ref : parentRef && allowed.some((choice) => choice.ref === parentRef) ? parentRef : allowed[0]?.ref ?? null;
		const sessionId = ctx.sessionManager.getSessionId();
		const owner = recoveryOwner(ctx.sessionManager);
		const logFile = runLogPath(agentDir);
		const sessionDir = join(agentDir, "sessions", "subagents", sessionId);
		let logFailed = false;
		const warn = (message: string) => ctx.ui.notify(message, "warning");
		const index = new ChildIndex(sessionDir, sessionId, cwd);
		const releaseParent = acquireParent(sessionDir);
		const scanner = createSessionScanner(sdk.parseSessionEntries, sdk.migrateSessionEntries);
		const badFiles = new Set<string>();
		const readBranch = (file: string) => {
			try { return scanner.branch(file); }
			catch (error) {
				if (!badFiles.has(file)) ctx.ui.notify(`subagents: skipping ${file}: ${(error as Error).message}`, "warning");
				badFiles.add(file);
				throw error;
			}
		};
		let workspaceMoved = false;
		let previousShutdown: string | undefined;
		let previousOwner: string | undefined;
		let signalReason: string | undefined;

		// The team is made below; the mail only asks it once reports arrive.
		let team!: Team;
		const mail = new MainMail({
			batchMs: config.batchMs,
			groupWaitMs: config.groupWaitMs,
			groupBusy: (group, except) => team.list().some((r) => r.group === group && r.name !== except && LIVE_STATES.has(r.state)),
			port: { send: (message, options) => pi.sendMessage(message, options) },
			onChange: () => {
				widget.update();
				watchPending(ctx);
			},
		});
		// The launcher and tools need the team, and the team needs the launcher.
		let tools!: ToolContext;
		team = new Team({
			warn,
			maxConcurrent: config.maxConcurrent,
			maxDepth: config.maxDepth,
			replyTimeoutMs: config.replyTimeoutMs,
			messagesFor: (record) => record.sessionFile && existsSync(record.sessionFile) && !record.restoreError ? scanner.messages(record.sessionFile) : [],
			prepareResume: (record) => {
				const model = allowed.some((choice) => choice.ref === record.model) ? record.model : fallbackModel;
				if (!model) throw new Error("No current default model is available for this child. Scope a model before resuming.");
				const notes = [model !== record.model ? `Your previous model ${record.model} is out of scope. You are continuing on the current default ${model}.` : "",
					workspaceMoved ? `Your workspace moved from ${index.cwd} to ${cwd}. Verify files in the parent's current workspace before continuing.` : ""].filter(Boolean);
				const notice = model !== record.model ? `Model ${record.model} is not available now, running on ${model}.` : undefined;
				if (notice) ctx.ui.notify(notice, "warning");
				return { model, note: notes.join("\n"), ...(notice ? { notice } : {}) };
			},
			sessionFileFor: (name) => join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}_${randomUUID().slice(0, 8)}.jsonl`),
			deliverToMain: (delivery) => mail.deliver(delivery),
			launcher: createLauncher({
				sdk, agentDir, cwd,
				sessionDir,
				modelRuntime: runtimeSource(ctx),
				modelAllowed: (model) => allowed.some((choice) => choice.ref === model),
				toolsFor: (record) => {
					const names = childToolNames(pi.getActiveTools(), record.readOnly, config.childToolsExclude);
					return {
						tools: names,
						extensionPaths: childExtensionPaths(pi.getAllTools(), names),
						customTools: [
							childMessageTool(tools, record.name),
							...(record.depth < config.maxDepth ? [subagentTool(tools, record.name)] : []),
						],
					};
				},
				instructions: (record) => childInstructions({
					name: record.name, parent: record.parent, readOnly: record.readOnly, canSpawn: record.depth < config.maxDepth,
					roster: rosterText(record.name, team.list().map((r) => ({ name: r.name, task: r.task, state: r.state, model: r.model }))),
					...(record.fork ? { conversation: conversationDigest(ctx.sessionManager.getBranch(), describeTool) } : {}),
				}),
			}),
		});
		tools = {
			team, allowed, fallbackModel, thinking, modelTable: modelTable(allowed, thinking),
			guide: readGuide(agentDir, cwd).text, replyTimeoutMs: config.replyTimeoutMs, now: Date.now,
			currentGroup: () => `run-${mainRun}`,
		};

		try {
			const records = index.load(warn);
			previousShutdown = index.shutdown;
			previousOwner = index.shutdownOwner;
			const roster = records.length > 0 || existsSync(index.file) ? records : legacyRecords(ctx.sessionManager.getBranch(), sessionDir, MAIN, 1, readBranch, warn);
			workspaceMoved = index.cwd !== cwd;
			team.restore(recoverRoster(roster, sessionDir, readBranch, warn));
			if (workspaceMoved && index.markWorkspaceNotice(cwd)) ctx.ui.notify(`subagents: workspace changed from ${index.cwd} to ${cwd}. Auto-resume is paused; inspect and resume children explicitly.`, "warning");
		} catch (error) {
			mail.dispose();
			releaseParent();
			throw new Error(`Could not restore ${index.file}: ${(error as Error).message}. The index has been left unchanged.`);
		}
		try {
			appendInterruptedRuns(logFile, team.list(), sessionId, Date.now());
			if (team.list().length > 0) index.save(team.list());
		} catch (error) { ctx.ui.notify(`subagents: could not record restored children: ${(error as Error).message}`, "warning"); }
		let logged = new Set<string>();
		try { logged = loggedRunKeys(logFile); }
		catch (error) { ctx.ui.notify(`subagents: could not read run log ${logFile}: ${(error as Error).message}`, "warning"); }
		const unsubscribe = team.onChange((record) => {
			widget.update();
			publishBackground();
			const saveWarning = (error: unknown) => ctx.ui.notify(`subagents: could not save ${index.file}: ${(error as Error).message}`, "warning");
			try { index.update(team.list(), saveWarning); }
			catch (error) { saveWarning(error); }
			if (!record || LIVE_STATES.has(record.state)) return;
			const entry = runLogEntry(record, Date.now(), sessionId);
			const key = runKey(entry);
			if (logged.has(key)) return;
			try {
				appendRunLog(logFile, entry);
				logged.add(key);
			} catch (error) {
				if (!logFailed) ctx.ui.notify(`subagents: could not write the run log ${logFile}: ${(error as Error).message}`, "warning");
				logFailed = true;
			}
		});

		const removeSignals = installSignalRecorder((signal) => {
			try {
				signalReason = signal;
				team.interrupt("signal", owner);
				index.save(team.list(), signal, owner);
				appendInterruptedRuns(logFile, team.list(), sessionId, Date.now());
			} catch (error) { ctx.ui.notify(`subagents: could not record ${signal}: ${(error as Error).message}`, "warning"); }
		});
		return {
			team, mail, tools, config,
			async restore(reason) {
				const interrupted = team.list().filter((record) => record.state === "interrupted" && !record.interruptionAnnounced);
				if (interrupted.length === 0) return;
				const lines: string[] = [];
				const resumed: string[] = [];
				for (const record of interrupted) {
					const decision = recoveryDecision(record, { reason, policy: config.resumePolicy, shutdown: previousShutdown, shutdownOwner: previousOwner,
						owner, allowed: new Set(allowed.map((choice) => choice.ref)), moved: workspaceMoved });
					if (decision.resume) team.markRecovery(record.name, { autoResumeAttempts: (record.autoResumeAttempts ?? 0) + 1, interruptedBy: undefined });
					let action = decision.why;
					if (decision.resume) {
						const sent = await team.send(MAIN, record.name, "Continue your interrupted task and report the outcome.", { automatic: true });
						if (sent.ok && sent.delivered === "resumed") resumed.push(record.name);
						else action = `Paused: ${sent.ok ? sent.delivered : sent.error}`;
					}
					const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);
					lines.push(`${record.name}: task ${short(record.task)}; last activity ${short(record.activity ?? record.state)}. ${action}`);
				}
				const notice = `Subagents restored after ${reason}. ${resumed.length ? "Auto-resuming eligible children." : "Not resumed."}\n${lines.join("\n")}\nPaused children require message from their parent or /subagents resume <name>.`;
				pi.sendMessage({ customType: "subagent-restore", content: notice, display: true, details: { reason, resumed, names: interrupted.map((r) => r.name) } }, { triggerTurn: false });
				for (const record of interrupted) team.markRecovery(record.name, { interruptionAnnounced: true });
				index.save(team.list());
				ctx.ui.notify(notice, "warning");
			},
			async close(reason = "quit") {
				removeSignals();
				mail.dispose();
				try {
					await team.close(signalReason ? "signal" : reason === "reload" ? "reload" : "quit", owner);
					index.save(team.list(), signalReason ?? reason, owner);
				} finally { unsubscribe(); releaseParent(); }
			},
		};
	};

	const ours = (path: unknown) => /[/\\]extensions[/\\]subagents\.ts$/.test(String(path ?? ""));
	/** Another extension owns the tool name; Pi keeps the first registration's rows and behavior. */
	const foreign = (name: string) => {
		const owner = pi.getAllTools().find((info) => info.name === name);
		return owner !== undefined && !ours(owner.sourceInfo?.path);
	};

	pi.on("session_start", async (event, ctx) => {
		await state?.close();
		state = null;
		backgroundCtx = undefined;
		// Two subagent systems in one session would split the model's attention and the user's.
		if (foreign("subagent")) {
			ctx.ui.notify("pi-extras Subagents is off: another extension already provides a subagent tool. Remove one of them.", "warning");
			return;
		}
		try { state = build(ctx); }
		catch (error) { ctx.ui.notify(`subagents: ${(error as Error).message}`, "warning"); return; }
		backgroundCtx = ctx;
		publishBackground();
		const current = state;
		for (const tool of [subagentTool(current.tools, MAIN), mainMessageTool(current.tools)]) {
			if (foreign(tool.name)) {
				ctx.ui.notify(`subagents: tool name "${tool.name}" is already registered by another extension; skipping it.`, "warning");
				continue;
			}
			pi.registerTool(offerRows(withRows(tool)));
		}
		inspectorUi = ctx.hasUI && ctx.mode === "tui" ? ctx.ui as unknown as InspectorHost : null;
		if (ctx.hasUI && ctx.mode === "tui") {
			widget.attach(ctx.ui as never, () => ({ records: current.team.list(), pending: current.mail.pending() }), inspect);
		}
		await current.restore(event.reason);
	});

	// A note appended without waking main raises no event, so look for it.
	let reconcileTimer: ReturnType<typeof setInterval> | null = null;
	const reconcile = (ctx: ExtensionContext) => {
		if (!state) return;
		try {
			state.mail.reconcile(ctx.sessionManager.getBranch());
		} catch {
			// A stale context after a session switch; the next session starts clean.
		}
	};
	const watchPending = (ctx: ExtensionContext) => {
		if (reconcileTimer || !state || state.mail.pending().length === 0) return;
		reconcileTimer = setInterval(() => {
			reconcile(ctx);
			if (!state || state.mail.pending().length === 0) {
				if (reconcileTimer) clearInterval(reconcileTimer);
				reconcileTimer = null;
			}
		}, RECONCILE_MS);
	};
	pi.on("turn_end", async (_event, ctx) => reconcile(ctx));
	pi.on("agent_end", async (_event, ctx) => reconcile(ctx));
	pi.on("agent_settled", async (_event, ctx) => reconcile(ctx));

	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; customType?: string; details?: { id?: unknown } } }).message;
		if (message?.role !== "custom" || (message.customType !== MESSAGE_TYPE && message.customType !== REPORT_TYPE)) return;
		if (typeof message.details?.id === "string") state?.mail.acknowledge(message.details.id);
	});

	pi.on("session_shutdown", async (event) => {
		if (reconcileTimer) clearInterval(reconcileTimer);
		reconcileTimer = null;
		widget.detach();
		await state?.close(event.reason);
		if (backgroundCtx && event.reason !== "reload") announceBackground(pi, backgroundCtx, "subagents", 0);
		backgroundCtx = undefined;
		state = null;
	});

	pi.registerCommand("subagents", {
		description: "Inspect subagents (/subagents [name]), find full reports (report <name>), resume them (resume <name>), stop them (stop <name> | stop all), edit the model guide (guide), or see runs by model (stats)",
		getArgumentCompletions: (prefix: string) => commandCompletions(prefix, state?.team.list().map((record) => record.name) ?? []),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [verb, ...rest] = args.trim().split(/\s+/);
			if (verb === "guide") return editGuide(ctx);
			if (verb === "stats") {
				const file = runLogPath(sdk.getAgentDir());
				const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
				return ctx.ui.notify(`Subagent runs by model (${file}):\n${statsText(statsByModel(lines), formatTime, formatMoney)}`, "info");
			}
			if (!state) return ctx.ui.notify("Subagents are not active in this session.", "info");
			if (verb === "report") {
				const name = rest.join(" ");
				if (!name) return ctx.ui.notify("Usage: /subagents report <name>", "info");
				const record = state.team.get(name);
				if (!record) return ctx.ui.notify(`No subagent named ${name}.`, "warning");
				try {
					const file = record.reportFile ?? (record.sessionFile ? latestReportFile(record.sessionFile) : undefined);
					return ctx.ui.notify(file ? `Report for ${name}: ${file}` : `No saved report for ${name} yet.`, "info");
				} catch (error) {
					return ctx.ui.notify(`Could not find the report for ${name}: ${(error as Error).message}`, "warning");
				}
			}
			if (verb === "resume") {
				const name = rest.join(" ");
				const record = state.team.get(name);
				if (!record) return ctx.ui.notify(`No subagent named ${name}.`, "warning");
				if (LIVE_STATES.has(record.state)) return ctx.ui.notify(`${name} is already running.`, "info");
				if (record.state !== "interrupted") return ctx.ui.notify(`${name} is not interrupted. Message it to start new work.`, "info");
				const result = await state.team.send(USER, name, "Continue your task and report the outcome.");
				return ctx.ui.notify(result.ok ? `${name}: ${result.delivered}.${result.notice ? ` ${result.notice}` : ""}` : result.error, result.ok ? "info" : "warning");
			}
			if (verb === "stop") {
				const target = rest.join(" ");
				const names = target === "all" ? state.team.list().filter((record) => LIVE_STATES.has(record.state) || record.state === "interrupted").map((record) => record.name) : [target];
				for (const name of names) {
					if (!state.team.get(name)) { ctx.ui.notify(`No subagent named ${name}.`, "warning"); continue; }
					await state.team.stop(name);
				}
				return;
			}
			const records = state.team.list();
			if (verb && state.team.get(verb) && inspectorUi) return inspect(verb);
			if (!inspectorUi || records.length === 0) return ctx.ui.notify(listing(records), "info");
			const width = Math.max(...records.map((record) => record.name.length));
			const now = Date.now();
			// The picker wraps long lines; one agent per line reads better.
			const fit = Math.max(40, (process.stdout.columns || 120) - 8);
			const choice = await ctx.ui.select("Subagents", records.slice().reverse().map((record) => listLabel(record, width, now, fit)));
			if (choice) inspect(choice.split(/\s+/)[0]!);
		},
	});

	async function editGuide(ctx: ExtensionCommandContext): Promise<void> {
		const file = join(sdk.getAgentDir(), GUIDE_FILE);
		const current = existsSync(file) ? readFileSync(file, "utf8") : GUIDE_TEMPLATE;
		const edited = await ctx.ui.editor("Subagent model guide (applies after /reload)", current);
		if (edited === undefined || edited === current) return;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, edited.endsWith("\n") ? edited : `${edited}\n`);
		ctx.ui.notify(`Saved ${file}. Run /reload to apply it.`, "info");
	}
}

function listing(records: readonly AgentRecord[]): string {
	if (records.length === 0) return "No subagents in this session.";
	const width = Math.max(...records.map((record) => record.name.length));
	return records.map((record) => listLabel(record, width, Date.now())).join("\n");
}
