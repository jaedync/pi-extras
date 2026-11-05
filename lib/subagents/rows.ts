/**
 * One agent's row, as the widget, the agents view, the transcript rows and
 * the inspector draw it: its presence (its ◆ and name in its color), how long
 * it has run, how full its context is, what it has cost, its model, then what
 * it is doing. Pure: no timers, no UI (widget.ts holds those).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatTime, type Motion, type Seg } from "../band/band.ts";
import { agentHue, agentLine, avatarOf, doingGlyph, doingOf, endGlyph, spaced } from "../band/agent-look.ts";
import { formatMoney } from "../status-plus-logic.ts";
import { compactionMark, contextHeat, formatTokens } from "../status-plus-render.ts";
import { contextShare } from "../compaction-point.ts";
import { MAIN } from "./names.ts";
import { type AgentRecord, type AgentState, LIVE_STATES, neverStarted, WAITING_FOR_MODEL } from "./types.ts";

/** One agent's row, at its depth under its parent. */
export interface AgentRow {
	record: AgentRecord;
	depth: number;
	/** Finished, with its report not yet delivered to main. */
	reportQueued?: boolean;
}

export const shortModel = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

/**
 * Live agents and those whose report is still queued, parents before children.
 * A child main is blocked on already has its own row in the transcript.
 */
export function agentRows(records: readonly AgentRecord[], reportPending: ReadonlySet<string>): AgentRow[] {
	return treeRows(records.filter((record) => (LIVE_STATES.has(record.state) || record.state === "interrupted" || reportPending.has(record.name)) && !(record.parent === MAIN && record.blocking)), reportPending);
}

/** Every agent in the session, parents before children, for the agents view. */
export const teamRows = (records: readonly AgentRecord[], reportPending: ReadonlySet<string>): AgentRow[] => treeRows(records, reportPending);

function treeRows(visible: readonly AgentRecord[], reportPending: ReadonlySet<string>): AgentRow[] {
	const byParent = new Map<string, AgentRecord[]>();
	for (const record of visible) byParent.set(record.parent, [...(byParent.get(record.parent) ?? []), record]);
	const shown = new Set(visible.map((record) => record.name));
	const ordered: AgentRow[] = [];
	const rowOf = (record: AgentRecord, depth: number): AgentRow => ({ record, depth, reportQueued: reportPending.has(record.name) });
	const walk = (parent: string, depth: number) => {
		for (const record of byParent.get(parent) ?? []) {
			ordered.push(rowOf(record, depth));
			walk(record.name, depth + 1);
		}
	};
	walk(MAIN, 0);
	// A visible child whose parent is not shown still gets a row, at its own depth: main's wait: true child has its row in the transcript.
	for (const record of visible) if (record.parent !== MAIN && !shown.has(record.parent)) {
		const depth = Math.max(0, record.depth - 1);
		ordered.push(rowOf(record, depth));
		walk(record.name, depth + 1);
	}
	return ordered;
}

function statusWords(record: AgentRecord, reportQueued: boolean): Seg {
	switch (record.state) {
		case "asking": return { text: record.activity ?? `asking ${record.askingWho ?? ""}`, color: "warning" };
		// Only the widget knows whether the report has reached main; elsewhere, finished is what is sure.
		case "idle": return { text: reportQueued ? "report queued" : "finished", color: "muted" };
		case "failed": return { text: record.error ? `failed: ${record.error}` : "failed", color: "error" };
		case "stopped": return { text: neverStarted(record) ? "cancelled while queued" : "stopped", color: "muted" };
		case "interrupted": return { text: `interrupted${record.activity ? `: ${record.activity}` : ""}`, color: "warning" };
		// A running agent whose session has reported nothing yet waits for its model, as its spinner says.
		default: return { text: record.activity ?? (record.state === "running" ? WAITING_FOR_MODEL.activity : ""), color: "muted" };
	}
}

const nestText = (depth: number) => (depth > 0 ? `${"  ".repeat(depth - 1)}└ ` : "");

/** `◆ name` in its provider's color, hollow until it has begun; children sit under their parent. `width` pads the name for a column. */
export function nameSegs(record: AgentRecord, depth = 0, width = 0): Seg[] {
	const nest = nestText(depth);
	const hue = agentHue(record.model);
	return [
		...(nest ? [{ text: nest, color: "dim" }] : []),
		{ text: `${avatarOf(record)} `, color: hue, bold: true },
		{ text: record.name.padEnd(Math.max(0, width - nest.length)), color: hue, bold: true },
	];
}

/** Column widths that line rows up: the widest nested name, run time, context tokens and percent, spend and model among them. */
export interface RowColumns {
	readonly name: number;
	readonly time: number;
	readonly tokens: number;
	readonly percent: number;
	readonly compactions: number;
	readonly cost: number;
	readonly model: number;
}

const NO_COLUMNS: RowColumns = { name: 0, time: 0, tokens: 0, percent: 0, compactions: 0, cost: 0, model: 0 };

export function rowColumns(rows: readonly AgentRow[], now = 0): RowColumns {
	const widest = (width: (row: AgentRow) => number) => Math.max(0, ...rows.map(width));
	return {
		name: widest((row) => nestText(row.depth).length + row.record.name.length),
		time: widest((row) => runTime(row.record, now)?.length ?? 0),
		tokens: widest((row) => contextFigures(row.record)?.tokens.length ?? 0),
		percent: widest((row) => contextFigures(row.record)?.percent.length ?? 0),
		compactions: widest((row) => compactionsText(row.record).length),
		cost: widest((row) => costText(row.record).length),
		model: widest((row) => modelText(row.record).length),
	};
}

/** How long an agent has run; none before it starts. */
export function runTime(record: AgentRecord, now: number): string | undefined {
	// Restored records saved before run starts were kept have only createdAt, as in format.ts.
	return record.state === "queued" ? undefined : formatTime((record.endedAt ?? now) - (record.startedAt ?? record.createdAt));
}

export interface ContextFigures {
	readonly tokens: string;
	readonly percent: string;
	readonly heat: "dim" | "warning" | "error";
}

/**
 * Its context size after the last reply and that size's share of the point
 * where its session compacts (the window for a record saved before points),
 * colored as main's footer colors its own: `?` after a compaction until the
 * next reply sizes it, nothing before its first reply. A finished agent keeps
 * its last size, which is what a resume starts from.
 */
export function contextFigures(record: Pick<AgentRecord, "contextTokens" | "contextWindow" | "compactAt">): ContextFigures | undefined {
	const { contextTokens: tokens } = record;
	const point = record.compactAt ?? record.contextWindow;
	if (!tokens) return point ? { tokens: "?", percent: "", heat: "dim" } : undefined;
	const share = contextShare(tokens, point);
	if (share === undefined) return { tokens: formatTokens(tokens), percent: "", heat: "dim" };
	return { tokens: formatTokens(tokens), percent: `${Math.round(share)}%`, heat: contextHeat(share) };
}

/** Tokens and percent, each right-aligned in its own column so the digits line up; only the percent warms. */
function contextCell(record: AgentRecord, columns: RowColumns): Seg[] {
	const figures = contextFigures(record);
	if (!figures && !columns.tokens) return [];
	const percent = (figures?.percent ?? "").padStart(columns.percent);
	return [
		{ text: (figures?.tokens ?? "").padStart(columns.tokens), color: "dim" },
		...(percent ? [{ text: " ", color: "dim" }, { text: percent, color: figures?.heat ?? "dim" }] : []),
	];
}

/** How often its session compacted, marked as main's footer marks its own; empty before the first. */
export const compactionsText = (record: AgentRecord): string => (record.compactions ? compactionMark(record.compactions) : "");

export const compactionWords = (count: number): string => `${count} ${count === 1 ? "compaction" : "compactions"}`;

/** What it has cost so far; empty while it is free. */
export const costText = (record: AgentRecord): string => (record.usage.cost > 0 ? `$${formatMoney(record.usage.cost)}` : "");

export const modelText = (record: AgentRecord): string => `${shortModel(record.model)}${record.thinking ? ` ${record.thinking}` : ""}`;

/** One column's cell: empty when neither this row nor any other has a value, so no row opens a hole. */
const cell = (text: string, width: number, color: string, align: "left" | "right"): Seg[] =>
	text || width ? [{ text: align === "right" ? text.padStart(width) : text.padEnd(width), color }] : [];

/**
 * Who, how long, how full, what it has cost and its model, then what it is doing (a
 * glyph that moves for the work, or how it ended, and the words). Past the
 * width the words go first, so the facts always show.
 */
export function rowSegs(row: AgentRow, now = 0, motion: Motion = "full", columns: RowColumns = NO_COLUMNS): Seg[] {
	const { record } = row;
	const doing = endGlyph(record.state) ?? doingGlyph(doingOf(record), now, motion, agentHue(record.model));
	return spaced(
		nameSegs(record, row.depth, columns.name),
		cell(runTime(record, now) ?? "", columns.time, "text", "right"),
		contextCell(record, columns),
		cell(compactionsText(record), columns.compactions, "dim", "left"),
		cell(costText(record), columns.cost, "dim", "right"),
		cell(modelText(record), columns.model, "dim", "left"),
		[{ text: doing.glyph, color: doing.color }, { text: " ", color: "dim" }, statusWords(record, row.reportQueued === true)],
	);
}

/** One agent's presence line; `columns` lines it up with the rows around it. */
export function presenceLine(theme: Theme, row: AgentRow, width: number, now: number, motion: Motion = "full", columns?: RowColumns): string {
	return agentLine(theme, rowSegs(row, now, motion, columns), width);
}

const STATE_WORDS: Record<AgentState, string> = {
	queued: "queued", starting: "starting", running: "running", asking: "asking", waiting: "waiting", idle: "finished", failed: "failed", stopped: "stopped", interrupted: "interrupted",
};

/** One line of the plain list `/subagents` prints where there is no full-terminal view, cut to `maxWidth`. */
export function listLabel(record: AgentRecord, nameWidth: number, now: number, maxWidth = Number.POSITIVE_INFINITY): string {
	const parts = [record.name.padEnd(nameWidth), `${STATE_WORDS[record.state]}${record.orphaned ? " (orphan)" : ""}`.padEnd(8), shortModel(record.model)];
	if (record.usage.cost > 0) parts.push(`$${formatMoney(record.usage.cost)}`);
	if (record.state !== "queued") parts.push(formatTime((record.endedAt ?? now) - (record.startedAt ?? record.createdAt)));
	const context = contextFigures(record);
	if (context) parts.push([context.tokens, context.percent].filter(Boolean).join(" "));
	if (record.compactions) parts.push(compactionWords(record.compactions));
	parts.push(record.task.replace(/\s+/g, " ").trim());
	const line = parts.join("  ");
	return line.length > maxWidth ? `${line.slice(0, Math.max(1, maxWidth - 1))}…` : line;
}
