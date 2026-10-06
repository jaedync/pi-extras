/**
 * What a folded line says: the calls by kind, counted, in the order each kind
 * first ran ("Read 2 files, ran 3 commands"), then the group's figures. A
 * kind with a call still going reads in the present tense.
 */
import { formatTime } from "../band/band.ts";
import { formatTokens } from "../status-plus-render.ts";
import { cleanLabel } from "../tool-phrase.ts";

export interface ToolFact {
	readonly name: string;
	/** Still being written or run. */
	readonly running: boolean;
	readonly failed: boolean;
	/** How many it counts as: the steps of a chained command; 0 for a script whose own calls are counted. Default 1. */
	readonly count?: number;
}

export interface FoldFacts {
	readonly tools: readonly ToolFact[];
	/** The model is still working inside this group. */
	readonly live: boolean;
	/** Output tokens of the replies that made the calls (received). */
	readonly tokens: number;
	/** Input tokens those replies sent, cache reads and writes included. */
	readonly sent?: number;
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
		tally.count += tool.count ?? 1;
		tally.running ||= tool.running;
		byLabel.set(label, tally);
	}
	return lumpOthers([...byLabel.values()].filter((tally) => tally.count > 0));
}

/** The longest name of another tool spelled out (`called usage`); MCP names run far longer. */
const NAME_MAX = 20;
const TOOLS = kind("used", "using", "tool");
const OTHER_TOOLS = kind("used", "using", "other tool");

/**
 * Tools without wording of their own are named only when there is one such
 * tool with a short name. Several, or a long name, become one count where the
 * first of them was: `used 44 tools`, or `used 2 other tools` beside known kinds.
 */
function lumpOthers(tallies: Tally[]): Tally[] {
	const others = tallies.filter((tally) => !tally.kind);
	if (others.length === 0 || (others.length === 1 && others[0]!.label.length <= NAME_MAX)) return tallies;
	const lumped: Tally = {
		label: "|tools",
		kind: others.length === tallies.length ? TOOLS : OTHER_TOOLS,
		count: others.reduce((sum, tally) => sum + tally.count, 0),
		running: others.some((tally) => tally.running),
	};
	const at = tallies.indexOf(others[0]!);
	return [...tallies.slice(0, at), lumped, ...tallies.slice(at).filter((tally) => tally.kind)];
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
	/** The calls by kind: `Read 2 files, ran 1 command`; `Thinking`, or `Thought for 2.5s`, when there were none. */
	readonly said: string;
	/** `1 failed`, drawn in the error color. */
	readonly failed?: string;
	/** `thinking`, when the model works between calls. */
	readonly after?: string;
}

/** `brief`: the total count of calls (`Used 12 tools`), for a line too narrow for every kind. */
export function foldPhrase(facts: FoldFacts, brief = false): FoldPhrase {
	const counted = tallies(facts.tools);
	const total = counted.reduce((sum, tally) => sum + tally.count, 0);
	const running = counted.some((tally) => tally.running);
	const parts = brief && total > 0 ? [says({ label: "|tools", kind: TOOLS, count: total, running })] : counted.map(says);
	const text = parts.length > 0 ? parts.join(", ") : facts.live ? "thinking" : thoughtFor(facts);
	const failures = facts.tools.filter((tool) => tool.failed).length;
	const thinking = facts.live && parts.length > 0 && !facts.tools.some((tool) => tool.running);
	return {
		said: text[0]!.toUpperCase() + text.slice(1),
		...(failures > 0 ? { failed: `${failures} failed` } : {}),
		...(thinking ? { after: "thinking" } : {}),
	};
}

/** A settled line of thinking alone says how long, as Claude Code's does. */
const saysTime = (facts: FoldFacts) => !facts.live && facts.tools.length === 0 && facts.elapsedMs !== undefined && facts.elapsedMs > 0;
const thoughtFor = (facts: FoldFacts) => (saysTime(facts) ? `thought for ${elapsed(facts.elapsedMs!)}` : "thought");

/** The phrase as one line of plain text. */
export function phraseText(phrase: FoldPhrase): string {
	return [phrase.said, phrase.failed, phrase.after].filter(Boolean).join(", ");
}

/** `↑288k ↓1.6k`: the tokens the replies sent and the tokens that came back. */
export function tokenFigure(sent: number, received: number): string[] {
	const up = Math.round(sent);
	const down = Math.round(received);
	const parts = [...(up > 0 ? [`↑${formatTokens(up)}`] : []), ...(down > 0 ? [`↓${formatTokens(down)}`] : [])];
	return parts.length > 0 ? [parts.join(" ")] : [];
}

/** Tenths below a second too, so a live time doesn't flicker through milliseconds. */
const elapsed = (ms: number) => (ms < 1_000 ? `${(Math.floor(ms / 100) / 10).toFixed(1)}s` : formatTime(ms));

/**
 * Figures after the words. The words count the calls already, and a Thought
 * line says its time; an unknown time is left out. Cost shows only on the
 * end line of a prompt.
 */
export function foldStats(facts: FoldFacts): string[] {
	return [
		...tokenFigure(facts.sent ?? 0, facts.tokens),
		...(facts.elapsedMs !== undefined && facts.elapsedMs > 0 && !saysTime(facts) ? [elapsed(facts.elapsedMs)] : []),
	];
}
