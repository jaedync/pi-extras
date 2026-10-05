/**
 * The `subagents` section of pi-extras.json, and the model guide: a Markdown
 * file of the user's "what's true today" notes about which model suits which
 * job. Both are read when a session starts or reloads, never mid-session: the
 * guide goes into a tool description, and changing that busts the prompt cache.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSection } from "../extras-config.ts";
import { MAX_RUN_MINUTES } from "./budget.ts";

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
	/** Reload resumes interrupted runs; other starts notify unless set to always. */
	resumePolicy: "reload" | "always" | "notify";
	/** How long one run of a child may work before it is stopped; a spawn can set its own. */
	maxRunMinutes: number;
	/** Dollars one run may spend before it is stopped; null for no limit. */
	maxRunCost: number | null;
	/** Models a run goes on with when its model can't serve it, in order; unset means the default model, [] turns fallback off. */
	fallbackModels?: string[];
}

export const DEFAULTS: SubagentsConfig = {
	maxConcurrent: 4,
	maxDepth: 1,
	replyTimeoutMs: 10 * 60_000,
	batchMs: 2_000,
	groupWaitMs: 60_000,
	childToolsExclude: [],
	resumePolicy: "reload",
	maxRunMinutes: 60,
	maxRunCost: null,
};

export const GUIDE_FILE = "subagent-models.md";
export const GUIDE_MAX_CHARS = 4_000;

const positiveInt = (value: unknown, fallback: number, max: number): number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

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
		resumePolicy: section.resumePolicy === "always" || section.resumePolicy === "notify" ? section.resumePolicy : DEFAULTS.resumePolicy,
		maxRunMinutes: positive(section.maxRunMinutes) ? Math.min(section.maxRunMinutes, MAX_RUN_MINUTES) : DEFAULTS.maxRunMinutes,
		maxRunCost: positive(section.maxRunCost) ? section.maxRunCost : DEFAULTS.maxRunCost,
	};
	const fallbacks = Array.isArray(section.fallbackModels)
		? { fallbackModels: section.fallbackModels.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0).map((ref) => ref.trim()) }
		: {};
	const model = section.defaultModel;
	return { ...config, ...fallbacks, ...(typeof model === "string" && model.trim().length > 0 ? { defaultModel: model.trim() } : {}) };
}

/** `PI_SUBAGENTS_MAX_DEPTH` overrides the file for one run; nesting is experimental. */
export function loadConfig(file?: string, env: NodeJS.ProcessEnv = process.env): SubagentsConfig {
	const section = file ? readSection("subagents", file) : readSection("subagents");
	const depth = Number(env.PI_SUBAGENTS_MAX_DEPTH);
	return parseConfig(Number.isInteger(depth) && depth >= 1 ? { ...section, maxDepth: depth } : section);
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
