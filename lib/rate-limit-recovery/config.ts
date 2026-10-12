/** Long waits are separate from Usage Guard and Pi's short transient retries. */
import { CONFIG_FILE, readSection, writeSection } from "../extras-config.ts";
import { DEFAULT_FIRST_EVENT_SECONDS } from "./first-event.ts";

export interface RecoveryConfig {
	readonly autoWait: boolean;
	readonly resumeMarginSeconds: number;
	/** Aggregate wait budget for one user-started run, including margins. */
	readonly maxWaitSeconds: number;
	readonly maxRecoveries: number;
	/** Anthropic subscription stall watchdog after response headers; 0 disables. */
	readonly anthropicFirstEventSeconds: number;
	/** Waiting per streak of short rate limits (OpenRouter upstream, bare 429s); 0 leaves them to Pi. */
	readonly transientMaxWaitSeconds: number;
}

export const SECTION = "rateLimitRecovery";
export const DEFAULT_CONFIG: RecoveryConfig = Object.freeze({
	autoWait: false, resumeMarginSeconds: 10, maxWaitSeconds: 18_000, maxRecoveries: 10,
	anthropicFirstEventSeconds: DEFAULT_FIRST_EVENT_SECONDS,
	transientMaxWaitSeconds: 180,
});
const MAX_WAIT_SECONDS = 18_000;
const MAX_RECOVERIES = 10;
const MAX_MARGIN_SECONDS = 3600;
// Healthy streams send message_start with the headers; below this a slow proxy could trip it.
const MIN_FIRST_EVENT_SECONDS = 10;
const MAX_FIRST_EVENT_SECONDS = 600;
// Below this the first 5 s backoff barely fits; above it a run looks hung.
const MIN_TRANSIENT_SECONDS = 10;
const MAX_TRANSIENT_SECONDS = 900;

/**
 * A number of seconds or a count, moved into [min, max] as the README
 * documents. Anything that is not a finite number, and any negative value,
 * reads as the default: a stray minus must not turn waiting off.
 */
function bounded(value: unknown, fallback: number, min: number, max: number, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	const clamped = Math.min(max, Math.max(min, value));
	return integer ? Math.floor(clamped) : clamped;
}

/** 0 turns the feature off; any other number is moved into [min, max]. */
function optional(value: unknown, fallback: number, min: number, max: number): number {
	return value === 0 ? 0 : bounded(value, fallback, min, max);
}

export function normalizeConfig(raw: unknown): RecoveryConfig {
	const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	return {
		autoWait: r.autoWait === true,
		resumeMarginSeconds: bounded(r.resumeMarginSeconds, DEFAULT_CONFIG.resumeMarginSeconds, 0, MAX_MARGIN_SECONDS),
		maxWaitSeconds: bounded(r.maxWaitSeconds, DEFAULT_CONFIG.maxWaitSeconds, 0, MAX_WAIT_SECONDS),
		maxRecoveries: bounded(r.maxRecoveries, DEFAULT_CONFIG.maxRecoveries, 0, MAX_RECOVERIES, true),
		anthropicFirstEventSeconds: optional(r.anthropicFirstEventSeconds, DEFAULT_CONFIG.anthropicFirstEventSeconds, MIN_FIRST_EVENT_SECONDS, MAX_FIRST_EVENT_SECONDS),
		transientMaxWaitSeconds: optional(r.transientMaxWaitSeconds, DEFAULT_CONFIG.transientMaxWaitSeconds, MIN_TRANSIENT_SECONDS, MAX_TRANSIENT_SECONDS),
	};
}

export function loadConfig(file = CONFIG_FILE, env: NodeJS.ProcessEnv = process.env): RecoveryConfig {
	const config = normalizeConfig(readSection(SECTION, file));
	if (env.PI_RATE_LIMIT_RECOVERY === "on") return { ...config, autoWait: true };
	if (env.PI_RATE_LIMIT_RECOVERY === "off") return { ...config, autoWait: false };
	return config;
}

/**
 * Saves only the keys in `patch`, so the user's own values in the section stay
 * as written. Throws `UnreadableJsonError`, and keeps the file, when it does not parse.
 */
export function saveConfig(patch: Partial<RecoveryConfig>, file = CONFIG_FILE): RecoveryConfig {
	return normalizeConfig(writeSection(SECTION, { ...patch }, file));
}
