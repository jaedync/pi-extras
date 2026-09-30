/**
 * Every agent has a short readable name that the model, the user and the UI
 * all use: `main` for the parent session, and one made from the task for each
 * child, as Shell Jobs names jobs after their titles.
 */
import { slugify } from "../shell-jobs-core.ts";

export const MAIN = "main";
/** The person at the terminal, writing from the inspector. */
export const USER = "user";
export const EVERYONE = "all";
export const NAME_MAX = 24;
const RESERVED = new Set([MAIN, EVERYONE, USER, "you", "me", "parent"]);

// Words that say nothing about which task this is.
const FILLER = new Set([
	"a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from", "into", "this", "that",
	"these", "those", "it", "its", "is", "are", "be", "please", "can", "could", "you", "your", "our", "my", "we", "i",
	"use", "using", "then", "all", "any", "some", "go", "do", "make", "get", "just", "quickly", "carefully",
	"ask", "tell", "give", "which", "what", "whether", "how", "main", "subagent", "agent", "task", "whole", "entire",
]);

export const isReserved = (name: string): boolean => RESERVED.has(name);

export function taskSlug(task: string): string {
	const words = task.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0 && !FILLER.has(word));
	return slugify(words.slice(0, 3).join(" "), NAME_MAX);
}

/** The requested name if usable, else one from the task; `-2`, `-3` on collisions. */
export function nameFor(requested: string | undefined, task: string, taken: (name: string) => boolean): string {
	let base = (requested ? slugify(requested, NAME_MAX) : "") || taskSlug(task) || "agent";
	if (isReserved(base)) base = `${base}-agent`;
	if (!taken(base)) return base;
	for (let n = 2; ; n++) {
		const name = `${base}-${n}`;
		if (!taken(name)) return name;
	}
}

/** "1 more line", "3 more lines". */
export const moreLines = (count: number, noun = "line"): string => `${count} more ${noun}${count === 1 ? "" : "s"}`;

/**
 * Completions for `/subagents`. None once the text is a whole command: an open
 * menu takes Enter to re-apply its item, so the command would not run.
 */
export function commandCompletions(prefix: string, names: readonly string[]): Array<{ value: string; label: string }> | null {
	const all = ["guide", "stats", "stop all", ...names, ...names.map((name) => `stop ${name}`)];
	if (all.includes(prefix)) return null;
	const matches = all.filter((value) => value.startsWith(prefix));
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}
