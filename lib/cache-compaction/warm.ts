import { isMeridian, type ModelIdentity } from "./core.ts";

export { payloadThinkingBudget } from "./core.ts";

/**
 * Cache warming while the session waits for an announced wake: the pure parts
 * (config, lifetime, schedule, economics, the wake set). The extension owns the timers.
 */

/** Another extension (or project) says that something will wake this session later. */
export const WAKE_PENDING_EVENT = "pi-extras:wake-pending";
export interface WakePending { readonly sessionId: string; readonly key: string; readonly pending: boolean }
export { CACHE_WARM_ENTRY } from "../cache-warm-entry.ts";
/**
 * Meridian ignores max_tokens, so only the instruction keeps the reply short.
 * The probe through Meridian measured 4 output tokens with this text.
 */
export const WARM_INSTRUCTION = "Cache refresh only. Reply with the single word ok. Do not use tools.";
/** A cap for providers that honor it; the instruction does the real work. */
export const WARM_MAX_TOKENS = 16;
/** The written tail of one warm (the instruction and its reply), measured at about 1k tokens. */
const WARM_TAIL_TOKENS = 1000;
const LONG_TTL_MS = 3_600_000;
const SHORT_TTL_MS = 300_000;
const MAX_HOURS_LIMIT = 48;
const RETRY_STEP_MS = 30_000;

export interface WarmConfig {
	readonly enabled: boolean;
	readonly maxHours: number;
	readonly minTokens: number;
	readonly apis: readonly string[];
	readonly formTools: readonly string[];
}
export const DEFAULT_WARM: WarmConfig = { enabled: true, maxHours: 8, minTokens: 20000, apis: ["anthropic-messages"], formTools: ["artifact_ask"] };

type RecordValue = Record<string, unknown>;
const object = (v: unknown): v is RecordValue => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, fallback: readonly string[]): readonly string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : fallback;

export function loadWarmConfig(section: unknown): WarmConfig {
	const s = object(section) ? section : {};
	const hours = s.maxHours;
	const tokens = s.minTokens;
	return {
		enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_WARM.enabled,
		maxHours: typeof hours === "number" && Number.isFinite(hours) && hours > 0 && hours <= MAX_HOURS_LIMIT ? hours : DEFAULT_WARM.maxHours,
		minTokens: typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : DEFAULT_WARM.minTokens,
		apis: strings(s.apis, DEFAULT_WARM.apis),
		formTools: strings(s.formTools, DEFAULT_WARM.formTools),
	};
}

function hasLongTtl(value: unknown, depth = 0): boolean {
	if (depth > 8) return false;
	if (Array.isArray(value)) return value.some((item) => hasLongTtl(item, depth + 1));
	if (!object(value)) return false;
	if (object(value.cache_control) && value.cache_control.ttl === "1h") return true;
	return Object.entries(value).some(([name, item]) => name !== "cache_control" && typeof item === "object" && hasLongTtl(item, depth + 1));
}

/** The request says what it asked for; Meridian's SDK writes one-hour entries whatever the payload says. */
export function cacheLifetimeMs(payload: unknown, model: Pick<ModelIdentity, "api" | "baseUrl">): number {
	return hasLongTtl(payload) || isMeridian(model) ? LONG_TTL_MS : SHORT_TTL_MS;
}

/** Pi's getCacheWarmingDelayMs: 90% of the lifetime, at least ten seconds before it ends. */
export function warmDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * The next try for a warm that had to wait, or undefined when it would come after
 * half the margin past its due time, where Pi also counts a refresh as too late.
 */
export function retryAt(now: number, dueAt: number, ttlMs: number, stepMs = RETRY_STEP_MS): number | undefined {
	const delay = warmDelayMs(ttlMs);
	if (delay === undefined) return undefined;
	const next = now + stepMs;
	return next <= dueAt + Math.floor((ttlMs - delay) / 2) ? next : undefined;
}

/** Dollars per million tokens, as in a Pi model's `cost`. */
export interface Prices { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
export function warmCostEstimate(promptTokens: number, cost: Prices): number {
	return (promptTokens * cost.cacheRead + WARM_TAIL_TOKENS * cost.cacheWrite + WARM_MAX_TOKENS * cost.output) / 1e6;
}
export function missCost(promptTokens: number, cost: Prices): number {
	return Math.max(0, promptTokens * ((cost.cacheWrite > 0 ? cost.cacheWrite : cost.input) - cost.cacheRead) / 1e6);
}

export interface WarmCheck {
	readonly promptTokens: number; readonly cost: Prices; readonly spent: number;
	readonly ttlMs: number; readonly maxHours: number; readonly minTokens: number;
	/** The last real request, the warm's planned time and now (ms). */
	readonly realAt: number; readonly dueAt: number; readonly now: number;
	/** The cost of the last warm, when one ran: a better guess for the next. */
	readonly lastWarmCost?: number;
}
/** Why the next warm must not go out, or undefined when it may. */
export function warmStop(c: WarmCheck): string | undefined {
	if (c.promptTokens < c.minTokens) return "small-context";
	if (c.now - c.realAt >= c.maxHours * 3_600_000) return "max-hours";
	const delay = warmDelayMs(c.ttlMs);
	// A timer can fire late after sleep; past half the margin the refresh is likely a full write.
	if (delay === undefined || c.now > c.dueAt + Math.floor((c.ttlMs - delay) / 2)) return "deadline-missed";
	const miss = missCost(c.promptTokens, c.cost);
	if (!(miss > 0)) return "no-prices";
	const next = Math.max(warmCostEstimate(c.promptTokens, c.cost), c.lastWarmCost ?? 0);
	if (c.spent + next >= miss) return "break-even";
	return undefined;
}

export class WakeSet {
	readonly #keys = new Set<string>();
	get size(): number { return this.#keys.size; }
	set(key: string, pending: boolean): void { if (pending) this.#keys.add(key); else this.#keys.delete(key); }
	clearPrefix(prefix: string): void { for (const key of [...this.#keys]) if (key.startsWith(prefix)) this.#keys.delete(key); }
	/** A user prompt answers or replaces every open form. */
	clearForms(): void { this.clearPrefix(ARTIFACT_PREFIX); }
	/**
	 * The answer to one form. With two forms open, a feedback message names the one it
	 * answers, so only that wake goes; a message that names none of them clears them all.
	 */
	answer(ids: readonly string[]): void {
		const keys = namedWakes(ids, (key) => this.#keys.has(key));
		if (keys.length === 0) return this.clearForms();
		for (const key of keys) this.#keys.delete(key);
	}
	clear(): void { this.#keys.clear(); }
}

export function readWakePending(value: unknown): WakePending | undefined {
	if (!object(value)) return undefined;
	const { sessionId, key, pending } = value;
	return typeof sessionId === "string" && typeof key === "string" && key.length > 0 && typeof pending === "boolean" ? { sessionId, key, pending } : undefined;
}

/** MCP adapters prefix a server's tools (mcp__server__name); the configured name is the last part. */
const toolMatches = (tools: readonly string[], name: string) => tools.some((tool) => name === tool || name.endsWith(`__${tool}`));
/** A form or page that sends feedback back to the session, unless the call opted out of watching. */
export function artifactWakes(tools: readonly string[], name: string, args: unknown, isError: boolean): boolean {
	return !isError && toolMatches(tools, name) && !(object(args) && args.watch === false);
}

/** The custom type of the message the artifact extension sends with an answer or a comment. */
export const ARTIFACT_FEEDBACK = "artifact-feedback";
const ARTIFACT_PREFIX = "artifact:";

/** The wake keys for the ids that a set already holds; empty means that it holds none of them. */
function namedWakes(ids: readonly string[], has: (key: string) => boolean): string[] {
	return ids.map((id) => `${ARTIFACT_PREFIX}${id}`).filter(has);
}

const idOf = (value: unknown): string | undefined => (object(value) && typeof value.id === "string" && value.id.length > 0 ? value.id : undefined);

/** The id that the artifact extension gave the form (or page) of a call. */
function artifactId(details: unknown): string | undefined {
	if (!object(details)) return undefined;
	const form = idOf(details.form);
	if (form) return form;
	for (const page of Array.isArray(details.pages) ? details.pages : []) {
		const id = idOf(page);
		if (id) return id;
	}
	return undefined;
}

/**
 * The wake key of an artifact tool result: the form's id, which its feedback message
 * names, so that an answer finds its own wake. A result without an id (an older
 * extension) keeps the call id, and a feedback message then clears every form wake.
 */
export const formWakeKey = (toolCallId: string, details: unknown): string => `${ARTIFACT_PREFIX}${artifactId(details) ?? toolCallId}`;

/** The artifacts that a feedback message answers, from the details that the artifact extension sends. */
export function feedbackIds(details: unknown): string[] {
	if (!object(details) || !Array.isArray(details.changes)) return [];
	return details.changes.flatMap((change) => (object(change) && typeof change.artifact_id === "string" && change.artifact_id.length > 0 ? [change.artifact_id] : []));
}

/**
 * The form wakes that a session's entries still wait for. A reload makes a new warmer,
 * and the entries are the only record of a form that the session waits on: each watched
 * artifact result after which no user prompt and no feedback for it came.
 */
export function openFormWakes(entries: readonly unknown[], tools: readonly string[]): string[] {
	const open = new Set<string>();
	const answer = (ids: readonly string[]) => {
		const keys = namedWakes(ids, (key) => open.has(key));
		if (keys.length === 0) open.clear();
		else for (const key of keys) open.delete(key);
	};
	for (const entry of entries) {
		const message = object(entry) && object(entry.message) ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "user") { open.clear(); continue; }
		if (message.role === "custom" && message.customType === ARTIFACT_FEEDBACK) { answer(feedbackIds(message.details)); continue; }
		if (message.role !== "toolResult" || message.isError === true || typeof message.toolCallId !== "string") continue;
		if (!toolMatches(tools, typeof message.toolName === "string" ? message.toolName : "")) continue;
		// A result of a call made with watch false says so; an older result says nothing and stays open.
		if (object(message.details) && message.details.watching === false) continue;
		open.add(formWakeKey(message.toolCallId, message.details));
	}
	return [...open];
}
