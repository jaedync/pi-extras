/**
 * Everything the models read: messages between agents, reports, and the
 * child's standing instructions. Kept in one place so the wording can be tuned
 * against the run log without touching the plumbing.
 */
import { formatElapsed } from "../shell-jobs-widget.ts";
import { formatMoney } from "../status-plus-logic.ts";
import { formatTokens } from "../status-plus-render.ts";
import type { RunLimits } from "./budget.ts";
import { checkLines, checkOf } from "./checks.ts";
import { MAIN } from "./names.ts";
import { type AgentRecord, neverStarted, type Worktree } from "./types.ts";
import { worktreeFooter } from "./worktree.ts";

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

const CHECK_FIRST = "Its last tool call may not have completed and files may have changed. Verify the current state before continuing.";

/** The budget a reason names (budget.ts `timeReason`): `its 60-minute budget`. */
export const budgetWords = (reason: string): string => reason.replace(/^over /, "");

/** What a resumed agent is told first about how its last run ended, when that run did not finish. */
export function resumeWarning(target: AgentRecord): string {
	if (target.state === "interrupted") return `Your previous run was interrupted. ${CHECK_FIRST}\n\n`;
	// Its tools stopped at the limit, maybe in the middle of a call.
	if (target.state === "idle" && target.budgetEnd) return `Your previous run reached ${budgetWords(target.budgetEnd)} and ended with a wrap-up report. This run has a fresh budget. ${CHECK_FIRST}\n\n`;
	if (target.state === "failed") return `Your previous run failed: ${target.error ?? "unknown error"}. ${CHECK_FIRST}\n\n`;
	// No run began (a spawn has runs 0 until its launch opens) and no launch set startedAt, so it changed nothing.
	// A legacy or orphaned record restores with runs 1 and no startedAt, but it ran.
	if (target.state === "stopped" && target.runs === 0 && target.startedAt === undefined) return "Your first run was stopped before it started, so nothing ran.\n\n";
	if (target.state === "stopped" && target.stopReason) return `Your previous run was stopped ${target.stopReason}. This run has a fresh budget. ${CHECK_FIRST}\n\n`;
	if (target.state === "stopped") return `Your previous run was stopped. ${CHECK_FIRST}\n\n`;
	return "";
}

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

/**
 * A question a child asked main before it was interrupted, as the next start
 * posts it (host-state.ts): what became of the child decides what an answer does.
 */
export function keptQuestionText(from: string, text: string, now: "resumed" | "paused" | "held"): string {
	const state = now === "resumed" ? `It has resumed; ${replyHint(from)}, and the answer reaches its new run.`
		: now === "held" ? `It is paused, and resumePolicy is "notify": an answer waits in its inbox until it resumes.`
		: `It is paused; an answer (${replyHint(from)}) resumes it.`;
	return `${from} asked this before it was interrupted. ${state}\n${text}`;
}

export function spend(record: Pick<AgentRecord, "usage">): string {
	return record.usage.cost > 0 ? `, $${formatMoney(record.usage.cost)}` : "";
}

const CANCELLED_QUEUED = "was cancelled while queued; it never started ($0).";

function duration(record: AgentRecord, now: number): string {
	return formatElapsed((record.endedAt ?? now) - (record.startedAt ?? record.createdAt));
}

/** A finished, failed, stopped or interrupted child, as its parent reads it. */
export function reportText(record: AgentRecord, now: number): string {
	return reportSummary(record, now) + (record.worktree && !record.sharesWorktree ? record.worktreeReport ?? worktreeFooter(record.worktree) : "");
}

/** This run's switches to fallback models, said plainly, since a fallback may cost more than the model its parent chose. */
function fallbackLines(record: AgentRecord): string {
	return (record.fallbacks ?? []).filter((step) => step.run === record.runs)
		.map((step) => `\nRan on ${step.to} after ${step.from} failed: ${step.reason}.`).join("");
}

/** A report ends with its run's check, if one ran or was skipped: evidence from the harness after the agent's own words. */
function reportSummary(record: AgentRecord, now: number): string {
	const check = checkLines(record);
	return `${reportCore(record, now)}${check ? `\n\n${check}` : ""}`;
}

/**
 * From this context size a follow-up probably costs more than a fresh
 * subagent: each turn of a resume sends the whole context again (a cache read
 * at best, a full write once the cache has expired), while a fresh agent
 * starts at its system prompt and the task, about 10k to 25k tokens.
 */
export const FRESH_HINT_TOKENS = 100_000;

/** The hint a report gives when its agent's context is large (FRESH_HINT_TOKENS). */
function contextLine(record: AgentRecord): string {
	const tokens = record.contextTokens;
	return tokens !== undefined && tokens >= FRESH_HINT_TOKENS ? `\nContext: ${formatTokens(tokens)} tokens. A follow-up re-reads all of it each turn; for unrelated work, a fresh subagent probably costs less.` : "";
}

function reportCore(record: AgentRecord, now: number): string {
	const head = `${record.name} (${record.model}${spend(record)})`;
	const session = `${record.sessionFile ? `\nSession: ${record.sessionFile}` : ""}${record.report && record.reportFile ? `\nReport: ${record.reportFile}` : ""}${contextLine(record)}${fallbackLines(record)}`;
	if (record.state === "interrupted") {
		const outcome = record.launchError ? `could not resume: ${oneLine(record.launchError, 300)}` : `was interrupted after ${duration(record, now)}.`;
		const partial = record.report ? `\n\n${record.launchError ? "" : "Last available message:\n"}${capReport(record.report, record.sessionFile, record.reportFile)}` : "";
		return `${head} ${outcome}${session}\nResume explicitly after checking the current files.${partial}`;
	}
	// Stopped before its first run: it used no time or money, and it has no session to read.
	if (record.state === "stopped" && neverStarted(record)) return `${head} ${CANCELLED_QUEUED}${fallbackLines(record)}`;
	if (record.state === "failed" || record.state === "stopped") {
		const outcome = record.state === "failed" ? `failed after ${duration(record, now)}: ${record.error ?? "unknown error"}`
			: `was stopped after ${duration(record, now)}${record.stopReason ? `: ${record.stopReason}` : ""}.`;
		const partial = record.report ? `\nLast message before it ${record.state}:\n${capReport(record.report, record.sessionFile, record.reportFile)}` : "";
		return `${head} ${outcome}${session}${partial}`;
	}
	const report = record.report?.trim() ? capReport(record.report, record.sessionFile, record.reportFile) : noReport(record.state);
	const why = record.resumedBy && record.runs > 1 ? `\nThis run (${record.runs}) handled: ${oneLine(record.resumedBy.text, 300)}` : "";
	if (record.state === "idle" && record.budgetEnd) return `${head} ${budgetOutcome(record, now)}${session}${why}\n\n${report}`;
	return `${head} finished after ${duration(record, now)}. Message it to follow up; it keeps its context.${session}${why}\n\n${report}`;
}

/** How a run that wrote its report at its budget (wrap-up.ts) ended, for the model that reads it. */
function budgetOutcome(record: AgentRecord, now: number): string {
	// A check of an earlier fix round of this run may show below; none ran on the work as it ended.
	const check = record.check ? `, and its check did not run${checkOf(record) ? " again" : ""}` : "";
	return `reached ${budgetWords(record.budgetEnd!)} after ${duration(record, now)} and wrote this report when told to stop. Its work may be incomplete${check}. Message it to continue with a fresh budget; it keeps its context.`;
}

/**
 * A panel's message (panel.ts): a line per member with how it ended, its
 * time, its cost and where its report is, then each report as usual.
 */
export function panelText(panel: string, records: readonly AgentRecord[], now: number): string {
	const lines = records.map((record) => `- ${record.name} (${record.model}): ${panelOutcome(record, now)}`);
	return [[`Panel ${panel} ended: ${records.length} agents on the same task.`, ...lines].join("\n"), ...records.map((record) => reportText(record, now))].join("\n\n---\n\n");
}

function panelOutcome(record: AgentRecord, now: number): string {
	if (record.state === "stopped" && neverStarted(record)) return CANCELLED_QUEUED;
	const ended = record.state === "idle" ? (record.budgetEnd ? "reached its budget" : "finished") : record.state === "failed" ? "failed" : record.state === "stopped" ? "was stopped" : `was ${record.state}`;
	const where = record.report && record.reportFile ? `Report: ${record.reportFile}` : record.sessionFile ? `Session: ${record.sessionFile}` : "No report.";
	return `${ended} after ${duration(record, now)}, $${formatMoney(record.usage.cost)}. ${where}`;
}

/** What a report says when the agent never wrote a final message. */
export const noReport = (state: string): string => (state === "stopped" ? "Stopped before it wrote a report." : "(no final message)");

/** The report itself, without the header `reportText` puts on it for the model. */
export function reportBody(text: string): string {
	const cut = text.indexOf("\n\n");
	return cut >= 0 && / (?:finished|reached .+? budget) after /.test(text.slice(0, text.indexOf("\n"))) ? text.slice(cut + 2) : text;
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
	["idle", /^(?<error>reached .+? budget) after (?<took>\S+?) and wrote this report when told to stop\./],
	["failed", /^failed after (?<took>\S+?): (?<error>.*)$/],
	["stopped", /^was stopped after (?<took>\S+?)(?:: (?<error>.*))?\.$/],
	["stopped", /^was cancelled while queued; it never started \(\$0\)\.$/],
	["interrupted", /^was interrupted after (?<took>\S+?)\.$/],
	["interrupted", /^could not resume: (?<error>.*)$/],
];
/** Lines a report's header carries for the model: where its files are, what the run handled, what to do next. */
const REPORT_META = /^(?:Session|Report): |^Context: \d|^This run \(\d+\) handled: |^Resume explicitly after checking the current files\.$/;
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
/** What another agent on the mesh sent main (remote-pi); a fork made to handle it needs to see it. */
const MESH_MESSAGE_TYPE = "remote-pi:mesh-message";

/**
 * Main's session entries up to `at`, a fork's spawn: each launch of the fork,
 * a relaunch after a restart included, sees main's conversation as it was
 * when it was forked, not what came later (its own reports among it).
 */
export function entriesUntil(entries: readonly unknown[], at: number): unknown[] {
	return entries.filter((entry) => {
		const time = Date.parse(String((entry as { timestamp?: unknown }).timestamp ?? ""));
		return !Number.isFinite(time) || time <= at;
	});
}

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
		if (e.type === "custom_message" && (String(e.customType ?? "").startsWith("subagent") || e.customType === MESH_MESSAGE_TYPE)) {
			const text = typeof e.content === "string" ? e.content : Array.isArray(e.content)
				? (e.content as Array<{ type?: unknown; text?: unknown }>).filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n") : "";
			if (text) parts.push(cap(text));
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

const PLAN_TO_REPORT = "Plan so that you can write your report before then. At the limit, tool calls stop and you must report.";
const MINUTE_MS = 60_000;

/** Minutes as a clock note gives them: tenths under 10, whole minutes from 10. */
function clockMinutes(minutes: number): string {
	const value = Math.max(0, minutes);
	return String(value < 10 ? Math.round(value * 10) / 10 : Math.round(value));
}

/** A wall-clock time in UTC to the minute (as `date -u` shows it, without seconds), with its date when that is not `from`'s. */
function utcAt(ms: number, from: number): string {
	const iso = new Date(ms).toISOString();
	return `${iso.slice(11, 16)} UTC${iso.slice(0, 10) === new Date(from).toISOString().slice(0, 10) ? "" : ` on ${iso.slice(0, 10)}`}`;
}

/**
 * The first lines of a new run with a time budget (team.ts): a child can't see
 * a clock and guesses its time used far too high, so it gets the wall-clock
 * start and end, and how to read the time. Not in the system prompt: a time
 * there would change it each run and break prompt caching.
 */
export function runClockHead(options: { now: number; minutes: number; notes?: boolean }): string {
	const { now, minutes } = options;
	const start = new Date(now).toISOString();
	const notes = options.notes ? " Notes during the run give the time now and the work minutes used and left." : "";
	return `[Budget clock] This run started at ${start.slice(11, 16)} UTC on ${start.slice(0, 10)} with a time budget of ${minutes} work minutes. If you do not wait, the budget ends at ${utcAt(now + minutes * MINUTE_MS, now)}. Call the ${CLOCK_TOOL} tool to see the time now and the work minutes left. Do not estimate the time from the work you did.${notes}`;
}

/** The child tool that reads the time (tools.ts): every child has it, a read-only one included, so none needs a shell for `date -u`. */
export const CLOCK_TOOL = "clock";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What the clock tool says: the time now to the second, and where the run stands in its time budget. */
export function clockText(options: { now: number; clock?: { usedMs: number; minutes: number } }): string {
	const { now, clock } = options;
	const iso = new Date(now).toISOString();
	const head = `Now ${iso.slice(11, 19)} UTC on ${iso.slice(0, 10)} (${WEEKDAYS[new Date(now).getUTCDay()]}).`;
	return clock ? `${head} ${budgetStand(now, clock.usedMs, clock.minutes)}` : `${head} This run has no time budget.`;
}

/** Work minutes used and left, and the end on the wall clock if the run does not wait. */
function budgetStand(now: number, usedMs: number, minutes: number): string {
	const left = Math.max(0, minutes - usedMs / MINUTE_MS);
	return `${clockMinutes(usedMs / MINUTE_MS)} of ${minutes} work minutes used, ${clockMinutes(left)} left. If you do not wait, the budget ends at ${utcAt(now + left * MINUTE_MS, now)}.`;
}

/** "Now 18:40 UTC.", to the minute as the budget times are. */
const nowAt = (now: number): string => `Now ${new Date(now).toISOString().slice(11, 16)} UTC.`;

/**
 * Where a run stands in its time budget (budget.ts): at a share of it, after
 * a wait (which moves the end on the wall clock), or as a run goes on. The
 * last note of a run asks it to plan its report.
 */
export function clockNote(options: { now: number; usedMs: number; minutes: number; plan?: boolean }): string {
	const { now, usedMs, minutes } = options;
	return `[Budget clock] ${nowAt(now)} ${budgetStand(now, usedMs, minutes)}${options.plan ? ` ${PLAN_TO_REPORT}` : ""}`;
}

/** The note a run gets near the end of its cost budget: `left` dollars of `limit`. */
export function costNote(left: number, limit: number, now: number): string {
	return `${nowAt(now)} About $${formatMoney(Math.max(0, left))} is left of this run's $${formatMoney(limit)} cost budget. ${PLAN_TO_REPORT}`;
}

/** Each tool call's result while a run wraps up at its budget (wrap-up.ts). */
export const BUDGET_BLOCKED = "Blocked: this run's budget is used up. Do not call tools. Write your final report now.";

/** A subagent stopped when its parent reached its budget, as it was then. */
export interface StoppedSubagent {
	readonly name: string;
	readonly state: string;
	readonly sessionFile?: string;
}

/** What a run at its budget is asked once its loop ended: its report, at once and from what it has. */
export function wrapUpPrompt(options: { reason: string; parent: string; subagents: readonly StoppedSubagent[] }): string {
	const budget = budgetWords(options.reason).replace(/^its /, "");
	const stopped = options.subagents.map((entry) => `${entry.name} (${entry.state}${entry.sessionFile ? `; session ${entry.sessionFile}` : ""})`);
	return [
		`Your ${budget} for this run is used up. Do not call tools; they are blocked. Write your final report to ${options.parent} now, from what you have: what is done (with evidence), what is not done or not verified, what you leave behind (uncommitted edits, worktrees, running processes), and the next steps to finish.`,
		...(stopped.length > 0 ? [`Your subagents were stopped: ${stopped.join(", ")}.`] : []),
	].join(" ");
}

/** What the child is told of its run's budgets up front; none without one. */
function budgetSection(budget: RunLimits | undefined): string[] {
	const limits = [
		...(budget?.minutes !== undefined ? [`work ${budget.minutes} minutes`] : []),
		...(budget?.cost !== undefined ? [`spend $${formatMoney(budget.cost)}`] : []),
	];
	if (limits.length === 0) return [];
	// The same text each run: the times themselves come in the run's first prompt (runClockHead).
	const time = budget?.minutes !== undefined ? [
		"Time counts only while you work, not while you wait for an answer, for your subagents or for a free slot.",
		"The first message of each run gives its start time and the time its budget ends if you do not wait.",
		`The ${CLOCK_TOOL} tool gives the time now and the work minutes left.`,
	] : [];
	const cost = budget?.cost !== undefined ? ["Near the end of the cost budget you get a note."] : [];
	return ["", "## Budget", [`This run may ${limits.join(" and ")}.`, ...time, ...cost, "At the limit, tool calls are blocked and you must write your final report at once."].join(" ")];
}

/** Appended to a child's system prompt. */
export function childInstructions(options: {
	name: string;
	parent: string;
	readOnly: boolean;
	canSpawn: boolean;
	worktree?: Worktree;
	roster: string;
	/** Main's conversation, for a forked child. */
	conversation?: string;
	/** Each run's limits, fixed at spawn (budget.ts). */
	budget?: RunLimits;
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
		`- In a review or fix loop, message the other agent by name with expectReply: true, so your report waits for its answer, and report to ${parent} only when the loop ends.`,
		"- Messages to you arrive between your tool calls.",
		`- A message from ${parent} is an instruction from the agent you work for. Follow it; where it conflicts with your task, it wins.`,
		...(options.worktree ? ["", "## Workspace",
			`You work in a git worktree at ${options.worktree.path} on branch ${options.worktree.branch}, based on your parent's current files.`,
			`Edit only inside ${options.worktree.path}. Committing there is optional. Do not edit the parent's checkout.`,
		] : []),
		...(options.readOnly ? ["", "## Read-only", "Do not modify files, run commands that change state, or make other side effects."] : []),
		...(options.canSpawn ? ["", "## Your own subagents", "You may start subagents with the subagent tool. You are not done until they report back; their reports arrive as messages."] : []),
		...budgetSection(options.budget),
		"",
		"## Team right now",
		options.roster,
		...(options.conversation ? ["", `## ${MAIN}'s conversation so far (condensed; tool output omitted)`, options.conversation] : []),
	].join("\n");
}
