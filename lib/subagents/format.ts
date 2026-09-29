/**
 * Everything the models read: messages between agents, reports, and the
 * child's standing instructions. Kept in one place so the wording can be tuned
 * against the run log without touching the plumbing.
 */
import { formatElapsed } from "../shell-jobs-widget.ts";
import { MAIN } from "./names.ts";
import type { AgentRecord } from "./types.ts";

export const REPORT_MAX_CHARS = 12_000;

export function capReport(text: string, sessionFile?: string): string {
	if (text.length <= REPORT_MAX_CHARS) return text;
	const where = sessionFile ? ` The whole report is the last assistant message in ${sessionFile}.` : "";
	return `${text.slice(0, REPORT_MAX_CHARS)}\n\n(report cut at ${REPORT_MAX_CHARS} characters.${where})`;
}

const replyHint = (from: string) => `answer with message({ to: "${from}", text })`;

export function noteText(from: string, text: string): string {
	return `Message from ${from}:\n${text}`;
}

export function questionText(from: string, text: string): string {
	return `Question from ${from}, who is waiting for your reply (${replyHint(from)}):\n${text}`;
}

export function spend(record: Pick<AgentRecord, "usage">): string {
	return record.usage.cost > 0 ? `, $${record.usage.cost.toFixed(record.usage.cost < 0.1 ? 4 : 2)}` : "";
}

function duration(record: AgentRecord, now: number): string {
	return formatElapsed((record.endedAt ?? now) - (record.startedAt ?? record.createdAt));
}

/** A finished, failed or stopped child, as its parent reads it. */
export function reportText(record: AgentRecord, now: number): string {
	const head = `${record.name} (${record.model}${spend(record)})`;
	const session = record.sessionFile ? `\nSession: ${record.sessionFile}` : "";
	if (record.state === "failed") return `${head} failed after ${duration(record, now)}: ${record.error ?? "unknown error"}${session}`;
	if (record.state === "stopped") {
		const partial = record.report ? `\nLast message before it stopped:\n${capReport(record.report, record.sessionFile)}` : "";
		return `${head} was stopped after ${duration(record, now)}.${partial}${session}`;
	}
	const report = record.report?.trim() ? capReport(record.report, record.sessionFile) : "(no final message)";
	return `${head} finished after ${duration(record, now)}. Message it to follow up; it keeps its context.${session}\n\n${report}`;
}

export interface RosterEntry {
	name: string;
	task: string;
	state: string;
	model: string;
}

function oneLine(text: string, max = 100): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function rosterText(self: string, entries: readonly RosterEntry[]): string {
	const lines = [`- ${MAIN}: the user's session; it started this team`];
	for (const entry of entries) {
		const who = entry.name === self ? `${entry.name} (you)` : entry.name;
		lines.push(`- ${who}: ${oneLine(entry.task)} [${entry.state}, ${entry.model}]`);
	}
	return lines.join("\n");
}

/** Appended to a child's system prompt. */
export function childInstructions(options: {
	name: string;
	parent: string;
	readOnly: boolean;
	canSpawn: boolean;
	roster: string;
}): string {
	const { name, parent } = options;
	return [
		`# You are the subagent "${name}"`,
		`You work for "${parent}" in a team of Pi agents, in the background. Your final message is your report to ${parent}; nothing else you write reaches it.`,
		"",
		"## Report",
		"End with a report that leads with the outcome in one or two sentences, then gives evidence (file:line, commands you ran and what they showed), changes you made, open questions, and how confident you are. Be concise; it is read in full.",
		"",
		"## Talking to other agents",
		`Use message({ to, text }). \`to\` is "${MAIN}", an agent's name, or "all".`,
		`- Send ${parent} a note only when it would change what they are doing. Do not narrate progress.`,
		"- If you are blocked on a decision you should not make alone, ask with expectReply: true and wait for the answer.",
		"- Coordinate with the other agents directly instead of duplicating their work.",
		"- Messages to you arrive between your tool calls.",
		...(options.readOnly ? ["", "## Read-only", "Do not modify files, run commands that change state, or make other side effects."] : []),
		...(options.canSpawn ? ["", "## Your own subagents", "You may start subagents with the subagent tool. You are not done until they report back; their reports arrive as messages."] : []),
		"",
		"## Team right now",
		options.roster,
	].join("\n");
}
