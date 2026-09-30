/**
 * The agent inspector: one agent over the whole terminal (see band/sheet.ts),
 * with its band, what it was asked to do, its live transcript, and a message
 * box to write to it. It scrolls, follows the tail and closes like the other
 * sheets; letters go to the message box, so it has no letter shortcuts.
 */
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderBand } from "../band/band.ts";
import type { ShownOverlay } from "../band/modal.ts";
import { paletteFrom } from "../band/palette.ts";
import { openSheet, type SheetCopy, type SheetHost, type SheetKey, type SheetSource } from "../band/sheet.ts";
import { moreLines } from "./names.ts";
import { transcriptLines } from "./transcript.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";
import { phaseOf, rowRail, rowSegs } from "./widget.ts";

const TASK_LINES = 4;
const NOTICE_MS = 4_000;
const KEYS: readonly SheetKey[] = [
	{ key: "enter", label: "send" }, { key: "esc", label: "close" }, { key: "ctrl+x", label: "stop" }, { key: "↑↓ PgUp/PgDn", label: "scroll" },
];
const KEYS_DRAFT: readonly SheetKey[] = [{ key: "enter", label: "send" }, { key: "esc", label: "clear" }, { key: "↑↓ PgUp/PgDn", label: "scroll" }];
const ENDED = "It has ended; it can't take messages.";
const PASTE_MARKS = /\x1b\[20[01]~/g;

export interface InspectorSource {
	record(): AgentRecord | undefined;
	messages(): readonly unknown[];
	send(text: string): Promise<string>;
	stop(): Promise<void>;
	describe(tool: string, args: unknown): string;
}

export class AgentView implements SheetSource {
	readonly typing = true;
	/** The message box is always live: an inspector is where you talk to the agent. */
	private draft = "";
	private armedStop = false;
	private shownNotice: { text: string; color: string; at: number } | null = null;
	private cached: { messages: readonly unknown[]; count: number; width: number; lines: string[] } | undefined;
	private readonly theme: Theme;
	private readonly source: InspectorSource;
	private readonly redraw: () => void;

	constructor(theme: Theme, source: InspectorSource, redraw: () => void = () => undefined) {
		this.theme = theme;
		this.source = source;
		this.redraw = redraw;
	}

	private paint = (color: string, text: string): string => {
		try { return this.theme.fg(color as never, text); } catch { return text; }
	};

	title(): string {
		const record = this.source.record();
		return record ? `Subagent · ${record.name}` : "Subagent";
	}

	band(width: number): string {
		const record = this.source.record();
		const now = Date.now();
		if (!record) return ` ${this.paint("warning", "This agent is gone.")}`;
		return renderBand(this.theme, paletteFrom(this.theme), { width, phase: phaseOf(record, now), segs: rowSegs({ record, depth: 0 }), rail: rowRail(record, now), clockMs: now });
	}

	head(width: number, rows: number): string[] {
		const record = this.source.record();
		if (!record) return [];
		const facts = [record.state, record.model, record.thinking && `thinking ${record.thinking}`, `${record.toolCalls} tool calls`,
			record.runs > 1 && `${record.runs} runs`, record.readOnly && "read-only", record.parent !== "main" && `under ${record.parent}`].filter(Boolean).join(" · ");
		const error = record.error ? [this.paint("error", record.error)] : [];
		const task = wrapTextWithAnsi(record.task.replace(/\s+/g, " "), width);
		// The task gets what the facts and any error leave, up to its own cap.
		const room = Math.max(1, Math.min(TASK_LINES, rows - 1 - error.length));
		const shown = task.length > room ? [...task.slice(0, room - 1).map((line) => this.paint("muted", line)), this.paint("dim", `… ${moreLines(task.length - room + 1)} of task`)]
			: task.map((line) => this.paint("muted", line));
		return [this.paint("dim", facts), ...shown, ...error].slice(0, rows);
	}

	bodyLabel(): string {
		return "transcript";
	}

	/** Transcript lines, rebuilt only when a message arrives or the width changes. */
	body(width: number): string[] {
		const messages = this.source.messages();
		const cached = this.cached;
		if (cached && cached.messages === messages && cached.count === messages.length && cached.width === width) return cached.lines;
		const lines = transcriptLines(messages, width, this.paint, this.source.describe);
		if (lines.length === 0) lines.push(this.paint("dim", this.source.record()?.state === "queued" ? "(queued; not started yet)" : "(nothing yet)"));
		this.cached = { messages, count: messages.length, width, lines };
		return lines;
	}

	foot(width: number): string[] {
		return [this.composer(width)];
	}

	copies(): readonly SheetCopy[] {
		const record = () => this.source.record();
		return [{ label: "copy task", text: () => record()?.task }, { label: "copy report", text: () => record()?.report }];
	}

	keys(): readonly SheetKey[] {
		return this.draft ? KEYS_DRAFT : KEYS;
	}

	notice(): { text: string; color: string } | undefined {
		return this.shownNotice && Date.now() - this.shownNotice.at < NOTICE_MS ? this.shownNotice : undefined;
	}

	/** Always redraws: the band moves while it runs, and a message can resume it at any time. */
	live(): boolean {
		return true;
	}

	key(data: string): boolean {
		if (matchesKey(data, "ctrl+x")) {
			void this.stopPressed();
			return true;
		}
		this.armedStop = false;
		if (matchesKey(data, "escape")) {
			if (!this.draft) return false;
			this.draft = "";
		} else if (matchesKey(data, "enter")) this.send();
		else if (matchesKey(data, "backspace")) this.draft = this.draft.slice(0, -1);
		else return this.typed(data);
		return true;
	}

	/** Keys, pastes (one line), and letters a kitty-protocol terminal encodes. */
	private typed(data: string): boolean {
		const text = (decodeKittyPrintable(data) ?? data).replace(PASTE_MARKS, "").replace(/\r?\n|\r/g, " ");
		if (!text || /[\u0000-\u001f\u007f]/.test(text)) return false;
		if (this.accepts()) this.draft += text;
		return true;
	}

	private accepts(): boolean {
		const record = this.source.record();
		return record !== undefined && record.state !== "failed" && record.state !== "stopped";
	}

	private send(): void {
		const text = this.draft.trim();
		if (!text) return;
		if (!this.accepts()) return this.flash(ENDED, "warning");
		this.draft = "";
		this.flash("sending…", "dim");
		this.source.send(text).then((said) => this.flash(said, "success"), (error: Error) => this.flash(error.message, "error"));
	}

	private async stopPressed(): Promise<void> {
		const record = this.source.record();
		if (!record || !LIVE_STATES.has(record.state)) return this.flash("It is not running.", "dim");
		if (!this.armedStop) {
			this.armedStop = true;
			return this.flash("Press ctrl+x again to stop it.", "warning");
		}
		this.armedStop = false;
		await this.source.stop();
		this.flash("Stopped.", "muted");
	}

	private flash(text: string, color: string): void {
		this.shownNotice = { text, color, at: Date.now() };
		this.redraw();
	}

	private composer(width: number): string {
		const record = this.source.record();
		if (!record || !this.accepts()) return this.paint("dim", ENDED);
		const label = `${record.name} ▸ `;
		const caret = this.paint("accent", "▏");
		if (!this.draft) return `${this.paint("accent", label)}${caret}${this.paint("dim", record.state === "idle" ? "write to resume it" : "write to it")}`;
		const room = Math.max(4, width - visibleWidth(label) - 1);
		const draft = this.draft.length > room ? `…${this.draft.slice(-(room - 1))}` : this.draft;
		return `${this.paint("accent", label)}${draft}${caret}`;
	}
}

export type InspectorHost = SheetHost;

export function openAgentInspector(ui: InspectorHost, source: InspectorSource): ShownOverlay {
	return openSheet(ui, (theme, tui) => new AgentView(theme as unknown as Theme, source, () => tui.requestRender()), { copy: copyToClipboard });
}
