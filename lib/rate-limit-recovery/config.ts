/** Long waits are separate from Usage Guard and Pi's short transient retries. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
}

export const SECTION = "rateLimitRecovery";
export const DEFAULT_CONFIG: RecoveryConfig = Object.freeze({
	autoWait: false, resumeMarginSeconds: 10, maxWaitSeconds: 18_000, maxRecoveries: 3,
	anthropicFirstEventSeconds: DEFAULT_FIRST_EVENT_SECONDS,
});
const MAX_WAIT_SECONDS = 18_000;
const MAX_RECOVERIES = 10;
const MAX_MARGIN_SECONDS = 3600;
// Healthy streams send message_start with the headers; below this a slow proxy could trip it.
const MIN_FIRST_EVENT_SECONDS = 10;
const MAX_FIRST_EVENT_SECONDS = 600;

function bounded(value: unknown, fallback: number, max: number, integer = false): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max && (!integer || Number.isInteger(value)) ? value : fallback;
}

function firstEventSeconds(value: unknown): number {
	if (value === 0) return 0;
	const seconds = bounded(value, DEFAULT_CONFIG.anthropicFirstEventSeconds, MAX_FIRST_EVENT_SECONDS);
	return seconds >= MIN_FIRST_EVENT_SECONDS ? seconds : DEFAULT_CONFIG.anthropicFirstEventSeconds;
}

export function normalizeConfig(raw: unknown): RecoveryConfig {
	const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	return {
		autoWait: r.autoWait === true,
		resumeMarginSeconds: bounded(r.resumeMarginSeconds, DEFAULT_CONFIG.resumeMarginSeconds, MAX_MARGIN_SECONDS),
		maxWaitSeconds: bounded(r.maxWaitSeconds, DEFAULT_CONFIG.maxWaitSeconds, MAX_WAIT_SECONDS),
		maxRecoveries: bounded(r.maxRecoveries, DEFAULT_CONFIG.maxRecoveries, MAX_RECOVERIES, true),
		anthropicFirstEventSeconds: firstEventSeconds(r.anthropicFirstEventSeconds),
	};
}

export function loadConfig(file = CONFIG_FILE, env: NodeJS.ProcessEnv = process.env): RecoveryConfig {
	const config = normalizeConfig(readSection(SECTION, file));
	if (env.PI_RATE_LIMIT_RECOVERY === "on") return { ...config, autoWait: true };
	if (env.PI_RATE_LIMIT_RECOVERY === "off") return { ...config, autoWait: false };
	return config;
}

export function saveConfig(patch: Partial<RecoveryConfig>, file = CONFIG_FILE): RecoveryConfig {
	const config = normalizeConfig({ ...readSection(SECTION, file), ...patch });
	mkdirSync(dirname(file), { recursive: true });
	writeSection(SECTION, { ...config }, file);
	return config;
}
