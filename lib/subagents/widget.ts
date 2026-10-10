/**
 * The subagents widget above the editor: one row per agent, children nested
 * under their parent, then any messages queued for main that Pi has not
 * appended yet. A row is the agent's presence, its ◆ and name in its color with
 * no band behind it (band/agent-look.ts): who it is, how long it has run,
 * how full its context is, what it has cost and its model, then what it is
 * doing right now (moving as
 * main's spinner does for the same work). What it is doing comes last because
 * it is the only part whose length has no bound, so a narrow terminal cuts it
 * and keeps the rest. Name, time, context, spend and model line up across
 * rows, so what each agent is doing starts in one column. A finished
 * agent keeps its row until its report is in the transcript. Past four
 * agents, the last line is a control line that opens the agents view or
 * expands the rows (overflow.ts).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatTime, type Motion, type Seg } from "../band/band.ts";
import { agentHue, agentLine, avatarOf, doingGlyph, doingOf, endGlyph, spaced } from "../band/agent-look.ts";
import { everyFrame } from "../band/clock.ts";
import { formatMoney } from "../status-plus-logic.ts";
import { contextHeat, formatTokens } from "../status-plus-render.ts";
import type { PendingItem } from "./deliver.ts";
import { MAIN } from "./names.ts";
import { COLLAPSED_ROWS, controlLine, expandedBudget, fitRows, shownCount, type ControlLine, type Span } from "./overflow.ts";
import { type AgentRecord, type AgentState, LIVE_STATES, WAITING_FOR_MODEL } from "./types.ts";

export const WIDGET_ID = "subagents";
export const MAX_PENDING_ROWS = 3;

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
	// A visible child whose parent is not shown still gets a row.
	for (const record of visible) if (record.parent !== MAIN && !shown.has(record.parent)) {
		ordered.push(rowOf(record, 0));
		walk(record.name, 1);
	}
	return ordered;
}

function statusWords(record: AgentRecord, reportQueued: boolean): Seg {
	switch (record.state) {
		case "asking": return { text: record.activity ?? `asking ${record.askingWho ?? ""}`, color: "warning" };
		// Only the widget knows whether the report has reached main; elsewhere, finished is what is sure.
		case "idle": return { text: reportQueued ? "report queued" : "finished", color: "muted" };
		case "failed": return { text: record.error ? `failed: ${record.error}` : "failed", color: "error" };
		case "stopped": return { text: "stopped", color: "muted" };
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
	readonly cost: number;
	readonly model: number;
}

const NO_COLUMNS: RowColumns = { name: 0, time: 0, tokens: 0, percent: 0, cost: 0, model: 0 };

export function rowColumns(rows: readonly AgentRow[], now = 0): RowColumns {
	const widest = (width: (row: AgentRow) => number) => Math.max(0, ...rows.map(width));
	return {
		name: widest((row) => nestText(row.depth).length + row.record.name.length),
		time: widest((row) => runTime(row.record, now)?.length ?? 0),
		tokens: widest((row) => contextFigures(row.record)?.tokens.length ?? 0),
		percent: widest((row) => contextFigures(row.record)?.percent.length ?? 0),
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
 * Its context size after the last reply and that size's share of the model's
 * window, colored as main's footer colors its own: `?` after a compaction
 * until the next reply sizes it, nothing before its first reply. A finished
 * agent keeps its last size, which is what a resume starts from.
 */
export function contextFigures(record: Pick<AgentRecord, "contextTokens" | "contextWindow">): ContextFigures | undefined {
	const { contextTokens: tokens, contextWindow: window } = record;
	if (!tokens) return window ? { tokens: "?", percent: "", heat: "dim" } : undefined;
	if (!window) return { tokens: formatTokens(tokens), percent: "", heat: "dim" };
	const share = (100 * tokens) / window;
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
	parts.push(record.task.replace(/\s+/g, " ").trim());
	const line = parts.join("  ");
	return line.length > maxWidth ? `${line.slice(0, Math.max(1, maxWidth - 1))}…` : line;
}

export function pendingLines(items: readonly PendingItem[]): Array<{ text: string; color: string }> {
	const messages = items.filter((item) => item.kind !== "report");
	const lines = messages.slice(0, MAX_PENDING_ROWS).map((item) => {
		const mark = item.kind === "question" ? "?" : "↳";
		const text = item.text.replace(/\s+/g, " ").trim();
		if (item.kind === "relay") return { text: `${mark} ${item.from} ${text}`, color: "dim" };
		return { text: `${mark} ${item.from} → ${MAIN}: ${text}`, color: item.kind === "question" ? "warning" : "dim" };
	});
	if (messages.length > MAX_PENDING_ROWS) lines.push({ text: `+${messages.length - MAX_PENDING_ROWS} more queued for ${MAIN}`, color: "dim" });
	return lines;
}

interface TuiHost { requestRender(): void; readonly terminal?: { readonly rows?: number } }
interface WidgetUi { setWidget(id: string, content: unknown, options?: unknown): void }
interface MouseEvent { type: string; button: string; x: number; y: number }

/** What the last frame drew where, so a click lands on what was under it. */
interface Layout {
	readonly rows: readonly AgentRow[];
	readonly control: (ControlLine & { readonly y: number }) | null;
}

const inSpan = (x: number, span: Span) => x >= span[0] && x < span[1];

export interface AgentsWidget {
	/** `onSelect` opens one agent's inspector; `onView` opens the view of them all. */
	attach(ui: WidgetUi, source: () => { records: AgentRecord[]; pending: PendingItem[] }, onSelect?: (name: string) => void, onView?: () => void): void;
	update(): void;
	detach(): void;
}


/** `motion` is Tool Display's setting, read each frame: reduced holds what agents are doing still. */
export function createAgentsWidget(motion: () => Motion = () => "full"): AgentsWidget {
	let ui: WidgetUi | null = null;
	let source: (() => { records: AgentRecord[]; pending: PendingItem[] }) | null = null;
	let onSelect: ((name: string) => void) | null = null;
	let onView: (() => void) | null = null;
	let tui: TuiHost | null = null;
	let shown = false;
	// Until collapsed again or every agent is gone; the next batch starts collapsed.
	let expanded = false;
	let stopFrames: (() => void) | null = null;
	let layout: Layout = { rows: [], control: null };

	const snapshot = () => source?.() ?? { records: [], pending: [] };
	const reportPending = (pending: readonly PendingItem[]) =>
		new Set(pending.filter((item) => item.kind === "report").flatMap((item) => item.from.split(", ")));

	const factory = (host: TuiHost, theme: Theme) => {
		tui = host;
		return {
			render: (width: number) => {
				const { records, pending } = snapshot();
				const all = agentRows(records, reportPending(pending));
				const mail = pendingLines(pending);
				const budget = expandedBudget(host.terminal?.rows ?? process.stdout.rows ?? 40, mail.length);
				// A terminal too short to give the rows more room has nothing to expand into.
				const roomy = shownCount(all.length, true, budget) !== shownCount(all.length, false, budget);
				const { shown: rows, hidden } = fitRows(all, shownCount(all.length, expanded && roomy, budget));
				const now = Date.now();
				const columns = rowColumns(rows, now);
				const lines = rows.map((row) => presenceLine(theme, row, width, now, motion(), columns));
				const toggle = roomy ? (expanded ? "collapse" : "expand") : null;
				const control = all.length > COLLAPSED_ROWS ? { ...controlLine(hidden, all.length, toggle, width), y: lines.length } : null;
				if (control) lines.push(agentLine(theme, control.segs, width));
				layout = { rows, control };
				// Mail still on its way to main, cut to the width like any agent line.
				for (const line of mail) lines.push(agentLine(theme, [{ text: line.text, color: line.color }], width));
				return lines;
			},
			invalidate: () => {},
			handleMouse: (event: MouseEvent) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				const row = layout.rows[event.y];
				if (row && onSelect) {
					onSelect(row.record.name);
					return { handled: true };
				}
				const control = layout.control;
				if (!control || event.y !== control.y) return undefined;
				if (control.toggle && inSpan(event.x, control.toggle)) {
					expanded = !expanded;
					return { handled: true, render: true };
				}
				if (onView && (inSpan(event.x, control.view) || inSpan(event.x, control.more))) {
					onView();
					return { handled: true };
				}
				return undefined;
			},
		};
	};

	const setWidget = (content: unknown) => {
		try { ui?.setWidget(WIDGET_ID, content); } catch { /* stale context after a session switch */ }
	};
	const stopTimer = () => { stopFrames?.(); stopFrames = null; };

	return {
		attach(nextUi, nextSource, select, view) {
			ui = nextUi;
			source = nextSource;
			onSelect = select ?? null;
			onView = view ?? null;
			shown = false;
			expanded = false;
			stopTimer();
			this.update();
		},
		update() {
			if (!ui || !source) return;
			const { records, pending } = snapshot();
			const anything = agentRows(records, reportPending(pending)).length > 0 || pendingLines(pending).length > 0;
			if (!anything) {
				expanded = false;
				if (shown) setWidget(undefined);
				shown = false;
				stopTimer();
				return;
			}
			if (!shown) {
				setWidget(factory);
				shown = true;
			} else {
				tui?.requestRender();
			}
			if (records.some((record) => LIVE_STATES.has(record.state))) {
				stopFrames ??= everyFrame(() => tui?.requestRender());
			} else {
				stopTimer();
			}
		},
		detach() {
			stopTimer();
			if (shown) setWidget(undefined);
			shown = false;
			ui = null;
			source = null;
			tui = null;
			onSelect = null;
			onView = null;
			expanded = false;
			layout = { rows: [], control: null };
		},
	};
}
