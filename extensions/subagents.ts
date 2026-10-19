/**
 * subagents: background child agents on the model of your choice, which talk
 * to main and to each other, with a live row per agent above the editor.
 *
 * Children are Pi sessions in this process. Which models they may use comes
 * from the session's scoped models; which model suits what comes from the
 * user's guide file. Both are read at session start and on /reload only, so
 * the tool description never changes mid-session. Children keep running
 * through a /reload (serve.ts, host.ts); their transcripts and roster survive
 * restarts, with interrupted work verified on resume.
 */
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stopOrder } from "../lib/subagents/after.ts";
import { GUIDE_FILE } from "../lib/subagents/config.ts";
import type { HostState } from "../lib/subagents/contract.ts";
import { MESSAGE_TYPE, REPORT_TYPE } from "../lib/subagents/deliver.ts";
import { nextGeneration, takeParked } from "../lib/subagents/host.ts";
import { watchMain } from "../lib/subagents/main-watch.ts";
import { commandCompletions, MAIN, USER } from "../lib/subagents/names.ts";
import { type InspectorHost, openAgentInspector } from "../lib/subagents/inspector.ts";
import { openTeamView } from "../lib/subagents/team-view.ts";
import { watchRun } from "../lib/run-watch.ts";
import { announceBackground, BACKGROUND_REQUEST_EVENT } from "../lib/tab-status/events.ts";
import { agentHue } from "../lib/band/agent-look.ts";
import { createMessageRenderer, createReportRenderer, messageCallRow, messageResultRow, rememberAgent, subagentCallRow, subagentResultRow } from "../lib/subagents/render.ts";
import { offerRows } from "../lib/late-rows.ts";
import { markRow } from "../lib/tool-row.ts";
import { runLogPath, statsByModel, statsText } from "../lib/subagents/runlog.ts";
import { formatTime } from "../lib/band/band.ts";
import type { ShownOverlay } from "../lib/band/modal.ts";
import { formatMoney } from "../lib/status-plus-logic.ts";
import { editTarget } from "../lib/subagents/worktree.ts";
import { checkoutOf } from "../lib/subagents/checkout.ts";
import { savedReport } from "../lib/subagents/reports.ts";
import { LeaseHeld, type OwnerState, takeOverParent } from "../lib/subagents/ownership.ts";
import { chatSettings, mainTrust, type ServeOptions, type Served, serveSession } from "../lib/subagents/serve.ts";
import { blockedTools, mainMessageTool, stopTool, subagentTool, userSendWords } from "../lib/subagents/tools.ts";
import { LIVE_STATES, type AgentRecord } from "../lib/subagents/types.ts";
import { createAgentsWidget, listLabel } from "../lib/subagents/widget.ts";
import { awaitChildren, isHeadless } from "../lib/subagents/headless.ts";
import { watchMotion } from "../lib/extras-config.ts";

const markdown = () => sdk.getMarkdownTheme();

const RECONCILE_MS = 1_000;
const BLOCKED_WIDGET = "subagents-blocked";

/** A session start that could not open its subagents, kept so /subagents takeover can open them later. */
interface Blocked {
	readonly ctx: ExtensionContext;
	readonly reason: string;
	readonly error: Error;
}

const GUIDE_TEMPLATE = `# Subagent model guide

What is true today about which model to use for what. Read at session start
and on /reload. Edit freely.

- (model): (when to use it)
`;

export default function subagents(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENTS === "off") return;
	/** This evaluation of the package; a /reload makes the next one, and children it launched are told apart by it. */
	const generation = nextGeneration();
	/** The session this module serves, and through it the host: the team, mail and index. */
	let served: Served | null = null;
	const host = (): HostState | null => served?.host() ?? null;
	let blocked: Blocked | null = null;
	let backgroundCtx: ExtensionContext | undefined;
	// Resumed children keep `restored` provenance; only their current live state means work.
	const publishBackground = () => {
		const current = host();
		if (current && backgroundCtx) announceBackground(pi, backgroundCtx, "subagents", current.team.list().filter((r) => LIVE_STATES.has(r.state)).length);
	};
	pi.events?.on(BACKGROUND_REQUEST_EVENT, publishBackground);
	const motion = watchMotion(pi.events);
	const widget = createAgentsWidget(motion);
	let mainRun = 0;
	pi.on("agent_start", async () => { mainRun++; });
	// Headless runs end once main settles; main waits for its children there instead (headless.ts).
	let headless = false;
	const mainWatch = watchMain(pi, () => host()?.mail, Date.now, async () => {
		const current = host();
		return headless && current ? awaitChildren(current.team, current.mail) : undefined;
	});
	let inspectorUi: InspectorHost | null = null;
	let inspectorCwd = process.cwd();
	/** Main's decision on its project's `.pi/`, which decides the inspector's look as it does main's. */
	let inspectorTrusted: boolean | undefined;
	let inspected: ShownOverlay | undefined;

	/**
	 * One at a time, as the other sheets are; one Pi took off screen without
	 * closing it no longer counts. `back` runs once the inspector closes, to
	 * return to the agents view it was opened from.
	 */
	const inspect = (name: string, back?: () => void): void => {
		const current = served;
		if (!inspectorUi || !current || inspected?.isOpen()) return;
		// Read at each call: once an adopted team is quiet after a /reload, a new one takes its place.
		const team = () => current.host().team;
		const shown = openAgentInspector(inspectorUi, {
			record: () => team().get(name),
			messages: () => team().messages(name),
			streaming: () => team().streaming(name),
			tool: (toolName) => team().tool(name, toolName),
			cwd: team().get(name)?.cwd ?? team().get(name)?.worktree?.path ?? inspectorCwd,
			...chatSettings(sdk, inspectorCwd, sdk.getAgentDir(), inspectorTrusted),
			motion,
			hue: (other) => agentHue(team().get(other)?.model),
			stop: async () => { await team().stop(name); },
			async send(text) {
				const result = await team().send(USER, name, text);
				if (!result.ok) throw new Error(result.error);
				return userSendWords(result);
			},
		});
		inspected = shown;
		shown.closed.catch(() => undefined).finally(() => {
			if (inspected === shown) inspected = undefined;
			// No input handler is around this to catch it; a stale UI after a switch has nothing to go back to.
			try { back?.(); } catch { /* stale context after a session switch */ }
		});
	};

	/** Every agent at once; choosing one opens its inspector, and closing that comes back here, on it. */
	const viewAll = (selected?: string): void => {
		const current = served;
		if (!inspectorUi || !current || inspected?.isOpen()) return;
		let chosen: string | undefined;
		const shown = openTeamView(inspectorUi, {
			records: () => current.host().team.list(),
			pending: () => current.host().mail.pending(),
			open: (name) => { chosen = name; },
			motion,
			...(selected ? { selected } : {}),
		});
		inspected = shown;
		shown.closed.catch(() => undefined).finally(() => {
			if (inspected === shown) inspected = undefined;
			// Only within the session it was opened in: after a switch there is nothing to go back to.
			try {
				if (chosen && served === current) inspect(chosen, () => { if (served === current) viewAll(chosen); });
			} catch { /* stale context after a session switch */ }
		});
	};

	type RowContext = Parameters<typeof subagentCallRow>[2];
	/** A row that opens the inspector on click, once its agent is known. */
	const clickable = (component: Component, context: RowContext): Component => ({
		render: (width) => component.render(width),
		invalidate: () => component.invalidate(),
		handleMouse: (event: { type: string; button: string }) => {
			const name = (context?.state as { agent?: string } | undefined)?.agent;
			if (event.type !== "click" || event.button !== "left" || !name || !host()?.team.get(name) || !inspectorUi) return undefined;
			inspect(name);
			return { handled: true };
		},
	} as Component);

	const run = watchRun(pi);
	const withRows = (tool: ToolDefinition): ToolDefinition => markRow({
		...tool,
		renderShell: "self" as const,
		renderCall: (args: unknown, theme: Theme, context?: RowContext) => {
			// Written now: the reply streams and has not finished this call; Pi completes calls only when the reply ends.
			const id = String((context as { toolCallId?: unknown } | undefined)?.toolCallId ?? "");
			const writtenNow = () => run.streaming() && !run.written(id);
			return tool.name === "subagent"
				? clickable(subagentCallRow(args, theme, context, (name) => host()?.team.get(name), writtenNow, motion), context)
				: messageCallRow(args, theme, context, writtenNow, (name) => host()?.team.get(name), motion);
		},
		renderResult: (result: unknown, _options: { expanded: boolean }, theme: Theme, context?: RowContext) => {
			if (tool.name !== "subagent") return messageResultRow(result, theme, context);
			rememberAgent(context, (result as { details?: unknown } | null)?.details);
			return clickable(subagentResultRow(result, theme, context, markdown), context);
		},
	} as ToolDefinition, "band");

	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(MESSAGE_TYPE, createMessageRenderer(markdown, (name) => host()?.team.get(name)));
		pi.registerMessageRenderer(REPORT_TYPE, createReportRenderer(markdown));
	}

	const ours = (path: unknown) => /[/\\]extensions[/\\]subagents\.ts$/.test(String(path ?? ""));
	/** Another extension owns the tool name; Pi keeps the first registration's rows and behavior. */
	const foreign = (name: string) => {
		const owner = pi.getAllTools().find((info) => info.name === name);
		return owner !== undefined && !ours(owner.sourceInfo?.path);
	};

	pi.on("session_start", async (event, ctx) => {
		await served?.close();
		served = null;
		unblock(ctx);
		backgroundCtx = undefined;
		headless = isHeadless(ctx.mode);
		// A host a /reload left running, for this module to take over (host.ts).
		const parked = event.reason === "reload" ? takeParked(ctx.sessionManager) : undefined;
		// Two subagent systems in one session would split the model's attention and the user's.
		if (foreign("subagent")) {
			ctx.ui.notify("pi-extras Subagents is off: another extension already provides a subagent tool. Remove one of them.", "warning");
			await parked?.close("reload");
			return;
		}
		await serveFor(ctx, event.reason, parked);
	});

	const register = (ctx: ExtensionContext, tools: readonly ToolDefinition[]) => {
		for (const tool of tools) {
			if (foreign(tool.name)) {
				ctx.ui.notify(`subagents: tool name "${tool.name}" is already registered by another extension; skipping it.`, "warning");
				continue;
			}
			pi.registerTool(offerRows(withRows(tool)));
		}
	};

	/**
	 * Main keeps its tools while the session can't be served, and each call says
	 * why: without them the agent can't learn that the tools exist, and it may
	 * try to run Pi some other way. A start-up notice alone scrolls away, so a
	 * line above the editor stays until the subagents open.
	 */
	const block = (ctx: ExtensionContext, reason: string, error: Error) => {
		const state: Blocked = { ctx, reason, error };
		blocked = state;
		ctx.ui.notify(`subagents: ${error.message}`, "warning");
		register(ctx, blockedTools(() => state.error.message));
		if (ctx.hasUI && ctx.mode === "tui") {
			const line = blockedLine(error);
			try { ctx.ui.setWidget(BLOCKED_WIDGET, (_tui, theme) => new Text(theme.fg("warning", line), 1, 0)); } catch { /* stale context after a session switch */ }
		}
	};
	const unblock = (ctx: ExtensionContext) => {
		blocked = null;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		try { ctx.ui.setWidget(BLOCKED_WIDGET, undefined); } catch { /* stale context after a session switch */ }
	};

	/** Opens the session's subagents and gives main its tools; false if they could not open, and main's tools then say why. */
	async function serveFor(ctx: ExtensionContext, reason: string, parked?: ServeOptions["parked"]): Promise<boolean> {
		try {
			served = await serveSession({
				sdk, pi, ctx, generation, parked,
				route: () => mainWatch.route(ctx),
				teamChanged: () => { widget.update(); publishBackground(); },
				mailChanged: () => { widget.update(); watchPending(ctx); },
				// Numbered by generation too: a child from before a /reload may still report with its group.
				currentGroup: () => `run-${generation}-${mainRun}`,
			});
		} catch (error) {
			block(ctx, reason, error as Error);
			return false;
		}
		unblock(ctx);
		backgroundCtx = ctx;
		publishBackground();
		const current = served;
		register(ctx, [subagentTool(current.tools, MAIN), mainMessageTool(current.tools), stopTool(current.tools, MAIN)]);
		inspectorUi = ctx.hasUI && ctx.mode === "tui" ? ctx.ui as unknown as InspectorHost : null;
		inspectorCwd = ctx.cwd;
		inspectorTrusted = mainTrust(ctx);
		if (ctx.hasUI && ctx.mode === "tui") {
			widget.attach(ctx.ui as never, () => ({ records: current.host().team.list(), pending: current.host().mail.pending() }), inspect, () => viewAll());
		}
		if (current.adopted) {
			// Mail sent before the reload may still wait for Pi to show it.
			watchPending(ctx);
			current.lookForQuiet();
		} else await current.host().restore(reason);
		return true;
	}

	/** Ends the parent that holds this session's lease, after the user agrees, then opens the subagents here. */
	async function takeover(ctx: ExtensionCommandContext): Promise<void> {
		if (served) return ctx.ui.notify("This Pi already serves this session's subagents.", "info");
		const state = blocked;
		if (!state) return ctx.ui.notify("Subagents are not active in this session.", "info");
		// Not a held lease: nothing to end, so this only tries to open the subagents again.
		const result = state.error instanceof LeaseHeld
			? await takeOverParent(state.error.dir, { confirm: ({ pid, state: doing }) => ctx.ui.confirm("Take over subagents?", takeoverQuestion(pid, doing)) })
			: { ok: true as const };
		if (!result.ok) return ctx.ui.notify(result.error, "warning");
		// The session changed while it waited.
		if (blocked !== state) return;
		if (!(await serveFor(state.ctx, state.reason))) return;
		const from = result.pid ? ` from process ${result.pid}` : "";
		ctx.ui.notify(`Took over this session's subagents${from}.${result.notice ? ` ${result.notice}` : ""}`, result.notice ? "warning" : "info");
		if (inspectorUi && host()?.team.list().length) viewAll();
	}

	// A note appended without waking main raises no event, so look for it.
	let reconcileTimer: ReturnType<typeof setInterval> | null = null;
	const reconcile = (ctx: ExtensionContext) => {
		const current = host();
		if (!current) return;
		try {
			current.mail.reconcile(ctx.sessionManager.getBranch());
		} catch {
			// A stale context after a session switch; the next session starts clean.
		}
	};
	const watchPending = (ctx: ExtensionContext) => {
		if (reconcileTimer || !host() || host()!.mail.pending().length === 0) return;
		reconcileTimer = setInterval(() => {
			reconcile(ctx);
			if (!host() || host()!.mail.pending().length === 0) {
				if (reconcileTimer) clearInterval(reconcileTimer);
				reconcileTimer = null;
			}
		}, RECONCILE_MS);
	};
	pi.on("turn_end", async (_event, ctx) => reconcile(ctx));
	pi.on("agent_end", async (_event, ctx) => reconcile(ctx));
	pi.on("agent_settled", async (_event, ctx) => reconcile(ctx));

	// Main's own calls, seen here, not in a child's session. Its bash calls are named by work tree,
	// as a child's bash watch names its own (bash-guard.ts); looked up once per directory.
	let mainTree: { cwd: string; root: string } | undefined;
	const treeOf = (cwd: string): string => (mainTree?.cwd === cwd ? mainTree : (mainTree = { cwd, root: checkoutOf(cwd) })).root;
	pi.on("tool_call", (event, ctx) => {
		const id = `${MAIN}:${event.toolCallId}`;
		const activity = host()?.activity;
		if (!activity) return;
		if (event.toolName === "bash") activity.shellStart(id, treeOf(ctx.cwd));
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const target = editTarget(ctx.cwd, (event.input as { path?: unknown }).path);
		if (target !== undefined) activity.editStart(id, target);
	});
	pi.on("tool_execution_end", (event) => host()?.activity.end(`${MAIN}:${event.toolCallId}`));

	pi.on("message_end", (event) => {
		const message = (event as { message?: { role?: string; customType?: string; details?: { id?: unknown } } }).message;
		if (message?.role !== "custom" || (message.customType !== MESSAGE_TYPE && message.customType !== REPORT_TYPE)) return;
		if (typeof message.details?.id === "string") host()?.mail.acknowledge(message.details.id);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (reconcileTimer) clearInterval(reconcileTimer);
		reconcileTimer = null;
		widget.detach();
		const current = served;
		served = null;
		// The children keep running; the module Pi loads next takes them over (host.ts). Quick, as Pi waits for it.
		if (event.reason === "reload") await current?.park(ctx.sessionManager);
		else await current?.close(event.reason);
		if (backgroundCtx && event.reason !== "reload") announceBackground(pi, backgroundCtx, "subagents", 0);
		backgroundCtx = undefined;
		unblock(ctx);
	});

	pi.registerCommand("subagents", {
		description: "See every subagent (/subagents) or inspect one (/subagents <name>), find full reports (report <name>), resume them (resume <name>), stop them (stop <name> | stop all), take them over from a Pi that holds them (takeover), edit the model guide (guide), or see runs by model (stats)",
		getArgumentCompletions: (prefix: string) => commandCompletions(prefix, host()?.team.list().map((record) => record.name) ?? []),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [verb, ...rest] = args.trim().split(/\s+/);
			if (verb === "guide") return editGuide(ctx);
			if (verb === "stats") {
				const file = runLogPath(sdk.getAgentDir());
				const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
				return ctx.ui.notify(`Subagent runs by model (${file}):\n${statsText(statsByModel(lines), formatTime, formatMoney)}`, "info");
			}
			if (verb === "takeover") return takeover(ctx);
			const state = host();
			if (!state) return ctx.ui.notify(blocked?.error.message ?? "Subagents are not active in this session.", blocked ? "warning" : "info");
			if (verb === "report") return reportCommand(state, rest.join(" "), ctx);
			if (verb === "resume") return resumeCommand(state, rest.join(" "), ctx);
			if (verb === "stop") return stopCommand(state, rest.join(" "), ctx);
			const records = state.team.list();
			// Every word above is a subcommand, so anything else names an agent, and a name that isn't one is a typo.
			if (verb && !state.team.get(verb)) return ctx.ui.notify(`No subagent named ${verb}.`, "warning");
			if (verb && inspectorUi) return inspect(verb);
			if (!inspectorUi || records.length === 0) return ctx.ui.notify(listing(records), "info");
			viewAll();
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

async function reportCommand(state: HostState, name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!name) return ctx.ui.notify("Usage: /subagents report <name>", "info");
	const record = state.team.get(name);
	if (!record) return ctx.ui.notify(`No subagent named ${name}.`, "warning");
	try {
		const saved = savedReport(record);
		if (!saved) return ctx.ui.notify(`No saved report for ${name} yet.`, "info");
		// A run that said nothing saved no report; an older run's is not this one's.
		const older = saved.run !== undefined && saved.run < record.runs ? ` (from run ${saved.run}; run ${record.runs} saved none)` : "";
		return ctx.ui.notify(`Report for ${name}${older}: ${saved.file}`, "info");
	} catch (error) {
		return ctx.ui.notify(`Could not find the report for ${name}: ${(error as Error).message}`, "warning");
	}
}

async function resumeCommand(state: HostState, name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!name) return ctx.ui.notify("Usage: /subagents resume <name>", "info");
	const record = state.team.get(name);
	if (!record) return ctx.ui.notify(`No subagent named ${name}.`, "warning");
	if (LIVE_STATES.has(record.state)) return ctx.ui.notify(`${name} is already running.`, "info");
	if (record.state !== "interrupted") return ctx.ui.notify(`${name} is not interrupted. Message it to start new work.`, "info");
	const result = await state.team.send(USER, name, "Continue your task and report the outcome.");
	return ctx.ui.notify(result.ok ? `${name}: ${result.delivered}.${result.notice ? ` ${result.notice}` : ""}` : result.error, result.ok ? "info" : "warning");
}

async function stopCommand(state: HostState, target: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!target) return ctx.ui.notify("Usage: /subagents stop <name>, or /subagents stop all", "info");
	const stoppable = (record: AgentRecord) => LIVE_STATES.has(record.state) || record.state === "interrupted";
	if (target === "all") {
		const names = stopOrder(state.team.list().filter(stoppable)).map((record) => record.name);
		if (names.length === 0) return ctx.ui.notify("No subagents are running.", "info");
		for (const name of names) await state.team.stop(name);
		return;
	}
	if (!state.team.get(target)) return ctx.ui.notify(`No subagent named ${target}.`, "warning");
	if (!(await state.team.stop(target))) ctx.ui.notify(`${target} has already ended; there is nothing to stop.`, "info");
}

function blockedLine(error: Error): string {
	if (!(error instanceof LeaseHeld)) return `Subagents are off in this session: ${error.message}`;
	if (error.state === "elsewhere") return `Subagents are off here: process ${error.pid} on another host owns them. Close it there.`;
	if (error.state === "suspended") return `Subagents are off here: process ${error.pid}, which is suspended (Ctrl-Z), owns them. Run fg in its terminal, or /subagents takeover here.`;
	return `Subagents are off here: process ${error.pid}, which is still running, owns them. Close it, or run /subagents takeover here.`;
}

function takeoverQuestion(pid: number, state: OwnerState): string {
	const doing = state === "suspended" ? "is suspended (Ctrl-Z)" : "is still running";
	return `Process ${pid} owns this session's subagents and ${doing}. Takeover ends that Pi with SIGTERM. Its running subagents stop, and this Pi opens them and follows the resume policy.`;
}

function listing(records: readonly AgentRecord[]): string {
	if (records.length === 0) return "No subagents in this session.";
	const width = Math.max(...records.map((record) => record.name.length));
	return records.map((record) => listLabel(record, width, Date.now())).join("\n");
}
