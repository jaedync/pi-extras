/**
 * The subagents widget above the editor: one band per agent, children nested
 * under their parent, then any messages queued for main that Pi has not
 * appended yet. A band says who it is, which model, what it is doing right now,
 * and on the right how full its context is, what it has cost, and how long it
 * has run. A finished agent keeps its band until its report is in the
 * transcript.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatTime, renderBand, type BandPhase, type Seg } from "../band/band.ts";
import { everyFrame } from "../band/clock.ts";
import { paletteFrom } from "../band/palette.ts";
import { formatMoney } from "../status-plus-logic.ts";
import type { PendingItem } from "./deliver.ts";
import { MAIN } from "./names.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";

export const WIDGET_ID = "subagents";
export const MAX_AGENT_ROWS = 6;
export const MAX_PENDING_ROWS = 3;
const PAD = " ";

export interface AgentRow {
	record: AgentRecord;
	depth: number;
}

export const shortModel = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

/**
 * Live agents and those whose report is still queued, parents before children.
 * A child main is blocked on already has its own row in the transcript.
 */
export function selectRows(records: readonly AgentRecord[], reportPending: ReadonlySet<string>): { rows: AgentRow[]; hidden: number } {
	const visible = records.filter((record) => (LIVE_STATES.has(record.state) || reportPending.has(record.name)) && !(record.parent === MAIN && record.blocking));
	const byParent = new Map<string, AgentRecord[]>();
	for (const record of visible) byParent.set(record.parent, [...(byParent.get(record.parent) ?? []), record]);
	const shown = new Set(visible.map((record) => record.name));
	const ordered: AgentRow[] = [];
	const walk = (parent: string, depth: number) => {
		for (const record of byParent.get(parent) ?? []) {
			ordered.push({ record, depth });
			walk(record.name, depth + 1);
		}
	};
	walk(MAIN, 0);
	// A visible child whose parent is not shown still gets a row.
	for (const record of visible) if (record.parent !== MAIN && !shown.has(record.parent)) {
		ordered.push({ record, depth: 0 });
		walk(record.name, 1);
	}
	return { rows: ordered.slice(0, MAX_AGENT_ROWS), hidden: Math.max(0, ordered.length - MAX_AGENT_ROWS) };
}

export function phaseOf(record: AgentRecord, now: number): BandPhase {
	switch (record.state) {
		case "queued": return { kind: "queued" };
		case "starting": case "running": return { kind: "running", elapsedMs: now - (record.startedAt ?? now) };
		case "asking": case "waiting": return { kind: "calm" };
		case "idle": return { kind: "done", outcome: "ok", sinceMs: Number.POSITIVE_INFINITY };
		case "failed": return { kind: "done", outcome: "fail", sinceMs: Number.POSITIVE_INFINITY };
		case "stopped": return { kind: "done", outcome: "aborted", sinceMs: Number.POSITIVE_INFINITY };
	}
}

function statusWords(record: AgentRecord): Seg {
	switch (record.state) {
		case "asking": return { text: record.activity ?? `asking ${record.askingWho ?? ""}`, color: "warning" };
		case "idle": return { text: "report queued", color: "muted" };
		case "failed": return { text: record.error ? `failed: ${record.error}` : "failed", color: "error" };
		case "stopped": return { text: "stopped", color: "muted" };
		default: return { text: record.activity ?? "", color: "muted" };
	}
}

export function rowSegs(row: AgentRow): Seg[] {
	const { record } = row;
	const model = `${shortModel(record.model)}${record.thinking ? ` ${record.thinking}` : ""}`;
	return [
		...(row.depth > 0 ? [{ text: `${"  ".repeat(row.depth - 1)}└ `, color: "dim" }] : []),
		{ text: record.name, color: "text", bold: true },
		{ text: `  ${model}`, color: "dim" },
		{ text: "  ", color: "dim" },
		statusWords(record),
	];
}

export function rowRail(record: AgentRecord, now: number): Seg[] {
	const rail: Seg[] = [];
	if (record.contextTokens && record.contextWindow) {
		rail.push({ text: `ctx ${Math.round((100 * record.contextTokens) / record.contextWindow)}%`, color: "dim" }, { text: "  ", color: "dim" });
	}
	if (record.usage.cost > 0) rail.push({ text: `$${formatMoney(record.usage.cost)}`, color: "dim" }, { text: "  ", color: "dim" });
	if (record.state !== "queued") rail.push({ text: formatTime((record.endedAt ?? now) - (record.startedAt ?? now)), color: "text" });
	return rail;
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

const truncate = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text);

export function createAgentsWidget(): AgentsWidget {
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
				const palette = paletteFrom(theme);
				const lines = rows.map((row) => renderBand(theme, palette, {
					width, phase: phaseOf(row.record, now), segs: rowSegs(row), rail: rowRail(row.record, now), clockMs: now,
				}));
				const paint = (color: string, text: string) => { try { return theme.fg(color as never, text); } catch { return text; } };
				if (hidden > 0) lines.push(`${PAD}${paint("dim", `+${hidden} more agents`)}`);
				for (const line of pendingLines(pending)) lines.push(`${PAD}${paint(line.color, truncate(line.text, width - 2))}`);
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
