/**
 * The `autoUpdate` section of pi-extras.json. Off by default: a user who
 * installs this version gets no change until `enable` turns it on.
 */
import { join } from "node:path";
import { readSectionFrom, updateSectionIn } from "../json-section.ts";

export type SourceMode = "tags" | "head" | "skip";

export interface AutoUpdateConfig {
	readonly enabled: boolean;
	readonly intervalMinutes: number;
	readonly minReleaseAgeHours: number;
	/** `auto`: sessions reload or restart by themselves when idle. `notice`: they only say that an update is ready. */
	readonly adopt: "auto" | "notice";
	readonly paused: boolean;
	/** Per origin (the settings source, or its store key): how to find its newest release. */
	readonly sources: Readonly<Record<string, SourceMode>>;
	readonly pi: "latest" | "skip";
	/** Take pre-release tags and versions too. */
	readonly prereleases: boolean;
}

export const SECTION = "autoUpdate";
export const MIN_INTERVAL_MINUTES = 1;

export const DEFAULT_CONFIG: AutoUpdateConfig = {
	enabled: false,
	intervalMinutes: 5,
	minReleaseAgeHours: 0,
	adopt: "auto",
	paused: false,
	sources: {},
	pi: "latest",
	prereleases: false,
};

const MODES = new Set<string>(["tags", "head", "skip"]);

function finite(value: unknown, fallback: number, min: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function parseSources(value: unknown): Record<string, SourceMode> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, SourceMode] => typeof entry[1] === "string" && MODES.has(entry[1]));
	return Object.fromEntries(entries);
}

export function parseConfig(section: unknown): AutoUpdateConfig {
	const raw = section && typeof section === "object" ? (section as Record<string, unknown>) : {};
	return {
		enabled: raw.enabled === true,
		intervalMinutes: finite(raw.intervalMinutes, DEFAULT_CONFIG.intervalMinutes, MIN_INTERVAL_MINUTES),
		minReleaseAgeHours: finite(raw.minReleaseAgeHours, DEFAULT_CONFIG.minReleaseAgeHours, 0),
		adopt: raw.adopt === "notice" ? "notice" : "auto",
		paused: raw.paused === true,
		sources: parseSources(raw.sources),
		pi: raw.pi === "skip" ? "skip" : "latest",
		prereleases: raw.prereleases === true,
	};
}

export const configFile = (agentDir: string): string => join(agentDir, "pi-extras.json");

export function readConfig(agentDir: string): AutoUpdateConfig {
	return parseConfig(readSectionFrom(configFile(agentDir), SECTION));
}

/** Merges `patch` into the section. Throws `UnreadableJsonError` and leaves the file alone when it does not parse. */
export function writeConfig(agentDir: string, patch: Partial<Record<keyof AutoUpdateConfig, unknown>>): void {
	updateSectionIn(configFile(agentDir), SECTION, (current) => ({ ...current, ...patch }));
}
