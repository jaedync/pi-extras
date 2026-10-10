/**
 * What a folded line says: the calls by kind, counted, in the order each kind
 * first ran ("Read 2 files, ran 3 commands"), then the group's figures. The
 * words tell what was done, a call still going too; what happens now is the
 * live line's spinner to show.
 */
import { formatTime } from "../band/band.ts";
import { formatTokens } from "../status-plus-render.ts";
import { cleanLabel } from "../tool-phrase.ts";

export interface ToolFact {
	readonly name: string;
	readonly failed: boolean;
	/** How many it counts as: the steps of a chained command; 0 for a script whose own calls are counted. Default 1. */
	readonly count?: number;
	/** The file it works on, by name, once its path is known. */
	readonly file?: string;
	/** What it ran, short (`ls node_modules`, `read b.ts`), to name it when it is the one call that failed. */
	readonly label?: string;
}

/** What the model does now in a live group, as the phase spinner names it: waits for the model, thinks, writes a call, runs one, or waits on another agent. */
export type FoldPhase = "wait" | "think" | "tool" | "run" | "peer";

export interface FoldFacts {
	readonly tools: readonly ToolFact[];
	/** The model is still working inside this group. */
	readonly live: boolean;
	/** Output tokens of the replies that made the calls (received). */
	readonly tokens: number;
	/** Input tokens those replies sent, cache reads and writes included. */
	readonly sent?: number;
	readonly elapsedMs?: number;
	/** While live, what the model does now; the line's spinner shows it. */
	readonly phase?: FoldPhase;
	/** While live, how long its replies have thought so far. */
	readonly thoughtMs?: number;
}

interface Kind {
	readonly past: string;
	readonly one: string;
	readonly many: string;
	/** Says the file's name when every call of the kind worked on one file. */
	readonly names?: boolean;
}

const kind = (past: string, one: string, many = `${one}s`): Kind => ({ past, one, many });
/** A change to a file is worth its name; a read is not. */
const naming = (base: Kind): Kind => ({ ...base, names: true });

const FILE_READ = kind("read", "file");
const SEARCH = kind("searched for", "pattern");
const KINDS: Readonly<Record<string, Kind>> = {
	read: FILE_READ,
	edit: naming(kind("edited", "file")),
	write: naming(kind("wrote", "file")),
	bash: kind("ran", "command"),
	grep: SEARCH,
	find: SEARCH,
	ls: kind("listed", "folder"),
	shell_job_start: kind("started", "background job"),
	shell_job: kind("checked", "background job"),
	subagent: kind("started", "subagent"),
	message: kind("messaged", "subagent"),
	agent_send: kind("sent", "message"),
	web_search: kind("searched the web", "time"),
	fetch_content: kind("fetched", "page"),
	codemode: kind("ran", "script"),
};

/** The table key for a tool, also when an MCP bridge prefixes its name (`mcp__oc__web_search`). */
function keyOf(name: string): string | undefined {
	return Object.keys(KINDS).find((key) => name === key || name.endsWith(`__${key}`) || name.endsWith(`.${key}`));
}

interface Tally {
	readonly label: string;
	readonly kind: Kind | undefined;
	count: number;
	readonly files: Set<string>;
	/** A call of this kind whose file is not known. */
	unnamed: boolean;
}

function tallies(tools: readonly ToolFact[]): Tally[] {
	const byLabel = new Map<string, Tally>();
	for (const tool of tools) {
		const name = cleanLabel(tool.name) || "tool";
		const key = keyOf(name);
		const kind = key ? KINDS[key] : undefined;
		// Kinds that share wording (grep and find) share a count.
		const label = kind ? `${kind.past}|${kind.one}` : name;
		const tally = byLabel.get(label) ?? { label, kind, count: 0, files: new Set<string>(), unnamed: false };
		tally.count += tool.count ?? 1;
		if (tool.file) tally.files.add(tool.file);
		else tally.unnamed = true;
		byLabel.set(label, tally);
	}
	return lumpOthers([...byLabel.values()].filter((tally) => tally.count > 0));
}

/** The longest name of another tool spelled out (`called usage`); MCP names run far longer. */
const NAME_MAX = 20;
const TOOLS = kind("used", "tool");
const OTHER_TOOLS = kind("used", "other tool");

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
		files: new Set(),
		unnamed: true,
	};
	const at = tallies.indexOf(others[0]!);
	return [...tallies.slice(0, at), lumped, ...tallies.slice(at).filter((tally) => tally.kind)];
}

function says(tally: Tally): string {
	if (!tally.kind) return tally.count === 1 ? `called ${tally.label}` : `called ${tally.label} ${tally.count} times`;
	const verb = tally.kind.past;
	const [file] = tally.files;
	if (tally.kind.names && file !== undefined && tally.files.size === 1 && !tally.unnamed) return `${verb} ${file}`;
	return `${verb} ${tally.count} ${tally.count === 1 ? tally.kind.one : tally.kind.many}`;
}

export interface FoldPhrase {
	/** The calls by kind: `Read 2 files, ran 1 command`; `Thought`, or `Thought for 2.5s`, when there were none. */
	readonly said: string;
	/** `ls node_modules failed` for one failed call, `2 failed` for more, drawn in the error color. */
	readonly failed?: string;
}

/** `brief`: the total count of calls (`Used 12 tools`), for a line too narrow for every kind. */
export function foldPhrase(facts: FoldFacts, brief = false): FoldPhrase {
	const counted = tallies(facts.tools);
	const total = counted.reduce((sum, tally) => sum + tally.count, 0);
	const parts = brief && total > 0 ? [says({ label: "|tools", kind: TOOLS, count: total, files: new Set(), unnamed: true })] : counted.map(says);
	// What the model does now is the spinner's to show; the words say what it has done.
	const text = parts.length > 0 ? parts.join(", ") : thoughtFor(facts);
	const failures = facts.tools.filter((tool) => tool.failed);
	const named = !brief && failures.length === 1 ? failures[0]!.label : undefined;
	return {
		said: text[0]!.toUpperCase() + text.slice(1),
		...(failures.length > 0 ? { failed: named ? `${named} failed` : `${failures.length} failed` } : {}),
	};
}

/** A settled line of thinking alone: `∴ Thought for 0.6s`, with no figures. */
export const thoughtOnly = (facts: FoldFacts): boolean => !facts.live && facts.tools.length === 0;
/** Live with no calls yet, the words say how long it has thought so far, and the figures leave the time out. */
const thinksLive = (facts: FoldFacts) => facts.live && facts.tools.length === 0 && facts.thoughtMs !== undefined;
/** It says how long, as Claude Code's does. */
const timeSaid = (facts: FoldFacts) => (thinksLive(facts) ? facts.thoughtMs : thoughtOnly(facts) && (facts.elapsedMs ?? 0) > 0 ? facts.elapsedMs : undefined);
const thoughtFor = (facts: FoldFacts) => {
	const ms = timeSaid(facts);
	return ms !== undefined ? `thought for ${elapsed(ms)}` : "thought";
};

/** The phrase as one line of plain text. */
export function phraseText(phrase: FoldPhrase): string {
	return [phrase.said, phrase.failed].filter(Boolean).join(", ");
}

/** `↑288k ↓1.6k`: the tokens the replies sent and the tokens that came back. */
function tokenFigure(sent: number, received: number): string[] {
	const up = Math.round(sent);
	const down = Math.round(received);
	const parts = [...(up > 0 ? [`↑${formatTokens(up)}`] : []), ...(down > 0 ? [`↓${formatTokens(down)}`] : [])];
	return parts.length > 0 ? [parts.join(" ")] : [];
}

/** Tenths below a second too, so a live time doesn't flicker through milliseconds; never 0.0s for a time that passed. */
export const elapsed = (ms: number): string => (ms < 1_000 ? `${(Math.max(1, Math.floor(ms / 100)) / 10).toFixed(1)}s` : formatTime(ms));

/**
 * Figures after the words. The words count the calls already, and a Thought
 * line says its time and nothing more; an unknown time is left out. Cost
 * shows only on the end line of a prompt.
 */
export function foldStats(facts: FoldFacts): string[] {
	if (thoughtOnly(facts)) return [];
	return [
		...tokenFigure(facts.sent ?? 0, facts.tokens),
		...(!thinksLive(facts) && facts.elapsedMs !== undefined && facts.elapsedMs > 0 ? [elapsed(facts.elapsedMs)] : []),
	];
}
