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

export function capReport(text: string, sessionFile?: string, reportFile?: string): string {
	if (text.length <= REPORT_MAX_CHARS) return text;
	const where = reportFile ? ` The whole report is in ${reportFile}.` : sessionFile ? ` The whole report is the last assistant message in ${sessionFile}.` : "";
	const end = /[\uD800-\uDBFF]/.test(text[REPORT_MAX_CHARS - 1]!) && /[\uDC00-\uDFFF]/.test(text[REPORT_MAX_CHARS]!) ? REPORT_MAX_CHARS - 1 : REPORT_MAX_CHARS;
	const preview = text.slice(0, end);
	const closeFence = (preview.match(/```/g)?.length ?? 0) % 2 === 1 ? "\n```" : "";
	return `${preview}${closeFence}\n\n(report cut at ${REPORT_MAX_CHARS} characters.${where})`;
}

const replyHint = (from: string) => `answer with message({ to: "${from}", text })`;

export function noteText(from: string, text: string): string {
	return `Message from ${from}:\n${text}`;
}

/** What wakes main after a /compact stopped the turn mail landed in; the mail itself is above it or in the summary. */
export function reminderText(from: string): string {
	return `Your last turn was stopped before you replied to ${from}. Their message is above or in the summary; handle it now.`;
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

/** A finished, failed, stopped or interrupted child, as its parent reads it. */
export function reportText(record: AgentRecord, now: number): string {
	const head = `${record.name} (${record.model}${spend(record)})`;
	const session = `${record.sessionFile ? `\nSession: ${record.sessionFile}` : ""}${record.report && record.reportFile ? `\nReport: ${record.reportFile}` : ""}`;
	if (record.state === "interrupted") {
		const outcome = record.launchError ? `could not resume: ${oneLine(record.launchError, 300)}` : `was interrupted after ${duration(record, now)}.`;
		const partial = record.report ? `\n\n${record.launchError ? "" : "Last available message:\n"}${capReport(record.report, record.sessionFile, record.reportFile)}` : "";
		return `${head} ${outcome}${session}\nResume explicitly after checking the current files.${partial}`;
	}
	if (record.state === "failed" || record.state === "stopped") {
		const outcome = record.state === "failed" ? `failed after ${duration(record, now)}: ${record.error ?? "unknown error"}` : `was stopped after ${duration(record, now)}.`;
		const partial = record.report ? `\nLast message before it ${record.state}:\n${capReport(record.report, record.sessionFile, record.reportFile)}` : "";
		return `${head} ${outcome}${session}${partial}`;
	}
	const report = record.report?.trim() ? capReport(record.report, record.sessionFile, record.reportFile) : noReport(record.state);
	const why = record.resumedBy && record.runs > 1 ? `\nThis run (${record.runs}) handled: ${oneLine(record.resumedBy.text, 300)}` : "";
	return `${head} finished after ${duration(record, now)}. Message it to follow up; it keeps its context.${session}${why}\n\n${report}`;
}

/** What a report says when the agent never wrote a final message. */
export const noReport = (state: string): string => (state === "stopped" ? "Stopped before it wrote a report." : "(no final message)");

/** The report itself, without the header `reportText` puts on it for the model. */
export function reportBody(text: string): string {
	const cut = text.indexOf("\n\n");
	return cut >= 0 && / finished after /.test(text.slice(0, text.indexOf("\n"))) ? text.slice(cut + 2) : text;
}

type ReportState = "idle" | "failed" | "stopped" | "interrupted";

/** One delivery to an agent, read back from the text its model was given. */
export type Envelope =
	| { readonly kind: "prompt"; readonly text: string }
	| { readonly kind: "note" | "question"; readonly from: string; readonly text: string }
	| { readonly kind: "report"; readonly from: string; readonly model: string; readonly state: ReportState; readonly took?: string; readonly text: string };

// Readers for the writers above, so the inspector shows a delivery as the
// conversation it was rather than the plumbing its model reads. Every writer
// is read back in tests/subagents-envelopes.test.ts, so the two can't drift.
const NAME = "[a-z0-9][a-z0-9-]*";
const MESSAGES = [
	["note", new RegExp(`^Message from (${NAME}):(?:\\n|$)`)],
	["question", new RegExp(`^Question from (${NAME}), who is waiting for your reply \\(.*?\\):(?:\\n|$)`)],
] as const;
const REPORT_HEAD = new RegExp(`^(${NAME}) \\(([^\\s(),]+)(?:, \\$[^\\s)]+)?\\) (.*)$`);
const OUTCOMES: ReadonlyArray<readonly [ReportState, RegExp]> = [
	["idle", /^finished after (?<took>\S+?)\. Message it to follow up/],
	["failed", /^failed after (?<took>\S+?): (?<error>.*)$/],
	["stopped", /^was stopped after (?<took>\S+?)\.$/],
	["interrupted", /^was interrupted after (?<took>\S+?)\.$/],
	["interrupted", /^could not resume: (?<error>.*)$/],
];
/** Lines a report's header carries for the model: where its files are, what the run handled, what to do next. */
const REPORT_META = /^(?:Session|Report): |^This run \(\d+\) handled: |^Resume explicitly after checking the current files\.$/;
const LAST_MESSAGE = /^Last (?:available message|message before it \w+):$/;

const said = (text: string): string => text.replace(/^\n+/, "").trimEnd();

function message(segment: string): Envelope | undefined {
	for (const [kind, head] of MESSAGES) {
		const match = head.exec(segment);
		if (match) return { kind, from: match[1]!, text: said(segment.slice(match[0].length)) };
	}
	return undefined;
}

function report(segment: string): Envelope | undefined {
	const [first = "", ...after] = segment.split("\n");
	const head = REPORT_HEAD.exec(first);
	for (const [state, outcome] of head ? OUTCOMES : []) {
		const match = outcome.exec(head![3]!);
		if (!match) continue;
		// The header runs to the first blank line or the `Last message` marker; what follows is what the agent said.
		const end = after.findIndex((line) => line === "" || LAST_MESSAGE.test(line));
		const body = (end < 0 ? [] : after.slice(end + 1)).filter((line, index) => index > 0 || !LAST_MESSAGE.test(line));
		const error = [match.groups?.error, ...(end < 0 ? after : after.slice(0, end)).filter((line) => !REPORT_META.test(line))].filter(Boolean).join("\n");
		const took = match.groups?.took;
		return { kind: "report", from: head![1]!, model: head![2]!, state, ...(took ? { took } : {}), text: [error, said(body.join("\n"))].filter(Boolean).join("\n\n") };
	}
	return undefined;
}

const opening = (segment: string): Envelope | undefined => message(segment) ?? report(segment);

/**
 * What a user message in an agent's session says, part by part. Deliveries
 * that arrive together are joined by blank lines (team.ts), so a new part
 * starts only at a paragraph that opens like one; anything before the first
 * is a plain prompt, such as the task or a resume notice.
 */
export function readEnvelopes(text: string): Envelope[] {
	const segments = text.split("\n\n").reduce<string[]>((all, paragraph) =>
		(all.length === 0 || opening(paragraph) ? [...all, paragraph] : [...all.slice(0, -1), `${all.at(-1)}\n\n${paragraph}`]), []);
	return segments.flatMap((segment): Envelope[] => {
		const envelope = opening(segment);
		if (envelope) return [envelope];
		return segment.trim() ? [{ kind: "prompt", text: said(segment) }] : [];
	});
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
		`You work for "${parent}" in a team of Pi agents, in the background. Your final message is your report to ${parent}.`,
		"",
		"## Report",
		"End with a report that leads with the outcome in one or two sentences, then gives evidence (file:line, commands you ran and what they showed), changes you made, open questions, and how confident you are. Be concise; it is read in full.",
		"",
		"## Talking to other agents",
		`Use message({ to, text }). \`to\` is "${MAIN}", an agent's name, or "all".`,
		`- Send ${parent} a note only when it would change what they are doing. Do not narrate progress or send results early; results belong in your report.`,
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
