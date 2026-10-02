/**
 * Transcript rows for subagent tools and messages. Everything an agent says
 * or does reads like someone in a conversation (band/agent-look.ts): a ◆
 * and its name in its provider's color, no band behind it, the facts close after the name
 * and what it said set in under it. Shell jobs are bands, so the two never
 * look alike.
 *
 * - A `subagent` row is the agent joining: `◆ name joined`, its model, where
 *   it is, and its task under it. It stays still while the agent works in
 *   the background (the widget is what moves). While main waits on it, the
 *   row is the agent's only presence, the same line as its row above the
 *   editor, and its report follows when it ends.
 * - A `message` row says who it went to and what happened to it.
 * - Agent mail reads like the agent speaking; a question keeps its amber `asks`.
 * - A report is the agent speaking last: `◆ name reported`, what the run took,
 *   and the first lines of the report under it; a click shows all of it.
 */
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { AGENT_HUE, AVATAR, AVATAR_HOLLOW, agentBody, agentHue, agentLine, avatarOf, spaced } from "../band/agent-look.ts";
import { expandable, expansionMemory, markdownOf, type MarkdownSource } from "../band/message.ts";
import { formatTime, timeSeg, type Motion, type Seg } from "../band/band.ts";
import { FAILURE_GLYPH } from "../band/glyph.ts";
import { formatMoney } from "../status-plus-logic.ts";
import { formatTokens } from "../status-plus-render.ts";
import type { MailDetails, ReportSummary } from "./deliver.ts";
import { noReport, reportBody } from "./format.ts";
import { MAIN } from "./names.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";
import { modelText, presenceLine, shortModel } from "./widget.ts";

export type { MarkdownSource } from "../band/message.ts";

export const REPORT_PREVIEW_LINES = 3;
export const MESSAGE_PREVIEW_LINES = 8;
const SEP: Seg = { text: " · ", color: "dim" };

/** An agent by name, while this session knows it. */
type Lookup = (name: string) => AgentRecord | undefined;
const NOBODY: Lookup = () => undefined;

type RowContext = { state?: unknown; isPartial?: boolean; executionStarted?: boolean; argsComplete?: boolean; isError?: boolean; expanded?: boolean } | undefined;
/** Whether the model is streaming a reply now (lib/run-watch.ts). Absent: always. */
type Streaming = () => boolean;
const ALWAYS: Streaming = () => true;

/** Notes, when Pi first builds a call's row, whether the model is writing it now. */
function noteLive(context: RowContext, streaming: Streaming): void {
	const state = context?.state as { live?: boolean } | undefined;
	if (state && typeof state === "object" && state.live === undefined) state.live = streaming();
}

class Lines implements Component {
	private readonly draw: (width: number) => string[];
	constructor(draw: (width: number) => string[]) { this.draw = draw; }
	render(width: number): string[] { return this.draw(Math.max(1, width)); }
	invalidate(): void {}
}

const oneLine = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim();
const joined = (parts: readonly Seg[]): Seg[] => parts.flatMap((part, index) => (index === 0 ? [part] : [SEP, part]));

/** `◆ name` in the agent's color, then a word for what happened and anything after it. */
function who(name: string, word: Seg | undefined, rest: readonly Seg[] = [], avatar = AVATAR, hue = AGENT_HUE): Seg[] {
	return [{ text: `${avatar} `, color: hue, bold: true }, { text: name, color: hue, bold: true }, ...(word ? [{ ...word, text: ` ${word.text}` }] : []), ...rest];
}

/** `→ name`: what you or main send an agent, in the color of the agent it goes to. */
const arrowTo = (name: string, hue: string): Seg[] => [{ text: "→ ", color: hue, bold: true }, { text: name, color: hue, bold: true }];

/** A line under an agent's name, set in to start where the name does. */
function under(theme: Theme, width: number, segs: readonly Seg[]): string {
	return agentLine(theme, [{ text: "  ", color: "dim" }, ...segs], width);
}

/** A shared row-state slot: the result names the agent, the call row reads it. */
export function rememberAgent(context: RowContext, details: unknown): void {
	const state = context?.state;
	const name = (details as { name?: unknown } | undefined)?.name;
	if (state && typeof state === "object" && typeof name === "string") (state as { agent?: string }).agent = name;
}

const agentOf = (context: RowContext): string | undefined => (context?.state as { agent?: string } | undefined)?.agent;

/** Where an agent is, last on the row it joined with; how it ended and the run's time once it has. */
function joinStatus(record: AgentRecord, now: number): Seg[] {
	const took = record.startedAt === undefined ? [] : [SEP, timeSeg((record.endedAt ?? now) - record.startedAt)];
	switch (record.state) {
		case "queued": return [{ text: "queued", color: "dim" }];
		case "starting": case "running": return [{ text: "working", color: "muted" }];
		case "asking": return [{ text: record.activity ?? "asking", color: "warning" }];
		case "waiting": return [{ text: "waiting on its subagents", color: "muted" }];
		case "interrupted": return [{ text: "interrupted", color: "warning" }];
		// Not "reported": its report can still be on its way to main, and this row can't tell.
		case "idle": return [{ text: "finished", color: "muted" }, ...took];
		case "failed": return [{ text: `${FAILURE_GLYPH} failed`, color: "error" }, ...took];
		case "stopped": return [{ text: "stopped", color: "muted" }, ...took];
	}
}

export function subagentCallRow(args: unknown, theme: Theme, context: RowContext, lookup: Lookup, streaming = ALWAYS, motion: () => Motion = () => "full"): Component {
	noteLive(context, streaming);
	const input = (args ?? {}) as { task?: unknown; name?: unknown; model?: unknown; thinking?: unknown; wait?: unknown };
	return new Lines((width) => {
		const now = Date.now();
		const name = agentOf(context);
		const record = name ? lookup(name) : undefined;
		const title = record?.name ?? (oneLine(input.name) || "subagent");
		const model: Seg[] = [{ text: record ? modelText(record) : oneLine(input.model), color: "dim" }];
		// Before it joins, a short model name says no provider; the agent takes its color when it does.
		const hue = agentHue(record?.model ?? oneLine(input.model));
		const waited = record?.blocking === true || input.wait === true;
		// Expanded, the row shows the whole task the line under the name cuts short.
		const task = (): string[] => {
			const text = typeof input.task === "string" ? input.task : "";
			if (context?.expanded && text) return agentBody(theme, width, text, "muted", null);
			return text ? [under(theme, width, [{ text: oneLine(text), color: "muted" }])] : [];
		};
		if (context?.isPartial && !context.executionStarted) {
			return [agentLine(theme, spaced(who(title, undefined, [], AVATAR_HOLLOW, hue), model), width), ...task()];
		}
		if (!record) {
			const where: Seg[] = context?.isError ? [{ text: `${FAILURE_GLYPH} not started`, color: "error" }] : [{ text: "background", color: "dim" }];
			return [agentLine(theme, spaced(who(title, waited ? undefined : { text: "joined", color: "muted" }, [], AVATAR, hue), model, where), width), ...task()];
		}
		// While main waits, the row is the agent's presence, as above the editor.
		if (waited && LIVE_STATES.has(record.state)) return [presenceLine(theme, { record, depth: 0 }, width, now, motion())];
		const word: Seg | undefined = waited ? undefined : { text: "joined", color: "muted" };
		// A waited-on row's report follows it; its task only shows when asked for.
		const shown = waited && !context?.expanded ? [] : task();
		return [agentLine(theme, spaced(who(record.name, word, [], avatarOf(record), hue), model, joinStatus(record, now)), width), ...shown];
	});
}

export function subagentResultRow(result: unknown, theme: Theme, context: RowContext, markdown?: MarkdownSource): Component {
	const details = (result as { details?: { wait?: unknown; report?: unknown; detached?: unknown; asked?: unknown } } | null)?.details;
	rememberAgent(context, details);
	const text = ((result as { content?: Array<{ text?: string }> } | null)?.content ?? []).map((part) => part.text ?? "").join("\n");
	return new Lines((width) => {
		if (context?.isError) return agentBody(theme, width, text, "error", null);
		// Progress is drawn live in the call row; a partial result would lag behind it.
		if (context?.isPartial) return [];
		// The row above already says who, model, cost and time; the model's header would repeat it.
		if (details?.detached === true) {
			const why = details.asked === true ? "It asked you something, so the wait ended. Its report will arrive as a message."
				: "You stopped waiting. It keeps running, and its report will arrive as a message.";
			return agentBody(theme, width, why, "muted", null);
		}
		if (details?.wait === true) {
			const report = typeof details.report === "string" ? details.report : reportBody(text);
			return agentBody(theme, width, report, "customMessageText", context?.expanded ? null : REPORT_PREVIEW_LINES + 2, markdownOf(markdown));
		}
		// What a background start says is for the model; the call row carries everything the user needs.
		return [];
	});
}

const DELIVERED: Record<string, string> = { steered: "delivered", resumed: "resumed it", queued: "queued", inbox: "for its next run", replied: "answered", main: "delivered" };

export function messageCallRow(args: unknown, theme: Theme, context: RowContext, streaming = ALWAYS, lookup: Lookup = NOBODY): Component {
	noteLive(context, streaming);
	const input = (args ?? {}) as { to?: unknown; text?: unknown; expectReply?: unknown };
	return new Lines((width) => {
		const to = arrowTo(oneLine(input.to), agentHue(lookup(oneLine(input.to))?.model));
		const text: Seg[] = [{ text: oneLine(input.text), color: "muted" }];
		if (context?.isPartial && !context.executionStarted) return [agentLine(theme, spaced(to, text), width)];
		const delivered = (context?.state as { delivered?: string } | undefined)?.delivered;
		const word = (delivered && DELIVERED[delivered]) || "";
		// What became of it comes before the text, so a long message is what gets cut.
		const status: Seg[] = context?.isError ? [{ text: "not delivered", color: "error" }]
			: [...(word ? [{ text: word, color: "dim" }] : []), ...(input.expectReply ? [{ text: `${word ? " · " : ""}awaits answer`, color: "warning" }] : [])];
		return [agentLine(theme, spaced(to, status, text), width)];
	});
}

export function messageResultRow(result: unknown, theme: Theme, context: RowContext): Component {
	const details = (result as { details?: { delivered?: unknown } } | null)?.details;
	const state = context?.state;
	if (state && typeof state === "object" && typeof details?.delivered === "string") (state as { delivered?: string }).delivered = details.delivered;
	const text = ((result as { content?: Array<{ text?: string }> } | null)?.content ?? []).map((part) => part.text ?? "").join("\n");
	return new Lines((width) => (context?.isError ? agentBody(theme, width, text, "error", null) : context?.expanded ? agentBody(theme, width, text, "muted", null) : []));
}

export function createMessageRenderer(markdown?: MarkdownSource, lookup: Lookup = NOBODY): MessageRenderer {
	const memory = expansionMemory();
	return (message, options, theme) => {
		const details = message.details as MailDetails | undefined;
		if (!details || details.kind === "report") return undefined;
		const question = details.kind === "question";
		const to = details.kind === "relay" ? details.to : MAIN;
		const said = question ? "asks" : details.kind === "reply" ? "answers" : details.kind === "relay" ? (details.answered ? "you answered" : "you wrote") : "note";
		// You are no agent: what you wrote to one reads like main's own messages, an arrow to it.
		const hueOf = (name: string) => agentHue(lookup(name)?.model);
		const left: Seg[] = details.kind === "relay" ? arrowTo(to, hueOf(to))
			: who(details.from, undefined, [{ text: ` → ${to}`, color: "dim" }], AVATAR, hueOf(details.from));
		return expandable((width, expanded) => [agentLine(theme, spaced(left, [{ text: said, color: question ? "warning" : "dim" }]), width),
			...agentBody(theme, width, details.text, "customMessageText", expanded ? null : MESSAGE_PREVIEW_LINES, markdownOf(markdown))],
			options.expanded, message as object, memory);
	};
}

function reportWord(report: ReportSummary): Seg {
	if (report.state === "failed") return { text: `${FAILURE_GLYPH} failed`, color: "error" };
	if (report.state === "stopped") return { text: "stopped", color: "muted" };
	return { text: report.state === "idle" ? "reported" : report.state, color: "muted" };
}

function reportLines(theme: Theme, width: number, report: ReportSummary, expanded: boolean, markdown?: MarkdownTheme): string[] {
	const took = report.startedAt !== undefined && report.endedAt !== undefined ? formatTime(report.endedAt - report.startedAt) : "";
	const head = spaced(
		who(report.name, reportWord(report), [], AVATAR, agentHue(report.model)),
		took ? [{ text: took, color: "text" }] : [],
		[{ text: shortModel(report.model), color: "dim" }],
		joined([
			...(report.cost > 0 ? [{ text: `$${formatMoney(report.cost)}`, color: "dim" }] : []),
			...(report.tokens ? [{ text: `${formatTokens(report.tokens.input)} in · ${formatTokens(report.tokens.output)} out`, color: "dim" }] : []),
		]),
		report.answered ? [{ text: "answered above", color: "dim" }] : [],
	);
	// An answered run with no final text has nothing to unfold.
	const text = report.state === "failed" ? report.error ?? "failed" : report.report ?? (report.answered ? "" : noReport(report.state));
	// An answered run's text is already on screen as its reply; the header alone says what the run took.
	const limit = expanded ? null : report.answered ? 0 : REPORT_PREVIEW_LINES;
	const said = agentBody(theme, width, text, report.state === "failed" ? "error" : "customMessageText", limit, report.state === "failed" ? undefined : markdown);
	const session = expanded && report.sessionFile ? [under(theme, width, [{ text: `session ${report.sessionFile}`, color: "dim" }])] : [];
	return [agentLine(theme, head, width), ...said, ...session];
}

export function createReportRenderer(markdown?: MarkdownSource): MessageRenderer {
	const memory = expansionMemory();
	return (message, options, theme) => {
		const details = message.details as MailDetails | undefined;
		if (!details || details.kind !== "report" || !Array.isArray(details.reports)) return undefined;
		// With no band to tell them apart, reports that arrive together keep a blank line between them.
		return expandable((width, expanded) => details.reports.flatMap((report, index) => [...(index > 0 ? [""] : []), ...reportLines(theme, width, report, expanded, markdownOf(markdown))]),
			options.expanded, message as object, memory);
	};
}
