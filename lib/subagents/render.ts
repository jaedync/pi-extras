/**
 * Transcript rows for subagent tools and messages. Background handoffs use
 * Shell Jobs' still chip; blocking work, expanded tasks and reports use bands.
 *
 * - A `subagent` row names the agent, its model and task. It stays calm while
 *   the agent works in the background (the widget is what moves). While main
 *   waits on it, the row is the agent's only row: it runs, carries the widget's
 *   rail, and shows what the agent is doing under it. It takes the final color
 *   when it ends.
 * - A `message` row says who it went to and what happened to it.
 * - A message from an agent is a band (amber for a question) over its text.
 * - A report is one band per agent, the first lines of the report under it;
 *   a click shows all of it.
 */
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { formatTime, renderBand, type BandPhase, type Seg } from "../band/band.ts";
import { paletteFrom } from "../band/palette.ts";
import { handoffChip, type ChipTint } from "../band/job-chip.ts";
import { bodyBackground, onBackground } from "../band/surface.ts";
import { formatMoney } from "../status-plus-logic.ts";
import { formatTokens } from "../status-plus-render.ts";
import type { MailDetails, ReportSummary } from "./deliver.ts";
import { noReport, reportBody } from "./format.ts";
import { MAIN, moreLines } from "./names.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";
import { phaseOf, rowRail, shortModel } from "./widget.ts";

/** Pi's Markdown theme when there is one; reports and messages are Markdown, like assistant text. */
export type MarkdownSource = () => MarkdownTheme | undefined;
const markdownOf = (source: MarkdownSource | undefined): MarkdownTheme | undefined => {
	try { return source?.(); } catch { return undefined; }
};

export const REPORT_PREVIEW_LINES = 3;
export const MESSAGE_PREVIEW_LINES = 8;
const BODY_INDENT = 3;
const DONE = Number.POSITIVE_INFINITY;

type RowContext = { state?: unknown; isPartial?: boolean; executionStarted?: boolean; isError?: boolean; expanded?: boolean } | undefined;

class Lines implements Component {
	private readonly draw: (width: number) => string[];
	constructor(draw: (width: number) => string[]) { this.draw = draw; }
	render(width: number): string[] { return this.draw(Math.max(1, width)); }
	invalidate(): void {}
}

const paintOf = (theme: Theme) => (color: string, text: string): string => {
	try { return theme.fg(color as never, text); } catch { return text; }
};
const oneLine = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim();

function band(theme: Theme, width: number, phase: BandPhase, segs: Seg[], rail: Seg[]): string {
	return renderBand(theme, paletteFrom(theme), { width, phase, segs, rail, clockMs: Date.now() });
}

/** Text under a band, on the tool background; `limit` lines unless expanded. */
function body(theme: Theme, width: number, text: string, color: string, limit: number | null, markdown?: MarkdownTheme): string[] {
	const trimmed = text.replace(/\r/g, "").trim();
	if (!trimmed) return [];
	const paint = paintOf(theme);
	const inner = Math.max(4, width - BODY_INDENT);
	const pad = " ".repeat(BODY_INDENT);
	const all = markdown
		? new Markdown(trimmed, 0, 0, markdown, { color: (line: string) => paint(color, line) }).render(inner).map((line) => line.trimEnd())
		: wrapTextWithAnsi(trimmed, inner).map((line) => paint(color, line));
	const shown = limit === null ? all : all.slice(0, limit);
	const lines = shown.map((line) => pad + truncateToWidth(line, inner, "…"));
	const hidden = all.length - shown.length;
	const count = shown.length > 0 ? moreLines(hidden) : `${hidden} line${hidden === 1 ? "" : "s"}`;
	if (hidden > 0) lines.push(pad + paint("dim", `… ${count} (click to show)`));
	return onBackground(lines, width, bodyBackground(theme));
}

/** One line of what an agent is doing, under its band. */
function activityLine(theme: Theme, width: number, text: string): string[] {
	const inner = Math.max(4, width - BODY_INDENT);
	return onBackground([" ".repeat(BODY_INDENT) + truncateToWidth(paintOf(theme)("muted", oneLine(text)), inner, "…")], width, bodyBackground(theme));
}

/** A shared row-state slot: the result names the agent, the call row reads it. */
export function rememberAgent(context: RowContext, details: unknown): void {
	const state = context?.state;
	const name = (details as { name?: unknown } | undefined)?.name;
	if (state && typeof state === "object" && typeof name === "string") (state as { agent?: string }).agent = name;
}

const agentOf = (context: RowContext): string | undefined => (context?.state as { agent?: string } | undefined)?.agent;

export function subagentCallRow(args: unknown, theme: Theme, context: RowContext, lookup: (name: string) => AgentRecord | undefined): Component {
	const input = (args ?? {}) as { task?: unknown; name?: unknown; model?: unknown; thinking?: unknown; wait?: unknown };
	// Expanded, the row shows the whole task the band cuts short.
	const task = (width: number) => (context?.expanded && typeof input.task === "string" ? body(theme, width, input.task, "muted", null) : []);
	return new Lines((width) => [...head(width), ...task(width)]);

	function head(width: number): string[] {
		const now = Date.now();
		const name = agentOf(context);
		const record = name ? lookup(name) : undefined;
		const model = record ? `${shortModel(record.model)}${record.thinking ? ` ${record.thinking}` : ""}` : oneLine(input.model);
		const segs: Seg[] = [
			{ text: record?.name ?? (oneLine(input.name) || "subagent"), color: "text", bold: true },
			...(model ? [{ text: `  ${model}`, color: "dim" }] : []),
			{ text: `  ${oneLine(input.task)}`, color: "muted" },
		];
		const compact = record && !record.blocking && input.wait !== true && !context?.expanded && !context?.isError;
		if (compact) return [agentChip(theme, width, record, segs, now)];
		if (context?.isPartial && !context.executionStarted) return [band(theme, width, { kind: "writing" }, segs, [])];
		if (context?.isError && !record) return [band(theme, width, { kind: "done", outcome: "fail", sinceMs: DONE }, segs, [{ text: "not started", color: "error" }])];
		if (!record) return [band(theme, width, { kind: "calm" }, segs, [{ text: "background", color: "dim" }])];
		if (LIVE_STATES.has(record.state)) {
			if (record.blocking) {
				const head = band(theme, width, phaseOf(record, now), segs, rowRail(record, now));
				return record.activity ? [head, ...activityLine(theme, width, record.activity)] : [head];
			}
			const where = record.state === "asking" ? record.activity ?? "asking" : record.state === "queued" ? "queued" : "in background";
			return [band(theme, width, { kind: "calm" }, segs, [{ text: where, color: record.state === "asking" ? "warning" : "dim" }])];
		}
		const word: Seg[] = record.state === "idle" ? [] : [{ text: record.state, color: record.state === "failed" ? "error" : "muted" }, { text: "  ", color: "dim" }];
		return [band(theme, width, phaseOf(record, now), segs, [...word, ...rowRail(record, now)])];
	}
}

function agentChip(theme: Theme, width: number, record: AgentRecord, title: Seg[], now: number): string {
	const live = LIVE_STATES.has(record.state);
	const phase = phaseOf(record, now);
	const tint: ChipTint = phase.kind === "done" ? phase.outcome : "running";
	const word = live ? record.state === "queued" ? "queued" : record.state === "asking" ? "asking" : "in background"
		: record.state === "idle" ? "done" : record.state;
	const color = tint === "fail" ? "error" : record.state === "asking" ? "warning" : "muted";
	const status: Seg[] = [{ text: word, color }, ...(!live ? [{ text: "  ", color: "dim" }, ...rowRail(record, now)] : [])];
	return handoffChip(theme, { width, title, status, tint, glyphColor: live ? "accent" : tint === "ok" ? "success" : color });
}

export function subagentResultRow(result: unknown, theme: Theme, context: RowContext, markdown?: MarkdownSource): Component {
	const details = (result as { details?: { wait?: unknown; report?: unknown; detached?: unknown; asked?: unknown } } | null)?.details;
	rememberAgent(context, details);
	const text = ((result as { content?: Array<{ text?: string }> } | null)?.content ?? []).map((part) => part.text ?? "").join("\n");
	return new Lines((width) => {
		if (context?.isError) return body(theme, width, text, "error", null);
		// Progress is drawn live in the call row; a partial result would lag behind it.
		if (context?.isPartial) return [];
		// The band above already says who, model, cost and time; the model's header would repeat it.
		if (details?.detached === true) {
			const why = details.asked === true ? "It asked you something, so the wait ended. Its report will arrive as a message."
				: "You stopped waiting. It keeps running, and its report will arrive as a message.";
			return body(theme, width, why, "muted", null);
		}
		if (details?.wait === true) {
			const report = typeof details.report === "string" ? details.report : reportBody(text);
			return body(theme, width, report, "toolOutput", context?.expanded ? null : REPORT_PREVIEW_LINES + 2, markdownOf(markdown));
		}
		// What a background start says is for the model; the call row carries everything the user needs.
		return [];
	});
}

const DELIVERED: Record<string, string> = { steered: "delivered", resumed: "resumed it", queued: "queued", inbox: "for its next run", replied: "answered", main: "delivered" };

export function messageCallRow(args: unknown, theme: Theme, context: RowContext): Component {
	const input = (args ?? {}) as { to?: unknown; text?: unknown; expectReply?: unknown };
	return new Lines((width) => {
		const segs: Seg[] = [{ text: `→ ${oneLine(input.to)}`, color: "text", bold: true }, { text: `  ${oneLine(input.text)}`, color: "muted" }];
		if (context?.isPartial && !context.executionStarted) return [band(theme, width, { kind: "writing" }, segs, [])];
		const delivered = (context?.state as { delivered?: string } | undefined)?.delivered;
		const rail: Seg[] = context?.isError ? [{ text: "not delivered", color: "error" }]
			: [{ text: (delivered && DELIVERED[delivered]) ?? "", color: "dim" }, ...(input.expectReply ? [{ text: "  awaits answer", color: "warning" }] : [])];
		return [band(theme, width, { kind: "done", outcome: context?.isError ? "fail" : "ok", sinceMs: DONE }, segs, rail)];
	});
}

export function messageResultRow(result: unknown, theme: Theme, context: RowContext): Component {
	const details = (result as { details?: { delivered?: unknown } } | null)?.details;
	const state = context?.state;
	if (state && typeof state === "object" && typeof details?.delivered === "string") (state as { delivered?: string }).delivered = details.delivered;
	const text = ((result as { content?: Array<{ text?: string }> } | null)?.content ?? []).map((part) => part.text ?? "").join("\n");
	return new Lines((width) => (context?.isError ? body(theme, width, text, "error", null) : context?.expanded ? body(theme, width, text, "muted", null) : []));
}

/** Per-message expansion toggled by a click; ctrl+O (the global flag) resets it. */
function expandable(render: (width: number, expanded: boolean) => string[], globalExpanded: boolean, key: object, memory: { overrides: WeakMap<object, boolean>; seen: WeakMap<object, boolean> }): Component {
	if (memory.seen.get(key) !== globalExpanded) {
		memory.overrides.delete(key);
		memory.seen.set(key, globalExpanded);
	}
	const expanded = () => memory.overrides.get(key) ?? globalExpanded;
	return {
		render: (width: number) => render(Math.max(1, width), expanded()),
		invalidate: () => {},
		handleMouse: (event: { type: string; button: string }) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			memory.overrides.set(key, !expanded());
			return { handled: true };
		},
	} as Component;
}

export function createMessageRenderer(markdown?: MarkdownSource): MessageRenderer {
	const memory = { overrides: new WeakMap<object, boolean>(), seen: new WeakMap<object, boolean>() };
	return (message, options, theme) => {
		const details = message.details as MailDetails | undefined;
		if (!details || details.kind === "report") return undefined;
		const question = details.kind === "question";
		const to = details.kind === "relay" ? details.to : MAIN;
		const segs: Seg[] = [{ text: details.from, color: "text", bold: true }, { text: ` → ${to}`, color: "dim" }];
		const said = question ? "asks" : details.kind === "reply" ? "answers" : details.kind === "relay" ? (details.answered ? "you answered" : "you wrote") : "note";
		const rail: Seg[] = [{ text: said, color: question ? "warning" : "dim" }];
		const phase: BandPhase = question ? { kind: "done", outcome: "timeout", sinceMs: DONE } : { kind: "calm" };
		return expandable((width, expanded) => [band(theme, width, phase, segs, rail), ...body(theme, width, details.text, "text", expanded ? null : MESSAGE_PREVIEW_LINES, markdownOf(markdown))],
			options.expanded, message as object, memory);
	};
}

function reportPhase(report: ReportSummary): BandPhase {
	const outcome = report.state === "idle" ? "ok" : report.state === "stopped" ? "aborted" : "fail";
	return { kind: "done", outcome, sinceMs: DONE };
}

function reportLines(theme: Theme, width: number, report: ReportSummary, expanded: boolean, markdown?: MarkdownTheme): string[] {
	const paint = paintOf(theme);
	const took = report.startedAt !== undefined && report.endedAt !== undefined ? formatTime(report.endedAt - report.startedAt) : "";
	const word = report.state === "idle" ? "finished" : report.state;
	const segs: Seg[] = [
		{ text: report.name, color: "text", bold: true }, { text: ` ${word}`, color: report.state === "failed" ? "error" : "muted" }, { text: `  ${shortModel(report.model)}`, color: "dim" },
		...(report.answered ? [{ text: "  answered above", color: "dim" }] : []),
	];
	const gap: Seg = { text: "  ", color: "dim" };
	const rail: Seg[] = [
		...(report.cost > 0 ? [{ text: `$${formatMoney(report.cost)}`, color: "dim" }, gap] : []),
		...(report.tokens ? [{ text: `${formatTokens(report.tokens.input)} in · ${formatTokens(report.tokens.output)} out`, color: "dim" }, gap] : []),
		{ text: took, color: "text" },
	];
	// An answered run with no final text has nothing to unfold.
	const text = report.state === "failed" ? report.error ?? "failed" : report.report ?? (report.answered ? "" : noReport(report.state));
	// An answered run's text is already on screen as its reply; the band alone says what the run took.
	const limit = expanded ? null : report.answered ? 0 : REPORT_PREVIEW_LINES;
	const under = body(theme, width, text, report.state === "failed" ? "error" : "toolOutput", limit, report.state === "failed" ? undefined : markdown);
	const session = expanded && report.sessionFile ? onBackground([" ".repeat(BODY_INDENT) + truncateToWidth(paint("dim", `session ${report.sessionFile}`), width - BODY_INDENT, "…")], width, bodyBackground(theme)) : [];
	return [band(theme, width, reportPhase(report), segs, rail), ...under, ...session];
}

export function createReportRenderer(markdown?: MarkdownSource): MessageRenderer {
	const memory = { overrides: new WeakMap<object, boolean>(), seen: new WeakMap<object, boolean>() };
	return (message, options, theme) => {
		const details = message.details as MailDetails | undefined;
		if (!details || details.kind !== "report" || !Array.isArray(details.reports)) return undefined;
		return expandable((width, expanded) => details.reports.flatMap((report) => reportLines(theme, width, report, expanded, markdownOf(markdown))),
			options.expanded, message as object, memory);
	};
}
