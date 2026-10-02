/**
 * Every subagent in the session over the whole terminal (band/sheet.ts): the
 * same live rows the widget above the editor shows, children under their
 * parents, each with its task set in under its name, and a line on top that
 * counts what they are doing and what they have cost. The arrows move a
 * highlight; Enter or a click on either line opens that agent's inspector,
 * and Esc there comes back here. The widget's `(view)` opens it, as does
 * `/subagents` with no name.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { AGENT_HUE, agentLine } from "../band/agent-look.ts";
import type { Motion, Seg } from "../band/band.ts";
import type { ShownOverlay } from "../band/modal.ts";
import { openSheet, type SheetHost, type SheetKey, type SheetSource } from "../band/sheet.ts";
import { onBackground, selectedBackground } from "../band/surface.ts";
import { formatMoney } from "../status-plus-logic.ts";
import type { PendingItem } from "./deliver.ts";
import { stateCounts } from "./overflow.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";
import { presenceLine, rowColumns, teamRows, type AgentRow } from "./widget.ts";

export interface TeamSource {
	records(): readonly AgentRecord[];
	/** Mail on its way to main, so a finished agent whose report hasn't landed says so. */
	pending(): readonly PendingItem[];
	/** Called as the view closes itself to open this agent's inspector. */
	open(name: string): void;
	motion?(): Motion;
	/** The agent to start on, such as the one whose inspector was just closed. */
	readonly selected?: string;
}

/** Each agent takes two body lines: its row, then its task. */
const LINES_PER_AGENT = 2;
const KEYS: readonly SheetKey[] = [{ key: "↑↓", label: "select" }, { key: "enter", label: "open" }, { key: "esc", label: "close" }, { key: "PgUp/PgDn", label: "scroll" }];
const SEP: Seg = { text: " · ", color: "dim" };

/** The team as one frame draws it. */
interface Snapshot {
	readonly records: readonly AgentRecord[];
	readonly rows: readonly AgentRow[];
}

export class TeamView implements SheetSource {
	private selected: string | undefined;
	private snapshot: Snapshot | undefined;
	private readonly theme: Theme;
	private readonly source: TeamSource;
	private readonly close: () => void;

	constructor(theme: Theme, source: TeamSource, close: () => void) {
		this.theme = theme;
		this.source = source;
		this.close = close;
		this.selected = source.selected;
	}

	private read(): Snapshot {
		const records = this.source.records();
		const reported = new Set(this.source.pending().filter((item) => item.kind === "report").flatMap((item) => item.from.split(", ")));
		return { records, rows: teamRows(records, reported) };
	}

	/** Every part of a frame draws the same team, and a key or click acts on what was drawn. */
	frame(): void {
		this.snapshot = this.read();
	}

	private current(): Snapshot {
		return this.snapshot ?? this.read();
	}

	private rows(): readonly AgentRow[] {
		return this.current().rows;
	}

	/** Where the highlight is; it follows its agent by name as others come and go. */
	private index(rows: readonly AgentRow[]): number {
		return Math.max(0, rows.findIndex((row) => row.record.name === this.selected));
	}

	private choose(row: AgentRow | undefined): boolean {
		if (!row) return false;
		this.source.open(row.record.name);
		this.close();
		return true;
	}

	title(): string {
		return `Subagents · ${this.current().records.length}`;
	}

	titleColor(): string {
		return AGENT_HUE;
	}

	band(width: number): string {
		const { records } = this.current();
		const cost = records.reduce((sum, record) => sum + record.usage.cost, 0);
		const parts: Seg[][] = [...stateCounts(this.rows()).map((count) => [count]), ...(cost > 0 ? [[{ text: `$${formatMoney(cost)}`, color: "dim" }]] : [])];
		return agentLine(this.theme, parts.flatMap((part, index) => (index === 0 ? part : [SEP, ...part])), width);
	}

	head(): string[] {
		return [];
	}

	bodyLabel(): string {
		return "agents";
	}

	body(width: number): string[] {
		const rows = this.rows();
		if (rows.length === 0) return [agentLine(this.theme, [{ text: "No subagents in this session.", color: "dim" }], width)];
		const now = Date.now();
		const columns = rowColumns(rows, now);
		const motion = this.source.motion?.() ?? "full";
		const at = this.index(rows);
		const highlight = selectedBackground(this.theme);
		return rows.flatMap((row, index) => {
			// The task starts under the name: past the margin, any nesting and the ◆.
			const orphan: Seg[] = row.record.orphaned ? [{ text: "orphan · ", color: "warning" }] : [];
			const task = agentLine(this.theme, [{ text: " ".repeat(2 * row.depth + 2), color: "dim" }, ...orphan, { text: row.record.task.replace(/\s+/g, " ").trim(), color: "dim" }], width);
			const lines = [presenceLine(this.theme, row, width, now, motion, columns), task];
			return index === at && highlight ? onBackground(lines, width, highlight) : lines;
		});
	}

	focus(): { line: number; rows: number } {
		return { line: this.index(this.rows()) * LINES_PER_AGENT, rows: LINES_PER_AGENT };
	}

	pickBody(line: number): boolean {
		return this.choose(this.rows()[Math.floor(line / LINES_PER_AGENT)]);
	}

	key(data: string): boolean {
		const rows = this.rows();
		if (matchesKey(data, "enter")) return this.choose(rows[this.index(rows)]) || true;
		const step = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
		if (step === 0) return false;
		const next = rows[Math.min(rows.length - 1, Math.max(0, this.index(rows) + step))];
		if (next) this.selected = next.record.name;
		return true;
	}

	keys(): readonly SheetKey[] {
		return KEYS;
	}

	live(): boolean {
		return this.current().records.some((record) => LIVE_STATES.has(record.state));
	}
}

export function openTeamView(ui: SheetHost, source: TeamSource): ShownOverlay {
	return openSheet(ui, (theme, _tui, close) => new TeamView(theme as unknown as Theme, source, close));
}
