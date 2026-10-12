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
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { operationalError } from "../operational-log.ts";
import { allowedTools } from "./allowlist.ts";
import { childExtensionPaths, childToolNames, createLauncher, describeTool } from "./child.ts";
import { loadConfig, readGuide, type SubagentsConfig } from "./config.ts";
import { HOST_VERSION, type HostActivity, type HostPorts, type HostState, type HostTeam, type ModelScope, type ParkedHost } from "./contract.ts";
import type { Route } from "./deliver.ts";
import type { Launcher } from "./types.ts";
import { childInstructions, conversationDigest, rosterText } from "./format.ts";
import { closingHost, parkHost } from "./host.ts";
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

/** Main's tools' context, fixed for the session start but for the team, which is read at each call. */
function mainToolContext(scope: Scope, live: LivePi, team: () => HostTeam, currentGroup: () => string): ToolContext {
	return {
		get team() { return team(); },
		allowed: scope.allowed, fallbackModel: scope.fallbackModel, thinking: scope.thinking, modelTable: modelTable(scope.allowed, scope.thinking),
		guide: scope.guide, replyTimeoutMs: scope.config.replyTimeoutMs, now: Date.now, currentGroup,
		childTools: (readOnly) => childToolNames(live.activeTools(), readOnly, scope.config.childToolsExclude),
	};
}

interface LauncherInputs {
	readonly sdk: Sdk;
	readonly ctx: ExtensionContext;
	readonly generation: number;
	readonly scope: Scope;
	readonly live: LivePi;
	readonly team: () => HostTeam;
	readonly tools: ToolContext;
	readonly activity: HostActivity;
	readonly warn: (message: string) => void;
}

/** Makes children with this module's code: its instructions, its tools for them, its launch. */
function childLauncher(inputs: LauncherInputs): Launcher {
	const { sdk, ctx, scope, live, team, tools } = inputs;
	const agentDir = sdk.getAgentDir();
	return createLauncher({
		sdk, agentDir, cwd: ctx.cwd, generation: inputs.generation,
		sessionDir: join(agentDir, "sessions", "subagents", ctx.sessionManager.getSessionId()),
		modelRuntime: runtimeSource(sdk, ctx),
		modelAllowed: (model) => scope.allowed.some((choice) => choice.ref === model),
		claimEdit: (name, target) => team().claimEdit(name, target),
		warn: inputs.warn,
		activity: inputs.activity,
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
}

/**
 * Where a parked host says what became of it. No module is left to show a
 * notice, and the next start announces interrupted children itself, so this
 * is best effort, as operational-log.ts is.
 */
function reloadLog(agentDir: string): (message: string) => void {
	const file = join(agentDir, "subagents", "reload.log");
	return (message) => {
		try { mkdirSync(dirname(file), { recursive: true }); } catch { /* the append below fails the same way, and quietly */ }
		operationalError(file, "subagents", message);
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
	/** Pi reloads: leaves the host for the next module, or closes it as a reload did before when it can't. */
	park(session: object): Promise<void>;
	close(reason?: string): Promise<void>;
}

/** Serves the session `ctx` starts: takes over what a reload left running, else opens the index as a start does. */
export async function serveSession(options: ServeOptions): Promise<Served> {
	const { parked } = options;
	let closed = false;
	const closeOnce: ParkedHost | undefined = parked && {
		version: parked.version,
		claim: () => parked.claim(),
		close: (reason) => { closed = true; return parked.close(reason); },
	};
	try { return await serve({ ...options, ...(closeOnce ? { parked: closeOnce } : {}) }); }
	catch (error) {
		// Not taken over: its children would run unserved until its timeout. Serving never fails once it adopted the host.
		if (parked && !closed) {
			await parked.close("reload").catch((closeError: unknown) => {
				throw new Error(`${(error as Error).message} Interrupting the children the /reload left running failed too: ${(closeError as Error).message}`);
			});
		}
		throw error;
	}
}

async function serve(options: ServeOptions): Promise<Served> {
	const { sdk, pi, ctx, parked } = options;
	const scope = sessionScope(sdk, ctx);
	const live = livePi(pi, ctx);
	let adoptable: HostState | undefined;
	if (parked?.version === HOST_VERSION) adoptable = parked.claim() as HostState;
	else if (parked) {
		ctx.ui.notify("subagents: this version can't take over the children the /reload left running. They are interrupted and resume as after an earlier reload.", "warning");
		await parked.close("reload");
	}
	const service = new Service(options, scope, live, adoptable?.activity ?? new ToolActivity());
	await service.start(adoptable);
	return service;
}

interface HandedOver {
	readonly lease: () => void;
	readonly activity: HostActivity;
}

/** One module's service of a session: the host it serves now, its ports and launcher, and how it hands the host on. */
class Service implements Served {
	readonly tools: ToolContext;
	private current!: HostState;
	private took = false;
	private looking: ReturnType<typeof setImmediate> | undefined;
	private serving = true;
	private renewFailed = false;
	private readonly options: ServeOptions;
	private readonly live: LivePi;
	private readonly ports: HostPorts;
	private readonly open: (handedOver?: HandedOver) => HostState;

	constructor(options: ServeOptions, scope: Scope, live: LivePi, activity: HostActivity) {
		const { sdk, pi, ctx, generation } = options;
		this.options = options;
		this.live = live;
		const team = (): HostTeam => this.current.team;
		this.tools = mainToolContext(scope, live, team, options.currentGroup);
		this.ports = {
			send: (message, sendOptions) => pi.sendMessage(message as Parameters<ExtensionAPI["sendMessage"]>[0], sendOptions),
			route: options.route,
			notify: (message, level) => ctx.ui.notify(message, level),
			teamChanged: () => { options.teamChanged(); this.lookForQuiet(); },
			mailChanged: () => { options.mailChanged(); this.lookForQuiet(); },
			// Warnings go through the host, so one from a launch still under way when Pi reloads waits for the next module.
			launcher: childLauncher({ sdk, ctx, generation, scope, live, team, tools: this.tools, activity, warn: (message) => this.current.ports.notify(message, "warning") }),
			models: () => scope,
		};
		const scanner = createSessionScanner(sdk.parseSessionEntries, sdk.migrateSessionEntries);
		this.open = (handedOver) => openHost({
			generation, agentDir: sdk.getAgentDir(), cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), owner: recoveryOwner(ctx.sessionManager),
			config: scope.config, branch: () => live.branch(), scanner, ports: this.ports, activity: handedOver?.activity ?? activity,
			...(handedOver ? { lease: handedOver.lease } : {}),
		});
	}

	get adopted(): boolean {
		return this.took;
	}

	host(): HostState {
		return this.current;
	}

	/** Takes over the host a reload left, else opens the index as a start does. */
	async start(adoptable: HostState | undefined): Promise<void> {
		if (adoptable) {
			// Set first: binding the ports reports a change, and that looks at the host.
			this.current = adoptable;
			try {
				adoptable.rebind(this.ports);
				this.took = true;
				return;
			} catch (error) {
				this.options.ctx.ui.notify(`subagents: could not take over the children the /reload left running (${(error as Error).message}). They are interrupted and resume as after an earlier reload.`, "warning");
				await this.options.parked!.close("reload");
			}
		}
		// A host an earlier reload left that timed out may still be letting its children go, and holds the lease until then.
		await closingHost(this.options.ctx.sessionManager);
		this.current = this.open();
	}

	lookForQuiet(): void {
		if (this.looking || !this.serving || this.renewFailed || this.current.generation === this.options.generation) return;
		// After the change that called this has finished: a report is handed to the mail after its record changes.
		this.looking = setImmediate(() => { this.looking = undefined; this.renew(); });
	}

	async park(session: object): Promise<void> {
		this.stop();
		const log = reloadLog(this.options.sdk.getAgentDir());
		try {
			this.current.park();
			this.live.freeze();
			parkHost(session, this.current, { log });
		} catch (error) {
			// Not on the shelf, so no module takes it over and no timeout closes it: close it now, which lets the lease
			// go. The next start announces and resumes the interrupted children.
			log(`could not keep the subagents through a /reload (${(error as Error).message}), so they were interrupted`);
			await this.current.close("reload");
		}
	}

	async close(reason?: string): Promise<void> {
		this.stop();
		await this.current.close(reason);
	}

	/** Replaces an adopted host that is quiet with one from this module's code, which reads the index it saved. */
	private renew(): void {
		const old = this.current;
		if (!this.serving || this.renewFailed || old.generation === this.options.generation || !old.quiet()) return;
		let next: HostState;
		try { next = this.open({ lease: old.handOver(), activity: old.activity }); }
		catch (error) {
			// The old host still works and still holds the lease; it serves the rest of the session.
			this.renewFailed = true;
			this.options.ctx.ui.notify(`subagents: kept the team from before the /reload: ${(error as Error).message}`, "warning");
			return;
		}
		this.current = next;
		// Through the host, whose ports follow the module that serves it: this `ctx` may be gone by the time it fails.
		old.retire().catch((error: unknown) => next.ports.notify(`subagents: letting the team from before the /reload go failed: ${(error as Error).message}`, "warning"));
		this.options.teamChanged();
		this.options.mailChanged();
	}

	private stop(): void {
		this.serving = false;
		if (this.looking) clearImmediate(this.looking);
		this.looking = undefined;
	}
}
