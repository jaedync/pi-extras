/**
 * The subagents widget above the editor: one row per agent, children nested
 * under their parent, then any messages queued for main that Pi has not
 * appended yet. A row is the agent's presence, its ◆ and name in its color with
 * no band behind it (band/agent-look.ts): who it is, how long it has run,
 * what it is doing right now (moving as main's spinner does for the same
 * work), then its model, what it has cost and how full its context is. Names
 * and times line up across rows, so what each agent is doing starts in one
 * column; nothing else is padded, so no row has a hole in it. A finished
 * agent keeps its row until its report is in the transcript.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatTime, type Motion, type Seg } from "../band/band.ts";
import { agentHue, agentLine, avatarOf, doingGlyph, doingOf, endGlyph, spaced } from "../band/agent-look.ts";
import { everyFrame } from "../band/clock.ts";
import { formatMoney } from "../status-plus-logic.ts";
import type { PendingItem } from "./deliver.ts";
import { MAIN } from "./names.ts";
import { type AgentRecord, type AgentState, LIVE_STATES } from "./types.ts";

export const WIDGET_ID = "subagents";
export const MAX_AGENT_ROWS = 6;
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
export function selectRows(records: readonly AgentRecord[], reportPending: ReadonlySet<string>): { rows: AgentRow[]; hidden: number } {
	const visible = records.filter((record) => (LIVE_STATES.has(record.state) || record.state === "interrupted" || reportPending.has(record.name)) && !(record.parent === MAIN && record.blocking));
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
	return { rows: ordered.slice(0, MAX_AGENT_ROWS), hidden: Math.max(0, ordered.length - MAX_AGENT_ROWS) };
}

function statusWords(record: AgentRecord, reportQueued: boolean): Seg {
	switch (record.state) {
		case "asking": return { text: record.activity ?? `asking ${record.askingWho ?? ""}`, color: "warning" };
		// Only the widget knows whether the report has reached main; elsewhere, finished is what is sure.
		case "idle": return { text: reportQueued ? "report queued" : "finished", color: "muted" };
		case "failed": return { text: record.error ? `failed: ${record.error}` : "failed", color: "error" };
		case "stopped": return { text: "stopped", color: "muted" };
		case "interrupted": return { text: `interrupted${record.activity ? `: ${record.activity}` : ""}`, color: "warning" };
		// A running agent with no tool or text under way is thinking, as its spinner says.
		default: return { text: record.activity ?? (record.state === "running" ? "thinking" : ""), color: "muted" };
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

/** Column widths that line rows up: the widest nested name and run time among them. */
export interface RowColumns {
	readonly name: number;
	readonly time: number;
}

export function rowColumns(rows: readonly AgentRow[], now = 0): RowColumns {
	return {
		name: Math.max(0, ...rows.map((row) => nestText(row.depth).length + row.record.name.length)),
		time: Math.max(0, ...rows.map((row) => runTime(row.record, now)?.length ?? 0)),
	};
}

/** How long an agent has run; none before it starts. */
export function runTime(record: AgentRecord, now: number): string | undefined {
	// Restored records saved before run starts were kept have only createdAt, as in format.ts.
	return record.state === "queued" ? undefined : formatTime((record.endedAt ?? now) - (record.startedAt ?? record.createdAt));
}

/** Its model, what it has cost and how full its context is, quiet after the rest. */
export function factSegs(record: AgentRecord): Seg[] {
	const parts: Seg[] = [{ text: modelText(record), color: "dim" }];
	if (record.usage.cost > 0) parts.push({ text: `$${formatMoney(record.usage.cost)}`, color: "dim" });
	if (record.contextTokens && record.contextWindow) parts.push({ text: `ctx ${Math.round((100 * record.contextTokens) / record.contextWindow)}%`, color: "dim" });
	return parts.flatMap((part, index) => (index === 0 ? [part] : [{ text: " · ", color: "dim" }, part]));
}

export const modelText = (record: AgentRecord): string => `${shortModel(record.model)}${record.thinking ? ` ${record.thinking}` : ""}`;

/**
 * Who, how long, what it is doing (a glyph that moves for the work, or how
 * it ended, and the words), then its model and spend. Read left to right with
 * no gaps to cross; past the width the model and spend go first, then the words.
 */
export function rowSegs(row: AgentRow, now = 0, motion: Motion = "full", columns: RowColumns = { name: 0, time: 0 }): Seg[] {
	const { record } = row;
	const doing = endGlyph(record.state) ?? doingGlyph(doingOf(record), now, motion, agentHue(record.model));
	const time = runTime(record, now) ?? "";
	return spaced(
		nameSegs(record, row.depth, columns.name),
		time || columns.time ? [{ text: time.padStart(columns.time), color: "text" }] : [],
		[{ text: doing.glyph, color: doing.color }, { text: " ", color: "dim" }, statusWords(record, row.reportQueued === true)],
		factSegs(record),
	);
}

/** One agent's presence line; `columns` lines it up with the rows around it. */
export function presenceLine(theme: Theme, row: AgentRow, width: number, now: number, motion: Motion = "full", columns?: RowColumns): string {
	return agentLine(theme, rowSegs(row, now, motion, columns), width);
}

export const hiddenLine = (hidden: number): string => `+${hidden} more agent${hidden === 1 ? "" : "s"}`;

const STATE_WORDS: Record<AgentState, string> = {
	queued: "queued", starting: "starting", running: "running", asking: "asking", waiting: "waiting", idle: "finished", failed: "failed", stopped: "stopped", interrupted: "interrupted",
};

/** One line in the /subagents picker, cut to `maxWidth`. The name leads, since the picker reads it back. */
export function listLabel(record: AgentRecord, nameWidth: number, now: number, maxWidth = Number.POSITIVE_INFINITY): string {
	const parts = [record.name.padEnd(nameWidth), `${STATE_WORDS[record.state]}${record.orphaned ? " (orphan)" : ""}`.padEnd(8), shortModel(record.model)];
	if (record.usage.cost > 0) parts.push(`$${formatMoney(record.usage.cost)}`);
	if (record.state !== "queued") parts.push(formatTime((record.endedAt ?? now) - (record.startedAt ?? record.createdAt)));
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

interface TuiHost { requestRender(): void }
interface WidgetUi { setWidget(id: string, content: unknown, options?: unknown): void }
interface MouseEvent { type: string; button: string; y: number }

export interface AgentsWidget {
	attach(ui: WidgetUi, source: () => { records: AgentRecord[]; pending: PendingItem[] }, onSelect?: (name: string) => void): void;
	update(): void;
	detach(): void;
}


/** `motion` is Tool Display's setting, read each frame: reduced holds what agents are doing still. */
export function createAgentsWidget(motion: () => Motion = () => "full"): AgentsWidget {
	let ui: WidgetUi | null = null;
	let source: (() => { records: AgentRecord[]; pending: PendingItem[] }) | null = null;
	let onSelect: ((name: string) => void) | null = null;
	let tui: TuiHost | null = null;
	let shown = false;
	let stopFrames: (() => void) | null = null;
	let lastRows: AgentRow[] = [];

	const snapshot = () => source?.() ?? { records: [], pending: [] };
	const reportPending = (pending: readonly PendingItem[]) =>
		new Set(pending.filter((item) => item.kind === "report").flatMap((item) => item.from.split(", ")));

	const factory = (host: TuiHost, theme: Theme) => {
		tui = host;
		return {
			render: (width: number) => {
				const { records, pending } = snapshot();
				const { rows, hidden } = selectRows(records, reportPending(pending));
				lastRows = rows;
				const now = Date.now();
				const columns = rowColumns(rows, now);
				const lines = rows.map((row) => presenceLine(theme, row, width, now, motion(), columns));
				if (hidden > 0) lines.push(agentLine(theme, [{ text: hiddenLine(hidden), color: "dim" }], width));
				// Mail still on its way to main, cut to the width like any agent line.
				for (const line of pendingLines(pending)) lines.push(agentLine(theme, [{ text: line.text, color: line.color }], width));
				return lines;
			},
			invalidate: () => {},
			handleMouse: (event: MouseEvent) => {
				if (event.type !== "click" || event.button !== "left" || !onSelect) return undefined;
				const row = lastRows[event.y];
				if (!row) return undefined;
				onSelect(row.record.name);
				return { handled: true };
			},
		};
	};

	const setWidget = (content: unknown) => {
		try { ui?.setWidget(WIDGET_ID, content); } catch { /* stale context after a session switch */ }
	};
	const stopTimer = () => { stopFrames?.(); stopFrames = null; };

	return {
		attach(nextUi, nextSource, select) {
			ui = nextUi;
			source = nextSource;
			onSelect = select ?? null;
			shown = false;
			stopTimer();
			this.update();
		},
		update() {
			if (!ui || !source) return;
			const { records, pending } = snapshot();
			const anything = selectRows(records, reportPending(pending)).rows.length > 0 || pendingLines(pending).length > 0;
			if (!anything) {
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
			lastRows = [];
		},
	};
}
