/**
 * How the subagents widget fits more agents than it has room for. Up to four
 * show whole. A fifth turns the last row into a control line,
 * `+2 more subagents · 2 working  (view)  (expand)`, so it never says
 * `+1 more` for a row it could have drawn. The rows kept are the ones that
 * need you first (an agent asking something, one that failed), then those
 * still working, and finished ones give way first. Expanded, the rows take as
 * much room as the transcript can spare, and the control line stays last to
 * collapse them again.
 */
import { ROW_MARGIN, type Seg } from "../band/band.ts";
import type { AgentState } from "./types.ts";
import type { AgentRow } from "./widget.ts";

/** Lines the widget keeps collapsed, the control line among them once there are more agents. */
export const COLLAPSED_ROWS = 4;
/**
 * Rows the editor, the footer and the lines around them take; expanded rows
 * get half of what is left, so the transcript keeps the other half.
 */
const CHROME_ROWS = 10;

/**
 * How many agent rows to draw: all of them when they fit, else one fewer than
 * the room, for the control line, and one fewer again rather than leave a
 * single agent behind a line that could have been its row.
 */
export function shownCount(total: number, expanded: boolean, budget: number): number {
	if (total <= COLLAPSED_ROWS) return total;
	const room = (expanded ? Math.max(COLLAPSED_ROWS, budget) : COLLAPSED_ROWS) - 1;
	return total - room === 1 ? room - 1 : Math.min(total, room);
}

/** Lines the widget may take expanded: half of what the editor and footer leave, less any mail to main, never fewer than collapsed. */
export function expandedBudget(terminalRows: number, mailLines: number): number {
	return Math.max(COLLAPSED_ROWS, Math.floor((terminalRows - CHROME_ROWS) / 2) - mailLines);
}

/** Lower comes first: what needs you, then work under way, then what has ended. */
const URGENCY: Readonly<Record<AgentState, number>> = {
	asking: 0, failed: 1, interrupted: 1, running: 2, starting: 2, waiting: 2, queued: 3, idle: 4, stopped: 4,
};

/**
 * The `count` most urgent rows, still in tree order, and the rest. A shown
 * row is nested only under shown ancestors, so no `└` points at a row that
 * isn't drawn.
 */
export function fitRows(rows: readonly AgentRow[], count: number): { shown: AgentRow[]; hidden: AgentRow[] } {
	if (count >= rows.length) return { shown: [...rows], hidden: [] };
	const picked = new Set(rows.map((row, index) => ({ row, index }))
		.sort((a, b) => URGENCY[a.row.record.state] - URGENCY[b.row.record.state] || a.index - b.index)
		.slice(0, Math.max(0, count))
		.map(({ row }) => row.record.name));
	const byName = new Map(rows.map((row) => [row.record.name, row]));
	const depthOf = (row: AgentRow): number => {
		let depth = 0;
		for (let parent = byName.get(row.record.parent); parent && picked.has(parent.record.name) && depth < rows.length; parent = byName.get(parent.record.parent)) depth++;
		return depth;
	};
	return {
		shown: rows.filter((row) => picked.has(row.record.name)).map((row) => ({ ...row, depth: depthOf(row) })),
		hidden: rows.filter((row) => !picked.has(row.record.name)),
	};
}

/** What the hidden agents are doing, most urgent first; finished covers those whose report is still on its way. */
const GROUPS: ReadonlyArray<{ readonly word: string; readonly color: string; readonly states: readonly AgentState[] }> = [
	{ word: "asking", color: "warning", states: ["asking"] },
	{ word: "failed", color: "error", states: ["failed"] },
	{ word: "interrupted", color: "warning", states: ["interrupted"] },
	{ word: "working", color: "muted", states: ["running", "starting", "waiting"] },
	{ word: "queued", color: "dim", states: ["queued"] },
	{ word: "finished", color: "dim", states: ["idle"] },
	{ word: "stopped", color: "dim", states: ["stopped"] },
];
const GAP = "  ";
const SEP = " · ";

/** `1 asking`, `6 working`, `1 finished`: how many agents are doing what, most urgent first, none for an empty group. */
export function stateCounts(rows: readonly AgentRow[]): Seg[] {
	return GROUPS.map((group) => ({ group, count: rows.filter((row) => group.states.includes(row.record.state)).length }))
		.filter(({ count }) => count > 0)
		.map(({ group, count }) => ({ text: `${count} ${group.word}`, color: group.color }));
}
const BUTTON_COLOR = "accent";

/** Columns of a line, from its left edge, that a click on a word covers. */
export type Span = readonly [number, number];

/** What the toggle offers; none when expanding would draw the same rows. */
export type Toggle = "expand" | "collapse" | null;

export interface ControlLine {
	readonly segs: Seg[];
	/** The count; it opens the view, as `(view)` does. Empty once the count gives way. */
	readonly more: Span;
	readonly view: Span;
	/** `(expand)` or `(collapse)`, when there is one. */
	readonly toggle: Span | null;
}

/**
 * `+7 more subagents · 6 working · 1 finished  (view)  (expand)`, or
 * `10 subagents  (view)  (collapse)` once every row shows. When it is too
 * narrow, what the hidden agents are doing gives way first, then the word
 * subagents, then the count; the buttons go last, cut by the ellipsis.
 */
export function controlLine(hidden: readonly AgentRow[], total: number, toggle: Toggle, width: number): ControlLine {
	const room = Math.max(1, width - ROW_MARGIN - 1);
	const buttons: Seg[] = [{ text: "(view)", color: BUTTON_COLOR }, ...(toggle ? [{ text: `(${toggle})`, color: BUTTON_COLOR }] : [])];
	const buttonsWidth = buttons.reduce((sum, button) => sum + GAP.length + button.text.length, 0);
	const leads = hidden.length > 0 ? [`+${hidden.length} more subagents`, `+${hidden.length} more`] : [`${total} subagents`];
	const counts = stateCounts(hidden);
	const widthOf = (lead: string, shown: number) => lead.length + counts.slice(0, shown).reduce((sum, count) => sum + SEP.length + count.text.length, 0) + buttonsWidth;
	const fits = leads.flatMap((lead) => Array.from({ length: counts.length + 1 }, (_, i) => ({ lead, shown: counts.length - i })))
		.find(({ lead, shown }) => widthOf(lead, shown) <= room);
	const lead: Seg[] = fits ? [{ text: fits.lead, color: "dim" }, ...counts.slice(0, fits.shown).flatMap((count): Seg[] => [{ text: SEP, color: "dim" }, count])] : [];
	const segs: Seg[] = [...lead, ...buttons.flatMap((button, index): Seg[] => (index === 0 && lead.length === 0 ? [button] : [{ text: GAP, color: "dim" }, button]))];
	// The line is cut to the room with an ellipsis; a click past what is drawn lands on nothing.
	const length = segs.reduce((sum, seg) => sum + seg.text.length, 0);
	const end = ROW_MARGIN + (length <= room ? length : room - 1);
	const span = (seg: Seg | undefined): Span => {
		const start = ROW_MARGIN + segs.slice(0, seg ? segs.indexOf(seg) : 0).reduce((sum, each) => sum + each.text.length, 0);
		return [Math.min(start, end), Math.min(start + (seg?.text.length ?? 0), end)];
	};
	return { segs, more: span(lead[0]), view: span(buttons[0]), toggle: toggle ? span(buttons[1]) : null };
}
