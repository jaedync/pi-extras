/**
 * subagents: background child agents on the model of your choice, which talk
 * to main and to each other, with a live band per agent above the editor.
 *
 * Children are Pi sessions in this process. Which models they may use comes
 * from the session's scoped models; which model suits what comes from the
 * user's guide file. Both are read at session start and on /reload only, so
 * the tool description never changes mid-session. Children do not survive a
 * restart or reload.
 */
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelRuntime, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLauncher, childToolNames, describeTool } from "../lib/subagents/child.ts";
import { GUIDE_FILE, loadConfig, readGuide, type SubagentsConfig } from "../lib/subagents/config.ts";
import { MainMail, MESSAGE_TYPE, REPORT_TYPE } from "../lib/subagents/deliver.ts";
import { childInstructions, conversationDigest, rosterText } from "../lib/subagents/format.ts";
import { allowedModels, modelTable, refOf, resolveModel, type ThinkingSettings } from "../lib/subagents/models.ts";
import { commandCompletions, MAIN, USER } from "../lib/subagents/names.ts";
import { type InspectorHost, openAgentInspector } from "../lib/subagents/inspector.ts";
import { createMessageRenderer, createReportRenderer, messageCallRow, messageResultRow, rememberAgent, subagentCallRow, subagentResultRow } from "../lib/subagents/render.ts";
import { markRow } from "../lib/tool-row.ts";
import { appendRunLog, runLogEntry, runLogPath, statsByModel, statsText } from "../lib/subagents/runlog.ts";
import { formatTime } from "../lib/band/band.ts";
import { formatMoney } from "../lib/status-plus-logic.ts";
import { Team } from "../lib/subagents/team.ts";
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
	close(): Promise<void>;
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
	const widget = createAgentsWidget();
	let mainRun = 0;
	pi.on("agent_start", async () => { mainRun++; });
	let inspectorUi: InspectorHost | null = null;

	const inspect = (name: string): void => {
		const current = state;
		if (!inspectorUi || !current) return;
		openAgentInspector(inspectorUi, {
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

	const withRows = (tool: ToolDefinition): ToolDefinition => markRow({
		...tool,
		renderShell: "self" as const,
		renderCall: (args: unknown, theme: Theme, context?: RowContext) => tool.name === "subagent"
			? clickable(subagentCallRow(args, theme, context, (name) => state?.team.get(name)), context)
			: messageCallRow(args, theme, context),
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
		const fallbackModel = configured?.ok ? configured.choice.ref : parentRef;
		const sessionId = ctx.sessionManager.getSessionId();
		const logFile = runLogPath(agentDir);
		const sessionDir = join(agentDir, "sessions", "subagents", sessionId);
		let logFailed = false;

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
			maxConcurrent: config.maxConcurrent,
			maxDepth: config.maxDepth,
			replyTimeoutMs: config.replyTimeoutMs,
			sessionFileFor: (name) => join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}_${randomUUID().slice(0, 8)}.jsonl`),
			deliverToMain: (delivery) => mail.deliver(delivery),
			launcher: createLauncher({
				sdk, agentDir, cwd,
				sessionDir,
				modelRuntime: runtimeSource(ctx),
				toolsFor: (record) => ({
					tools: childToolNames(pi.getActiveTools(), record.readOnly, config.childToolsExclude),
					customTools: [
						childMessageTool(tools, record.name),
						...(record.depth < config.maxDepth ? [subagentTool(tools, record.name)] : []),
					],
				}),
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

		const logged = new Set<string>();
		const unsubscribe = team.onChange((record) => {
			widget.update();
			if (!record || LIVE_STATES.has(record.state)) return;
			const key = `${record.name}#${record.runs}#${record.state}`;
			if (logged.has(key)) return;
			logged.add(key);
			try {
				appendRunLog(logFile, runLogEntry(record, Date.now(), sessionId));
			} catch (error) {
				if (!logFailed) ctx.ui.notify(`subagents: could not write the run log ${logFile}: ${(error as Error).message}`, "warning");
				logFailed = true;
			}
		});

		return {
			team, mail, tools, config,
			async close() {
				unsubscribe();
				mail.dispose();
				await team.close();
			},
		};
	};

	const ours = (path: unknown) => /[/\\]extensions[/\\]subagents\.ts$/.test(String(path ?? ""));
	/** Another extension owns the tool name; Pi keeps the first registration's rows and behavior. */
	const foreign = (name: string) => {
		const owner = pi.getAllTools().find((info) => info.name === name);
		return owner !== undefined && !ours(owner.sourceInfo?.path);
	};

	pi.on("session_start", async (_event, ctx) => {
		await state?.close();
		state = null;
		// Two subagent systems in one session would split the model's attention and the user's.
		if (foreign("subagent")) {
			ctx.ui.notify("pi-extras Subagents is off: another extension already provides a subagent tool. Remove one of them.", "warning");
			return;
		}
		state = build(ctx);
		const current = state;
		for (const tool of [subagentTool(current.tools, MAIN), mainMessageTool(current.tools)]) {
			if (foreign(tool.name)) {
				ctx.ui.notify(`subagents: tool name "${tool.name}" is already registered by another extension; skipping it.`, "warning");
				continue;
			}
			pi.registerTool(withRows(tool));
		}
		inspectorUi = ctx.hasUI && ctx.mode === "tui" ? ctx.ui as unknown as InspectorHost : null;
		if (ctx.hasUI && ctx.mode === "tui") {
			widget.attach(ctx.ui as never, () => ({ records: current.team.list(), pending: current.mail.pending() }), inspect);
		}
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

	pi.on("session_shutdown", async () => {
		if (reconcileTimer) clearInterval(reconcileTimer);
		reconcileTimer = null;
		widget.detach();
		await state?.close();
		state = null;
	});

	pi.registerCommand("subagents", {
		description: "Inspect subagents (/subagents [name]), stop them (stop <name> | stop all), edit the model guide (guide), or see runs by model (stats)",
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
			if (verb === "stop") {
				const target = rest.join(" ");
				const names = target === "all" ? state.team.live().map((record) => record.name) : [target];
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
