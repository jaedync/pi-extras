/**
 * The subagents widget above the editor: one row per agent (rows.ts),
 * children nested under their parent, then any messages queued for main that
 * Pi has not appended yet. What an agent is doing comes last in its row
 * because it is the only part whose length has no bound, so a narrow terminal
 * cuts it and keeps the rest. Name, time, context, spend and model line up
 * across rows, so what each agent is doing starts in one column. A finished
 * agent keeps its row until its report is in the transcript. Past four
 * agents, the last line is a control line that opens the agents view or
 * expands the rows (overflow.ts).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Motion } from "../band/band.ts";
import { agentLine } from "../band/agent-look.ts";
import { everyFrame } from "../band/clock.ts";
import { type PendingItem, reportsPending } from "./contract.ts";
import { MAIN } from "./names.ts";
import { COLLAPSED_ROWS, controlLine, expandedBudget, fitRows, shownCount, type ControlLine, type Span } from "./overflow.ts";
import { type AgentRow, agentRows, presenceLine, rowColumns } from "./rows.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";

export const WIDGET_ID = "subagents";
export const MAX_PENDING_ROWS = 3;

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

interface WidgetView { records: AgentRecord[]; pending: PendingItem[]; expanded: boolean; motion: Motion }

/** The widget's lines at `width`, and where its rows and control line sit, for clicks. */
function renderAgents(theme: Theme, host: TuiHost, width: number, view: WidgetView): { lines: string[]; layout: Layout } {
	const all = agentRows(view.records, reportsPending(view.pending));
	const mail = pendingLines(view.pending);
	const budget = expandedBudget(host.terminal?.rows ?? process.stdout.rows ?? 40, mail.length);
	// A terminal too short to give the rows more room has nothing to expand into.
	const roomy = shownCount(all.length, true, budget) !== shownCount(all.length, false, budget);
	const { shown: rows, hidden } = fitRows(all, shownCount(all.length, view.expanded && roomy, budget));
	const now = Date.now();
	const columns = rowColumns(rows, now);
	const lines = rows.map((row) => presenceLine(theme, row, width, now, view.motion, columns));
	const toggle = roomy ? (view.expanded ? "collapse" : "expand") : null;
	const control = all.length > COLLAPSED_ROWS ? { ...controlLine(hidden, all.length, toggle, width), y: lines.length } : null;
	if (control) lines.push(agentLine(theme, control.segs, width));
	// Mail still on its way to main, cut to the width like any agent line.
	for (const line of mail) lines.push(agentLine(theme, [{ text: line.text, color: line.color }], width));
	return { lines, layout: { rows, control } };
}

/** A left click on a row opens that agent; on the control line it expands, collapses or opens the agents view. */
function clickAgents(event: MouseEvent, layout: Layout, actions: { select?: (name: string) => void; view?: () => void; toggle: () => void }) {
	if (event.type !== "click" || event.button !== "left") return undefined;
	const row = layout.rows[event.y];
	if (row && actions.select) {
		actions.select(row.record.name);
		return { handled: true };
	}
	const control = layout.control;
	if (!control || event.y !== control.y) return undefined;
	if (control.toggle && inSpan(event.x, control.toggle)) {
		actions.toggle();
		return { handled: true, render: true };
	}
	if (actions.view && (inSpan(event.x, control.view) || inSpan(event.x, control.more))) {
		actions.view();
		return { handled: true };
	}
	return undefined;
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

	const factory = (host: TuiHost, theme: Theme) => {
		tui = host;
		return {
			render: (width: number) => {
				const frame = renderAgents(theme, host, width, { ...snapshot(), expanded, motion: motion() });
				layout = frame.layout;
				return frame.lines;
			},
			invalidate: () => {},
			handleMouse: (event: MouseEvent) => clickAgents(event, layout, {
				...(onSelect ? { select: onSelect } : {}), ...(onView ? { view: onView } : {}), toggle: () => { expanded = !expanded; },
			}),
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
			const anything = agentRows(records, reportsPending(pending)).length > 0 || pendingLines(pending).length > 0;
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
