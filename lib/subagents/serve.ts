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
import { setTimeout as sleep } from "node:timers/promises";
import { operationalError } from "../operational-log.ts";
import { allowedTools } from "./allowlist.ts";
import { childExtensionPaths, childToolNames, createLauncher, describeTool } from "./child.ts";
import { loadConfig, readGuide, type SubagentsConfig } from "./config.ts";
import { HOST_VERSION, type HostActivity, type HostPorts, type HostState, type HostTeam, type ModelScope, type ParkedHost } from "./contract.ts";
import type { Route } from "./contract.ts";
import type { Launcher } from "./types.ts";
import { childInstructions, conversationDigest, entriesUntil, rosterText } from "./format.ts";
import { hiddenFrom } from "./hidden.ts";
import { readOnlyShellProblem } from "./sandbox.ts";
import { liveWindowReading } from "./windows.ts";
import { closingHost, parkHost } from "./host.ts";
import { openHost } from "./host-state.ts";
import { type ModelLike, modelTable, refOf, resolveModel, type ThinkingSettings } from "./models.ts";
import { effectiveScoped, liveModelScope, reloadOverride, type ScopedLike, type ScopeOverride, scopeHint, startedWithModels } from "./scope.ts";
import { recoveryOwner } from "./recovery.ts";
import { createSessionScanner } from "./session-scan.ts";
import { ToolActivity } from "./tool-activity.ts";
import { childClockTool, childMessageTool, stopTool, subagentTool, type ToolContext } from "./tools.ts";

type Sdk = typeof import("@earendil-works/pi-coding-agent");
type ToolInfos = ReturnType<ExtensionAPI["getAllTools"]>;

/**
 * What a session start reads. The guide stays until the next start, as it goes
 * into a tool description. The models are read at each call (scope.ts), since
 * /scoped-models changes them during the session.
 */
export interface Scope {
	readonly models: () => ModelScope;
	/** Why a model Pi knows is not in scope, and the fix; undefined when there is nothing to add. */
	readonly hint: (query: string) => Promise<string | undefined>;
	readonly config: SubagentsConfig;
	readonly thinking: ThinkingSettings;
	readonly guide: string;
	/** Main's decision on its project's `.pi/`, which children in main's directory follow; unset on a Pi that has none. */
	readonly projectTrusted: boolean | undefined;
}

/** Main's decision on its project's `.pi/` (Pi's `ctx.isProjectTrusted()`); undefined on a Pi that has none. */
export function mainTrust(ctx: ExtensionContext): boolean | undefined {
	const trust = (ctx as Partial<Pick<ExtensionContext, "isProjectTrusted">>).isProjectTrusted;
	return typeof trust === "function" ? trust.call(ctx) : undefined;
}

/**
 * Main's settings as Pi reads them for main: the project's `.pi/settings.json`
 * only when main trusts the project. Pi's default would trust it, so an
 * untrusted repository could set what main refused.
 */
function mainSettings(sdk: Sdk, cwd: string, agentDir: string, trusted: boolean | undefined): unknown {
	return sdk.SettingsManager.create(cwd, agentDir, trusted === undefined ? {} : { projectTrusted: trusted });
}

export function thinkingSettings(sdk: Sdk, cwd: string, agentDir: string, trusted: boolean | undefined): ThinkingSettings {
	try {
		const settings = mainSettings(sdk, cwd, agentDir, trusted) as {
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

/** How main's chat is drawn, so an agent's chat in the inspector matches it. */
export function chatSettings(sdk: Sdk, cwd: string, agentDir: string, trusted: boolean | undefined): { hideThinking?: boolean; outputPad?: number } {
	try {
		const settings = mainSettings(sdk, cwd, agentDir, trusted) as { getHideThinkingBlock?: () => boolean; getOutputPad?: () => number };
		return { hideThinking: settings.getHideThinkingBlock?.(), outputPad: settings.getOutputPad?.() };
	} catch {
		return {};
	}
}

/** `enabledModels` in main's settings now; undefined when unset or unreadable. */
function enabledModels(sdk: Sdk, cwd: string, agentDir: string, trusted: boolean | undefined): string[] | undefined {
	try {
		const patterns = (mainSettings(sdk, cwd, agentDir, trusted) as { getEnabledModels?: () => string[] | undefined }).getEnabledModels?.();
		return Array.isArray(patterns) ? patterns : undefined;
	} catch {
		return undefined;
	}
}

type ResolveScope = (patterns: string[], runtime: unknown, options?: { signal?: AbortSignal }) => Promise<{ scopedModels: ScopedLike[] }>;

/** Pi's own resolver of scope patterns (globs, `:level` suffixes, fuzzy ids); absent on a Pi without it. */
function scopeResolver(sdk: Sdk): ResolveScope | undefined {
	const resolve = (sdk as unknown as { resolveModelScopeWithDiagnostics?: ResolveScope }).resolveModelScopeWithDiagnostics;
	return typeof resolve === "function" ? resolve : undefined;
}

const RESOLVE_TIMEOUT_MS = 15_000;
const AVAILABLE_TRIES = 3;
const AVAILABLE_RETRY_MS = 200;

/**
 * The models with credentials, as Pi's start resolves `enabledModels` against.
 * During a /reload Pi refreshes the catalog too, and a refresh that a newer one
 * replaces returns the list from before it, which can be empty; so an empty
 * list is read again a few times.
 */
async function availableModels(runtime: ModelRuntime, signal: AbortSignal): Promise<readonly ModelLike[]> {
	let available: readonly ModelLike[] = [];
	for (let attempt = 0; attempt < AVAILABLE_TRIES && available.length === 0; attempt++) {
		// Each read starts a refresh pass, so a pause lets Pi's own pass end first.
		if (attempt > 0) await sleep(AVAILABLE_RETRY_MS, undefined, { signal });
		available = await (runtime as unknown as { getAvailable(provider: undefined, options: { signal: AbortSignal }): Promise<readonly ModelLike[]> }).getAvailable(undefined, { signal });
	}
	return available;
}

/** On a /reload, the list `enabledModels` resolve to when they changed, since Pi keeps the session's old list (scope.ts). */
async function settingsOverride(sdk: Sdk, ctx: ExtensionContext, reason: string | undefined): Promise<ScopeOverride | undefined> {
	const resolve = scopeResolver(sdk);
	if (!resolve || reason === undefined) return undefined;
	const runtime = runtimeSource(sdk, ctx);
	// Never fails the start: it may come after the claim of a host a /reload left running.
	try {
		const { override, warning } = await reloadOverride({
			sessionId: ctx.sessionManager.getSessionId(), reload: reason === "reload", live: ctx.scopedModels ?? [],
			patterns: enabledModels(sdk, ctx.cwd, sdk.getAgentDir(), mainTrust(ctx)), cliModels: startedWithModels(),
			resolve: async (patterns) => {
				const available = await availableModels(await runtime(), AbortSignal.timeout(RESOLVE_TIMEOUT_MS));
				return (await resolve([...patterns], { getAvailable: async () => available })).scopedModels;
			},
		});
		if (warning) ctx.ui.notify(warning, "warning");
		return override;
	} catch (error) {
		try { ctx.ui.notify(`subagents: could not read enabledModels (${(error as Error).message}). Subagents use the session's model scope.`, "warning"); }
		catch { /* a notice that fails must not fail the start after the claim */ }
		return undefined;
	}
}

/** Every model Pi knows; empty when the registry can't list them or `ctx` was replaced. */
function knownModels(ctx: ExtensionContext): ModelLike[] {
	try { return (ctx.modelRegistry as { getAll?: () => ModelLike[] }).getAll?.() ?? []; }
	catch { return []; }
}

/** The references `enabledModels` resolve to among `known`, with Pi's resolver when it has one, else by exact reference or id. */
async function settingsRefs(sdk: Sdk, patterns: readonly string[], known: readonly ModelLike[]): Promise<Set<string>> {
	const resolve = scopeResolver(sdk);
	if (resolve) {
		try { return new Set((await resolve([...patterns], { getAvailable: async () => known })).scopedModels.map((entry) => refOf(entry.model))); }
		catch { /* the exact match below still finds the common case */ }
	}
	const wanted = new Set(patterns.map((pattern) => pattern.replace(/:[a-z]+$/, "").toLowerCase()));
	return new Set(known.filter((model) => wanted.has(refOf(model).toLowerCase()) || wanted.has(model.id.toLowerCase())).map(refOf));
}

/** A `subagents.defaultModel` out of scope at the start is told once; calls then use the parent's model. */
function warnDefaultModel(scope: Scope, ctx: ExtensionContext): void {
	const configured = scope.config.defaultModel ? resolveModel(scope.config.defaultModel, scope.models().allowed) : null;
	if (configured && !configured.ok) ctx.ui.notify(`subagents.defaultModel: ${configured.error}`, "warning");
}

export function sessionScope(sdk: Sdk, ctx: ExtensionContext, override: () => ScopeOverride | undefined = () => undefined): Scope {
	const agentDir = sdk.getAgentDir();
	const config = loadConfig();
	const projectTrusted = mainTrust(ctx);
	const models = liveModelScope({ read: () => ({ scoped: ctx.scopedModels ?? [], parent: ctx.model }), defaultModel: config.defaultModel ?? null, override });
	// Read once now, so a `ctx` Pi replaces later still gives the last scope read.
	models();
	const cliModels = startedWithModels();
	const hint = async (query: string) => {
		const known = knownModels(ctx);
		if (known.length === 0) return undefined;
		const patterns = cliModels ? [] : enabledModels(sdk, ctx.cwd, agentDir, projectTrusted) ?? [];
		const scopeEmpty = effectiveScoped(ctx.scopedModels ?? [], override()).length === 0;
		return scopeHint(query, { known, settingsRefs: await settingsRefs(sdk, patterns, known), cliModels, scopeEmpty });
	};
	return { models, hint, config, thinking: thinkingSettings(sdk, ctx.cwd, agentDir, projectTrusted), guide: readGuide(agentDir, ctx.cwd, projectTrusted).text, projectTrusted };
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

/**
 * Main's tools' context, fixed for the session start but for the team and the
 * models, which are read at each call through the host, so a child from before
 * a /reload sees the scope of the module that serves the session now.
 */
function mainToolContext(scope: Scope, live: LivePi, team: () => HostTeam, models: () => ModelScope, currentGroup: () => string): ToolContext {
	return {
		get team() { return team(); },
		get allowed() { return models().allowed; },
		get fallbackModel() { return models().fallbackModel; },
		get modelTable() { return modelTable(models().allowed, scope.thinking); },
		thinking: scope.thinking, scopeHint: scope.hint,
		guide: scope.guide, replyTimeoutMs: scope.config.replyTimeoutMs, now: Date.now, currentGroup,
		childTools: (readOnly, shell) => childToolNames(live.activeTools(), readOnly, scope.config.childToolsExclude, shell),
		shellProblem: readOnlyShellProblem,
		windows: (model) => liveWindowReading(model),
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
		// Read at this start, a takeover's included: the module that serves the session launches with its own `ctx`'s decision.
		...(scope.projectTrusted !== undefined ? { projectTrusted: scope.projectTrusted } : {}),
		sessionDir: join(agentDir, "sessions", "subagents", ctx.sessionManager.getSessionId()),
		modelRuntime: runtimeSource(sdk, ctx),
		modelAllowed: (model) => scope.models().allowed.some((choice) => choice.ref === model),
		claimEdit: (name, target) => team().claimEdit(name, target),
		warn: inputs.warn,
		activity: inputs.activity,
		mayEdit: (name, root) => team().mayEdit(name, root),
		bashChanged: (name, paths, root) => team().bashChanged(name, paths, root),
		...(scope.config.hideSessions ? { hidden: hiddenFrom(join(agentDir, "sessions", "subagents"), ctx.sessionManager.getSessionFile?.(), team) } : {}),
		toolsFor: (record) => {
			const names = allowedTools(childToolNames(live.activeTools(), record.readOnly, scope.config.childToolsExclude, record.readOnlyShell === true), record.tools);
			return {
				tools: names,
				extensionPaths: childExtensionPaths(live.allTools(), names),
				customTools: [
					childMessageTool(tools, record.name),
					childClockTool(tools, record.name),
					...(record.depth < scope.config.maxDepth ? [subagentTool(tools, record.name), stopTool(tools, record.name)] : []),
				],
			};
		},
		instructions: (record) => childInstructions({
			name: record.name, parent: record.parent, readOnly: record.readOnly, ...(record.readOnlyShell ? { readOnlyShell: true } : {}), canSpawn: record.depth < scope.config.maxDepth,
			...(record.worktree ? { worktree: record.worktree } : {}),
			budget: { ...(record.maxMinutes !== undefined ? { minutes: record.maxMinutes } : {}), ...(record.maxCost !== undefined ? { cost: record.maxCost } : {}) },
			...(record.maxWindowPct !== undefined ? { windowPct: record.maxWindowPct } : {}),
			roster: rosterText(record.name, team().list().map((r) => ({ name: r.name, task: r.task, state: r.state, model: r.model }))),
			...(record.fork ? { conversation: conversationDigest(entriesUntil(live.branch(), record.createdAt), describeTool) } : {}),
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
	/** How long a start waits for a host from before a /reload that is still closing; host.ts sets the default. */
	readonly closeWaitMs?: number;
	/** Pi's `session_start` reason; a "reload" resolves `enabledModels` again when they changed (scope.ts). */
	readonly reason?: string;
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
	let override: ScopeOverride | undefined;
	const scope = sessionScope(sdk, ctx, () => override);
	const live = livePi(pi, ctx);
	let adoptable: HostState | undefined;
	if (parked?.version === HOST_VERSION) adoptable = parked.claim() as HostState;
	else if (parked) {
		ctx.ui.notify("subagents: this version can't take over the children the /reload left running. They are interrupted and resume as after an earlier reload.", "warning");
		await parked.close("reload");
	}
	// After the claim: resolving the models can take seconds, and an unclaimed host times out.
	override = await settingsOverride(sdk, ctx, options.reason);
	warnDefaultModel(scope, ctx);
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
		this.tools = mainToolContext(scope, live, team, () => this.current.ports.models(), options.currentGroup);
		this.ports = {
			send: (message, sendOptions) => pi.sendMessage(message as Parameters<ExtensionAPI["sendMessage"]>[0], sendOptions),
			route: options.route,
			notify: (message, level) => ctx.ui.notify(message, level),
			teamChanged: () => { options.teamChanged(); this.lookForQuiet(); },
			mailChanged: () => { options.mailChanged(); this.lookForQuiet(); },
			// Warnings go through the host, so one from a launch still under way when Pi reloads waits for the next module.
			launcher: childLauncher({ sdk, ctx, generation, scope, live, team, tools: this.tools, activity, warn: (message) => this.current.ports.notify(message, "warning") }),
			models: scope.models,
		};
		const scanner = createSessionScanner(sdk.parseSessionEntries, sdk.migrateSessionEntries);
		this.open = (handedOver) => openHost({
			generation, agentDir: sdk.getAgentDir(), cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), owner: recoveryOwner(ctx.sessionManager),
			config: scope.config, thinking: scope.thinking, branch: () => live.branch(), scanner, ports: this.ports, activity: handedOver?.activity ?? activity,
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
		const closed = await closingHost(this.options.ctx.sessionManager, this.options.closeWaitMs);
		try { this.current = this.open(); }
		catch (error) {
			if (!closed) throw new Error("The subagents from before the /reload are still closing. Run /reload again.");
			throw error;
		}
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
			this.current.park(log);
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
