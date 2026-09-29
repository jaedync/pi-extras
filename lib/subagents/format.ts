/**
 * Everything the models read: messages between agents, reports, and the
 * child's standing instructions. Kept in one place so the wording can be tuned
 * against the run log without touching the plumbing.
 */
import { formatElapsed } from "../shell-jobs-widget.ts";
import { formatMoney } from "../status-plus-logic.ts";
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
	return record.usage.cost > 0 ? `, $${formatMoney(record.usage.cost)}` : "";
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

export const DIGEST_MAX_CHARS = 40_000;
const DIGEST_ENTRY_CHARS = 4_000;

/**
 * Main's conversation for a forked child: what was said, and one line per tool
 * call. Tool output stays out; the child can re-read what it needs. Text is
 * portable across providers where raw messages (thinking signatures, tool ids)
 * are not. The newest entries win when it is too long.
 */
export function conversationDigest(entries: readonly unknown[], describe: (tool: string, args: unknown) => string, maxChars = DIGEST_MAX_CHARS): string {
	const parts: string[] = [];
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown } };
		const cap = (text: string) => (text.length > DIGEST_ENTRY_CHARS ? `${text.slice(0, DIGEST_ENTRY_CHARS)}…` : text);
		if (e.type === "custom_message" && String(e.customType ?? "").startsWith("subagent")) {
			parts.push(cap(typeof e.content === "string" ? e.content : ""));
			continue;
		}
		if (e.type !== "message" || !e.message) continue;
		const { role, content } = e.message;
		const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
		if (role === "user") {
			const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
			if (text) parts.push(`User: ${cap(text)}`);
		} else if (role === "assistant") {
			const said = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
			const calls = blocks.filter((b) => b.type === "toolCall").map((b) => `[${describe(String(b.name ?? "tool"), b.arguments)}]`);
			const line = [said ? cap(said) : "", ...calls].filter(Boolean).join("\n");
			if (line) parts.push(`${MAIN}: ${line}`);
		}
	}
	const kept: string[] = [];
	let used = 0;
	for (const part of parts.reverse()) {
		if (used + part.length > maxChars) break;
		kept.unshift(part);
		used += part.length + 2;
	}
	const dropped = parts.length - kept.length;
	return `${dropped > 0 ? `(${dropped} earlier entries omitted)\n\n` : ""}${kept.join("\n\n")}`;
}

/** Appended to a child's system prompt. */
export function childInstructions(options: {
	name: string;
	parent: string;
	readOnly: boolean;
	canSpawn: boolean;
	roster: string;
	/** Main's conversation, for a forked child. */
	conversation?: string;
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
		`- A message from ${parent} is an instruction from the agent you work for. Follow it; where it conflicts with your task, it wins.`,
		...(options.readOnly ? ["", "## Read-only", "Do not modify files, run commands that change state, or make other side effects."] : []),
		...(options.canSpawn ? ["", "## Your own subagents", "You may start subagents with the subagent tool. You are not done until they report back; their reports arrive as messages."] : []),
		"",
		"## Team right now",
		options.roster,
		...(options.conversation ? ["", `## ${MAIN}'s conversation so far (condensed; tool output omitted)`, options.conversation] : []),
	].join("\n");
}
