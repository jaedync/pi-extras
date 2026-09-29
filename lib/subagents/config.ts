/**
 * The `subagents` section of pi-extras.json, and the model guide: a Markdown
 * file of the user's "what's true today" notes about which model suits which
 * job. Both are read when a session starts or reloads, never mid-session: the
 * guide goes into a tool description, and changing that busts the prompt cache.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSection } from "../extras-config.ts";

export interface SubagentsConfig {
	/** A model reference or short name; unset means the parent's model. */
	defaultModel?: string;
	maxConcurrent: number;
	/** 1 means children cannot start children. Deeper nesting is experimental. */
	maxDepth: number;
	/** How long a child blocks on `message({ expectReply })` before giving up. */
	replyTimeoutMs: number;
	/** Completions that land this close together wake the parent once. */
	batchMs: number;
	/** The longest a report waits for the rest of its group. */
	groupWaitMs: number;
	/** Tools a child never gets, on top of the built-in exclusions. */
	childToolsExclude: string[];
}

export const DEFAULTS: SubagentsConfig = {
	maxConcurrent: 4,
	maxDepth: 1,
	replyTimeoutMs: 10 * 60_000,
	batchMs: 2_000,
	groupWaitMs: 60_000,
	childToolsExclude: [],
};

export const GUIDE_FILE = "subagent-models.md";
export const GUIDE_MAX_CHARS = 4_000;

const positiveInt = (value: unknown, fallback: number, max: number): number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;

/** Invalid values fall back to defaults rather than failing the session. */
export function parseConfig(section: Record<string, unknown>): SubagentsConfig {
	const exclude = Array.isArray(section.childToolsExclude)
		? section.childToolsExclude.filter((name): name is string => typeof name === "string" && name.length > 0)
		: DEFAULTS.childToolsExclude;
	const config: SubagentsConfig = {
		maxConcurrent: positiveInt(section.maxConcurrent, DEFAULTS.maxConcurrent, 16),
		maxDepth: positiveInt(section.maxDepth, DEFAULTS.maxDepth, 4),
		replyTimeoutMs: positiveInt(section.replyTimeoutMs, DEFAULTS.replyTimeoutMs, 60 * 60_000),
		batchMs: positiveInt(section.batchMs, DEFAULTS.batchMs, 30_000),
		groupWaitMs: positiveInt(section.groupWaitMs, DEFAULTS.groupWaitMs, 30 * 60_000),
		childToolsExclude: exclude,
	};
	const model = section.defaultModel;
	return typeof model === "string" && model.trim().length > 0 ? { ...config, defaultModel: model.trim() } : config;
}

export function loadConfig(file?: string): SubagentsConfig {
	return parseConfig(file ? readSection("subagents", file) : readSection("subagents"));
}

function readCapped(path: string): string | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
	if (text.length === 0) return null;
	return text.length > GUIDE_MAX_CHARS ? `${text.slice(0, GUIDE_MAX_CHARS)}\n(guide truncated at ${GUIDE_MAX_CHARS} characters)` : text;
}

/** The user's guide, then the project's, each optional. */
export function readGuide(agentDir: string, cwd: string): { text: string; sources: string[] } {
	const parts: string[] = [];
	const sources: string[] = [];
	for (const path of [join(agentDir, GUIDE_FILE), join(cwd, ".pi", GUIDE_FILE)]) {
		const text = readCapped(path);
		if (text === null) continue;
		parts.push(text);
		sources.push(path);
	}
	return { text: parts.join("\n\n"), sources };
}
