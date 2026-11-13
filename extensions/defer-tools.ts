/**
 * Defer Tools. Requests to Meridian mark the tools named in `deferTools.names` `defer_loading: true`,
 * so their declarations leave the prompt and the model loads one through tool search when it needs
 * it (Meridian hands the flag to Claude Code's ToolSearch). Other providers get Pi's payload as is.
 * Off until names are given: see RECOMMENDED_DEFER_TOOLS for why.
 *
 * A changed tool list rewrites the whole prompt cache, so each session freezes the list at its
 * start: a later edit of pi-extras.json, or a `/reload`, reaches only new sessions. The output
 * depends only on the payload and that list, so a warm request repeats the real one byte for byte.
 * Load it before Cache Compaction: that extension keeps the payload it sees to replay as a warm.
 *
 * Children do not load it: a child loads only the extensions that own its tools, and most of the
 * recommended list is excluded from children anyway (lib/subagents/child.ts CHILD_TOOL_EXCLUDE).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSection } from "../lib/extras-config.ts";

/**
 * Tools used in under 5% of sessions on two machines over 14 days: a list to paste into
 * `deferTools.names`. Not the default: with any tool deferred, Meridian lifts its single-turn cap
 * and every tool-call turn pays an extra hidden model turn, which costs more than deferral saves.
 */
export const RECOMMENDED_DEFER_TOOLS: readonly string[] = Object.freeze([
	"agent_send", "list_peers", "agent_request", "intercom", "artifact_feedback", "artifact_check", "gov_search",
	"stop_subagent", "get_goal", "create_goal", "propose_goal_draft", "complete_goal", "update_goal_progress",
]);
export const DEFAULT_MERIDIAN_BASE_URLS: readonly string[] = Object.freeze(["http://127.0.0.1:3456", "http://localhost:3456"]);
/** The model's own ways to work; a deferred one would cost a search before every use. */
const NEVER_DEFERRED: ReadonlySet<string> = new Set(["read", "bash", "edit", "write", "codemode", "powershell"]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MERIDIAN_HEADER = "x-meridian-agent";
const VIRTUAL_API = "pi-virtual";
const KILL_SWITCH = "PI_EXTRAS_DEFER_TOOLS";
const STORE_SLOT = Symbol.for("pi-extras.defer-tools.sessions");

export interface DeferConfig {
	readonly names: readonly string[];
	readonly meridianBaseUrls: readonly string[];
}

const neverDeferred = (name: string) => NEVER_DEFERRED.has(name.toLowerCase());
const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

export function parseDeferConfig(section: Record<string, unknown>): DeferConfig {
	// Off unless the owner names the tools (see RECOMMENDED_DEFER_TOOLS).
	const raw: readonly unknown[] = Array.isArray(section.names) ? section.names : [];
	const names = raw.filter((name): name is string => typeof name === "string").map((name) => name.trim())
		.filter((name) => TOOL_NAME.test(name) && !neverDeferred(name));
	const urls = Array.isArray(section.meridianBaseUrls)
		? section.meridianBaseUrls.filter((url): url is string => typeof url === "string" && /^https?:\/\/\S+$/i.test(url.trim())).map(normalizeUrl)
		: DEFAULT_MERIDIAN_BASE_URLS;
	return { names: [...new Set(names)], meridianBaseUrls: [...new Set(urls)] };
}

/** The config as the session will keep it: a copy that nothing can change, off with the kill switch. */
export function freezeDeferConfig(section: Record<string, unknown>, env: Record<string, string | undefined>): DeferConfig {
	const parsed = parseDeferConfig(section);
	const names = env[KILL_SWITCH]?.trim() === "0" ? [] : parsed.names;
	return Object.freeze({ names: Object.freeze([...names]), meridianBaseUrls: Object.freeze([...parsed.meridianBaseUrls]) });
}

interface ModelLike {
	readonly provider?: string;
	readonly id?: string;
	readonly api?: string;
	readonly baseUrl?: string;
	readonly headers?: Record<string, string> | undefined;
}

function hasMeridianHeader(headers: unknown): boolean {
	if (!headers || typeof headers !== "object") return false;
	// A null value is a header that a hook deleted.
	return Object.entries(headers).some(([key, value]) => key.toLowerCase() === MERIDIAN_HEADER && value !== null && value !== undefined);
}

/** Meridian speaks the Anthropic Messages API, at a known base URL or with its agent header. */
export function isMeridianModel(model: ModelLike | undefined, meridianBaseUrls: readonly string[]): boolean {
	if (!model || model.api !== "anthropic-messages") return false;
	if (hasMeridianHeader(model.headers)) return true;
	return typeof model.baseUrl === "string" && meridianBaseUrls.includes(normalizeUrl(model.baseUrl));
}

const modelKey = (model: ModelLike & { provider?: string }) => `${model.provider ?? ""}/${model.id ?? ""}`;

interface RequestContext {
	readonly model?: ModelLike | undefined;
	readonly modelRegistry?: { getAll?: () => readonly ModelLike[] } | undefined;
}

/**
 * Pi gives the handler no request model, only the selection (`ctx.model`). The payload names the
 * model it is for, so a request for another model (a summary, a routed request) is left alone. A
 * virtual selection routes each request; then every registry model with the payload's id must be
 * a Meridian model, which gives the same answer on the first request as on later ones.
 * `headerSeen` holds the models whose request headers had `x-meridian-agent`: Pi resolves provider
 * headers at request time, so `ctx.model.headers` does not show them.
 */
export function requestGoesToMeridian(ctx: RequestContext, payload: unknown, meridianBaseUrls: readonly string[], headerSeen: ReadonlySet<string> = new Set()): boolean {
	const id = payload && typeof payload === "object" ? (payload as { model?: unknown }).model : undefined;
	const selected = ctx.model;
	if (typeof id !== "string" || !selected) return false;
	if (selected.api !== VIRTUAL_API) {
		return selected.id === id && (isMeridianModel(selected, meridianBaseUrls) || (selected.api === "anthropic-messages" && headerSeen.has(modelKey(selected))));
	}
	const candidates = (ctx.modelRegistry?.getAll?.() ?? []).filter((model) => model.id === id && model.api !== VIRTUAL_API);
	return candidates.length > 0 && candidates.every((model) => isMeridianModel(model, meridianBaseUrls));
}

type ToolLike = Record<string, unknown> & { name?: unknown };

function deferrable(tool: unknown, names: ReadonlySet<string>): tool is ToolLike {
	if (!tool || typeof tool !== "object") return false;
	const { name } = tool as ToolLike;
	return typeof name === "string" && names.has(name) && !neverDeferred(name)
		// A value someone set stays. Anthropic rejects cache_control on a deferred tool, and the breakpoint must not move.
		&& !Object.hasOwn(tool, "defer_loading") && !Object.hasOwn(tool, "cache_control");
}

/**
 * The payload with each listed tool marked `defer_loading: true`, or undefined to keep Pi's payload:
 * when nothing matches, or when no tool would stay loaded (Anthropic needs one). Tool order and key
 * order stay; unchanged tools are the same objects; the input is not changed.
 */
export function deferPayload(payload: unknown, names: readonly string[]): unknown {
	if (!payload || typeof payload !== "object" || names.length === 0) return undefined;
	const tools = (payload as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return undefined;
	const wanted = new Set(names);
	const marks = tools.map((tool) => deferrable(tool, wanted));
	if (!marks.includes(true)) return undefined;
	const stillLoaded = tools.some((tool, index) => !marks[index] && (tool as { defer_loading?: unknown } | null)?.defer_loading !== true);
	if (!stillLoaded) return undefined;
	return { ...payload, tools: tools.map((tool, index) => marks[index] ? { ...(tool as ToolLike), defer_loading: true } : tool) };
}

type SessionStore = Map<string, DeferConfig>;

/** One record per process, so a `/reload` copy finds the list each session froze. */
function processStore(): SessionStore {
	const slot = globalThis as { [STORE_SLOT]?: SessionStore };
	return (slot[STORE_SLOT] ??= new Map());
}

export interface DeferToolsOptions {
	/** The `deferTools` section; read from pi-extras.json when omitted. */
	readonly config?: Record<string, unknown>;
	readonly env?: Record<string, string | undefined>;
	/** Each session's frozen config; the process-wide one when omitted. */
	readonly store?: SessionStore;
}

interface SessionContext extends RequestContext {
	readonly sessionManager?: { getSessionId?: () => string };
}

export default function deferTools(pi: ExtensionAPI, options: DeferToolsOptions = {}): void {
	const env = options.env ?? process.env;
	// The kill switch is the process's own; no earlier copy in it can have run with deferral.
	if (env[KILL_SWITCH]?.trim() === "0") return;
	const store = options.store ?? processStore();
	// Read once per session, at its start (or its first request), and never again for it.
	const frozenFor = (ctx: SessionContext): DeferConfig => {
		const id = ctx.sessionManager?.getSessionId?.() ?? "";
		let config = store.get(id);
		if (!config) { config = freezeDeferConfig(options.config ?? readSection("deferTools"), env); store.set(id, config); }
		return config;
	};
	// Pi assembles a request's headers before its payload, so the first request already counts.
	const headerSeen = new Set<string>();
	pi.on("session_start", (_event, ctx) => { frozenFor(ctx as SessionContext); });
	pi.on("before_provider_headers", (event, ctx) => {
		const model = (ctx as RequestContext).model;
		if (model && model.api !== VIRTUAL_API && hasMeridianHeader(event.headers)) headerSeen.add(modelKey(model));
	});
	pi.on("before_provider_request", (event, ctx) => {
		const config = frozenFor(ctx as SessionContext);
		if (config.names.length === 0 || !requestGoesToMeridian(ctx as RequestContext, event.payload, config.meridianBaseUrls, headerSeen)) return undefined;
		return deferPayload(event.payload, config.names);
	});
}
