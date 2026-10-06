/**
 * What a folded line says: the calls by kind, counted, in the order each kind
 * first ran ("Read 2 files, ran 3 commands"), then the group's figures. A
 * kind with a call still going reads in the present tense.
 */
import { formatTime } from "../band/band.ts";
import { formatTokens } from "../status-plus-render.ts";
import { formatMoney } from "../status-plus-logic.ts";
import { cleanLabel } from "../tool-phrase.ts";

export interface ToolFact {
	readonly name: string;
	/** Still being written or run. */
	readonly running: boolean;
	readonly failed: boolean;
}

export interface FoldFacts {
	readonly tools: readonly ToolFact[];
	/** The model is still working inside this group. */
	readonly live: boolean;
	/** Output tokens of the replies that made the calls. */
	readonly tokens: number;
	/** Dollars those replies cost. */
	readonly cost: number;
	readonly elapsedMs?: number;
}

interface Kind {
	readonly past: string;
	readonly present: string;
	readonly one: string;
	readonly many: string;
}

const kind = (past: string, present: string, one: string, many = `${one}s`): Kind => ({ past, present, one, many });

const FILE_READ = kind("read", "reading", "file");
const SEARCH = kind("searched for", "searching for", "pattern");
const KINDS: Readonly<Record<string, Kind>> = {
	read: FILE_READ,
	edit: kind("edited", "editing", "file"),
	write: kind("wrote", "writing", "file"),
	bash: kind("ran", "running", "command"),
	grep: SEARCH,
	find: SEARCH,
	ls: kind("listed", "listing", "folder"),
	shell_job_start: kind("started", "starting", "background job"),
	shell_job: kind("checked", "checking", "background job"),
	subagent: kind("started", "starting", "subagent"),
	message: kind("messaged", "messaging", "subagent"),
	agent_send: kind("sent", "sending", "message"),
	web_search: kind("searched the web", "searching the web", "time"),
	fetch_content: kind("fetched", "fetching", "page"),
	codemode: kind("ran", "running", "script"),
};

/** The table key for a tool, also when an MCP bridge prefixes its name (`mcp__oc__web_search`). */
function keyOf(name: string): string | undefined {
	return Object.keys(KINDS).find((key) => name === key || name.endsWith(`__${key}`) || name.endsWith(`.${key}`));
}

interface Tally {
	readonly label: string;
	readonly kind: Kind | undefined;
	count: number;
	running: boolean;
}

function tallies(tools: readonly ToolFact[]): Tally[] {
	const byLabel = new Map<string, Tally>();
	for (const tool of tools) {
		const name = cleanLabel(tool.name) || "tool";
		const key = keyOf(name);
		const kind = key ? KINDS[key] : undefined;
		// Kinds that share wording (grep and find) share a count.
		const label = kind ? `${kind.past}|${kind.one}` : name;
		const tally = byLabel.get(label) ?? { label, kind, count: 0, running: false };
		tally.count++;
		tally.running ||= tool.running;
		byLabel.set(label, tally);
	}
	return [...byLabel.values()];
}

function says(tally: Tally): string {
	if (!tally.kind) {
		const verb = tally.running ? "calling" : "called";
		return tally.count === 1 ? `${verb} ${tally.label}` : `${verb} ${tally.label} ${tally.count} times`;
	}
	const verb = tally.running ? tally.kind.present : tally.kind.past;
	return `${verb} ${tally.count} ${tally.count === 1 ? tally.kind.one : tally.kind.many}`;
}

export interface FoldPhrase {
	/** The calls by kind: `Read 2 files, ran 1 command`; `Thinking` or `Thought` when there were none. */
	readonly said: string;
	/** `1 failed`, drawn in the error color. */
	readonly failed?: string;
	/** `thinking`, when the model works between calls. */
	readonly after?: string;
}

export function foldPhrase(facts: FoldFacts): FoldPhrase {
	const parts = tallies(facts.tools).map(says);
	const text = parts.length > 0 ? parts.join(", ") : facts.live ? "thinking" : "thought";
	const failures = facts.tools.filter((tool) => tool.failed).length;
	const thinking = facts.live && parts.length > 0 && !facts.tools.some((tool) => tool.running);
	return {
		said: text[0]!.toUpperCase() + text.slice(1),
		...(failures > 0 ? { failed: `${failures} failed` } : {}),
		...(thinking ? { after: "thinking" } : {}),
	};
}

/** The phrase as one line of plain text. */
export function phraseText(phrase: FoldPhrase): string {
	return [phrase.said, phrase.failed, phrase.after].filter(Boolean).join(", ");
}

/** Tenths below a second too, so a live time doesn't flicker through milliseconds. */
const elapsed = (ms: number) => (ms < 1_000 ? `${(Math.floor(ms / 100) / 10).toFixed(1)}s` : formatTime(ms));

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

/** Figures for the right of the line; a zero cost (a free model) and an unknown time are left out. */
export function foldStats(facts: FoldFacts): string[] {
	return [
		...(facts.tools.length > 0 ? [plural(facts.tools.length, "tool")] : []),
		...(facts.tokens > 0 ? [`${formatTokens(Math.round(facts.tokens))} ${Math.round(facts.tokens) === 1 ? "token" : "tokens"}`] : []),
		...(facts.cost > 0 ? [`$${formatMoney(facts.cost)}`] : []),
		...(facts.elapsedMs !== undefined && facts.elapsedMs > 0 ? [elapsed(facts.elapsedMs)] : []),
	];
}
