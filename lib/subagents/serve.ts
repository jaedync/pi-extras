/**
 * One module's service of one session (contract.ts says how a /reload hands
 * it on): the scope it read at the session start (config, models, guide), the
 * ports and the child launcher built from this module's code, and main's tool
 * context, whose team is read at each call. It adopts the host a /reload left
 * running, or opens one from the index as a start does. An adopted host keeps
 * its older team and mail until nothing is live and all mail has reached
 * main; then a host from this module's code takes over, quietly.
 */
import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { operationalError } from "../operational-log.ts";
import { allowedTools } from "./allowlist.ts";
import { childExtensionPaths, childToolNames, createLauncher, describeTool } from "./child.ts";
import { loadConfig, readGuide, type SubagentsConfig } from "./config.ts";
import { HOST_VERSION, type HostActivity, type HostPorts, type HostState, type HostTeam, type ModelScope, type ParkedHost } from "./contract.ts";
import type { Route } from "./deliver.ts";
import { childInstructions, conversationDigest, rosterText } from "./format.ts";
import { parkHost } from "./host.ts";
import { openHost } from "./host-state.ts";
import { allowedModels, modelTable, refOf, resolveModel, type ThinkingSettings } from "./models.ts";
import { recoveryOwner } from "./recovery.ts";
import { createSessionScanner } from "./session-scan.ts";
import { ToolActivity } from "./tool-activity.ts";
import { childMessageTool, stopTool, subagentTool, type ToolContext } from "./tools.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");
type ToolInfos = ReturnType<ExtensionAPI["getAllTools"]>;

/** What a session start reads; the guide and model table go into tool descriptions, so they stay until the next start. */
export interface Scope extends ModelScope {
	readonly config: SubagentsConfig;
	readonly thinking: ThinkingSettings;
	readonly guide: string;
}

function thinkingSettings(sdk: Sdk, cwd: string, agentDir: string): ThinkingSettings {
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

export function sessionScope(sdk: Sdk, ctx: ExtensionContext): Scope {
	const agentDir = sdk.getAgentDir();
	const config = loadConfig();
	const allowed = allowedModels(ctx.scopedModels ?? [], ctx.model);
	const parentRef = ctx.model ? refOf(ctx.model) : null;
	const configured = config.defaultModel ? resolveModel(config.defaultModel, allowed) : null;
	if (configured && !configured.ok) ctx.ui.notify(`subagents.defaultModel: ${configured.error}`, "warning");
	const fallbackModel = configured?.ok ? configured.choice.ref : parentRef && allowed.some((choice) => choice.ref === parentRef) ? parentRef : allowed[0]?.ref ?? null;
	return { config, allowed, fallbackModel, thinking: thinkingSettings(sdk, ctx.cwd, agentDir), guide: readGuide(agentDir, ctx.cwd).text };
}

/** The parent's model runtime when Pi exposes it, so children share auth and providers. */
function runtimeSource(sdk: Sdk, ctx: ExtensionContext): () => Promise<ModelRuntime> {
	let own: Promise<ModelRuntime> | null = null;
	const parent = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
	return () => {
		if (parent && typeof (parent as { refresh?: unknown }).refresh === "function") return Promise.resolve(parent);
		own ??= sdk.ModelRuntime.create();
		return own;
	};
}

/**
 * Main's tools and branch for this module's launches. Pi's `pi` and `ctx` throw
 * once a reload replaces them, and a launch under way then still needs them,
 * so they are kept as they were when the reload began.
 */
interface LivePi {
	activeTools(): string[];
	allTools(): ToolInfos;
	branch(): readonly unknown[];
	freeze(): void;
}

function livePi(pi: ExtensionAPI, ctx: ExtensionContext): LivePi {
	let frozen: { readonly active: string[]; readonly all: ToolInfos; readonly branch: readonly unknown[] } | undefined;
	return {
		activeTools: () => frozen?.active ?? pi.getActiveTools(),
		allTools: () => frozen?.all ?? pi.getAllTools(),
		branch: () => frozen?.branch ?? ctx.sessionManager.getBranch(),
		freeze() { frozen = { active: pi.getActiveTools(), all: pi.getAllTools(), branch: ctx.sessionManager.getBranch() }; },
	};
}

export interface ServeOptions {
	readonly sdk: Sdk;
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly generation: number;
	/** What the reload before this start left running, if anything. */
	readonly parked: ParkedHost | undefined;
	/** Where main is for its mail (main-watch.ts). */
	readonly route: () => Route;
	/** A record changed, or the mail did: redraw and the like. */
	readonly teamChanged: () => void;
	readonly mailChanged: () => void;
	/** Main's current run; children it starts in one run report together. */
	readonly currentGroup: () => string;
}

export interface Served {
	/** The host now; a quiet swap may replace it after a /reload. */
	host(): HostState;
	/** Whether this start took over a host a /reload left running. */
	readonly adopted: boolean;
	/** Main's tools' context; its team is the current host's. */
	readonly tools: ToolContext;
	/** Opens a host from this module's code once the adopted one is quiet; looked at after each change. */
	lookForQuiet(): void;
	/** Pi reloads: leaves the host for the next module. */
	park(session: object): void;
	close(reason?: string): Promise<void>;
}

/** Serves the session `ctx` starts: takes over what a reload left running, else opens the index as a start does. */
export async function serveSession(options: ServeOptions): Promise<Served> {
	const { sdk, pi, ctx, generation, parked } = options;
	const agentDir = sdk.getAgentDir();
	const scope = sessionScope(sdk, ctx);
	const live = livePi(pi, ctx);
	const notify = (message: string) => ctx.ui.notify(message, "warning");
	let adoptable: HostState | undefined;
	if (parked?.version === HOST_VERSION) adoptable = parked.claim() as HostState;
	else if (parked) {
		notify("subagents: this version can't take over the children the /reload left running. They are interrupted and resume as after an earlier reload.");
		await parked.close("reload");
	}
	const activity: HostActivity = adoptable?.activity ?? new ToolActivity();
	let host!: HostState;
	let looking: ReturnType<typeof setImmediate> | undefined;
	let serving = true;
	let renewFailed = false;
	const team = (): HostTeam => host.team;
	const tools: ToolContext = {
		get team() { return team(); },
		allowed: scope.allowed, fallbackModel: scope.fallbackModel, thinking: scope.thinking, modelTable: modelTable(scope.allowed, scope.thinking),
		guide: scope.guide, replyTimeoutMs: scope.config.replyTimeoutMs, now: Date.now,
		currentGroup: options.currentGroup,
		childTools: (readOnly) => childToolNames(live.activeTools(), readOnly, scope.config.childToolsExclude),
	};
	const launcher = createLauncher({
		sdk, agentDir, cwd: ctx.cwd, generation,
		sessionDir: join(agentDir, "sessions", "subagents", ctx.sessionManager.getSessionId()),
		modelRuntime: runtimeSource(sdk, ctx),
		modelAllowed: (model) => scope.allowed.some((choice) => choice.ref === model),
		claimEdit: (name, target) => team().claimEdit(name, target),
		// Through the host, so a warning from a launch still under way when Pi reloads waits for the next module.
		warn: (message) => host.ports.notify(message, "warning"),
		activity,
		mayEdit: (name, root) => team().mayEdit(name, root),
		bashChanged: (name, paths, root) => team().bashChanged(name, paths, root),
		toolsFor: (record) => {
			const names = allowedTools(childToolNames(live.activeTools(), record.readOnly, scope.config.childToolsExclude), record.tools);
			return {
				tools: names,
				extensionPaths: childExtensionPaths(live.allTools(), names),
				customTools: [
					childMessageTool(tools, record.name),
					...(record.depth < scope.config.maxDepth ? [subagentTool(tools, record.name), stopTool(tools, record.name)] : []),
				],
			};
		},
		instructions: (record) => childInstructions({
			name: record.name, parent: record.parent, readOnly: record.readOnly, canSpawn: record.depth < scope.config.maxDepth,
			...(record.worktree ? { worktree: record.worktree } : {}),
			roster: rosterText(record.name, team().list().map((r) => ({ name: r.name, task: r.task, state: r.state, model: r.model }))),
			...(record.fork ? { conversation: conversationDigest(live.branch(), describeTool) } : {}),
		}),
	});
	const lookForQuiet = () => {
		if (looking || !serving || renewFailed || host.generation === generation) return;
		// After the change that called this has finished: a report is handed to the mail after its record changes.
		looking = setImmediate(() => { looking = undefined; renew(); });
	};
	const ports: HostPorts = {
		send: (message, sendOptions) => pi.sendMessage(message as Parameters<ExtensionAPI["sendMessage"]>[0], sendOptions),
		route: options.route,
		notify: (message, level) => ctx.ui.notify(message, level),
		teamChanged: () => { options.teamChanged(); lookForQuiet(); },
		mailChanged: () => { options.mailChanged(); lookForQuiet(); },
		launcher,
		models: () => scope,
	};
	const scanner = createSessionScanner(sdk.parseSessionEntries, sdk.migrateSessionEntries);
	const open = (handedOver?: { lease: () => void; activity: HostActivity }) => openHost({
		generation, agentDir, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), owner: recoveryOwner(ctx.sessionManager),
		config: scope.config, branch: () => live.branch(), scanner, ports, activity: handedOver?.activity ?? activity,
		...(handedOver ? { lease: handedOver.lease } : {}),
	});
	/** Replaces an adopted host that is quiet with one from this module's code, which reads the index it saved. */
	const renew = () => {
		const old = host;
		if (!serving || renewFailed || old.generation === generation || !old.quiet()) return;
		let next: HostState;
		try { next = open({ lease: old.handOver(), activity: old.activity }); }
		catch (error) {
			// The old host still works and still holds the lease; it serves the rest of the session.
			renewFailed = true;
			notify(`subagents: kept the team from before the /reload: ${(error as Error).message}`);
			return;
		}
		host = next;
		old.retire().catch((error: unknown) => notify(`subagents: letting the team from before the /reload go failed: ${(error as Error).message}`));
		options.teamChanged();
		options.mailChanged();
	};
	let adopted = false;
	if (adoptable) {
		// Set first: binding the ports reports a change, and that looks at the host.
		host = adoptable;
		try {
			adoptable.rebind(ports);
			adopted = true;
		} catch (error) {
			notify(`subagents: could not take over the children the /reload left running (${(error as Error).message}). They are interrupted and resume as after an earlier reload.`);
			await parked!.close("reload");
		}
	}
	if (!adopted) host = open();
	return {
		host: () => host,
		adopted,
		tools,
		lookForQuiet,
		park(session) {
			serving = false;
			if (looking) clearImmediate(looking);
			looking = undefined;
			live.freeze();
			host.park();
			parkHost(session, host, { log: (message) => operationalError(join(agentDir, "subagents", "reload.log"), "subagents", message) });
		},
		async close(reason) {
			serving = false;
			if (looking) clearImmediate(looking);
			looking = undefined;
			await host.close(reason);
		},
	};
}
