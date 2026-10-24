/**
 * What main reads about its team where it already looks, so it needs no
 * extra turn to ask: one line at the end of each delivery about the other
 * agents still at work, and a short roster at the end of its `message` and
 * `stop_subagent` results. Both are bounded and keep one shape, so they cost
 * few tokens and never change a tool description.
 */
import { formatMoney } from "../status-plus-logic.ts";
import { formatTokens } from "../status-plus-render.ts";
import { waitingFor } from "./after.ts";
import { LIVE_STATES, type AgentRecord } from "./types.ts";

/** The most agents a line names before `+N more`. */
export const STATUS_MAX_AGENTS = 8;

type Lookup = (name: string) => AgentRecord | undefined;

const byName = (records: readonly AgentRecord[]): Lookup => {
	const map = new Map(records.map((record) => [record.name, record]));
	return (name) => map.get(name);
};

/** A coarse duration: `45s`, `37m`, `1h05m`. */
export function shortTime(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** What it waits on, in a few words; nothing while it just works. */
function doing(record: AgentRecord, get: Lookup): string {
	switch (record.state) {
		case "queued": {
			const waits = waitingFor(record, get);
			return waits.length > 0 ? `queued after ${waits.join(", ")}` : "queued";
		}
		case "starting": return "starting";
		case "asking": return `waiting on ${record.askingWho ?? "an answer"}`;
		case "waiting": return record.owed?.length ? `waiting on ${record.owed.join(", ")}` : "waiting on its subagents";
		case "interrupted": return "interrupted";
		default: return record.activity?.startsWith("check: ") ? "checking" : "";
	}
}

/**
 * One agent: `impl 37m $17.20 ctx 84k`, `review queued after impl`. Time and
 * cost are those of its current run; the context size tells main what a
 * follow-up to it would re-read.
 */
export function agentStatus(record: AgentRecord, get: Lookup, now: number): string {
	const working = LIVE_STATES.has(record.state) && record.state !== "queued";
	const time = working && record.startedAt !== undefined ? shortTime(now - record.startedAt) : "";
	const cost = working ? record.usage.cost - (record.runCost ?? 0) : 0;
	const context = working && record.contextTokens ? `ctx ${formatTokens(record.contextTokens)}` : "";
	return [record.name, doing(record, get), time, cost > 0 ? `$${formatMoney(cost)}` : "", context].filter(Boolean).join(" ");
}

function bounded(parts: readonly string[]): string {
	return parts.length > STATUS_MAX_AGENTS ? `${parts.slice(0, STATUS_MAX_AGENTS).join(", ")}, +${parts.length - STATUS_MAX_AGENTS} more` : parts.join(", ");
}

/** The line a delivery to main ends with: the live agents besides the ones it comes from; undefined when there are none. */
export function stillWorking(records: readonly AgentRecord[], except: readonly string[], now: number): string | undefined {
	const get = byName(records);
	const others = records.filter((record) => LIVE_STATES.has(record.state) && !except.includes(record.name));
	return others.length > 0 ? `Still working: ${bounded(others.map((record) => agentStatus(record, get, now)))}` : undefined;
}

/** The roster main's `message` and `stop_subagent` results end with: live and interrupted agents, and a count of the ended ones. */
export function teamNow(records: readonly AgentRecord[], now: number): string {
	if (records.length === 0) return "Team now: no agents.";
	const get = byName(records);
	const shown = records.filter((record) => LIVE_STATES.has(record.state) || record.state === "interrupted");
	const ended = records.length - shown.length;
	const list = shown.length > 0 ? bounded(shown.map((record) => agentStatus(record, get, now))) : "no agent is working";
	return `Team now: ${list}${ended > 0 ? `; ${ended} ended` : ""}.`;
}
