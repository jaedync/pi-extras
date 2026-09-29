/**
 * The agent inspector: a centred overlay showing one agent's band, what it
 * was asked to do, and its live transcript, with a composer to message it and
 * a guarded stop. Built like the Shell Jobs inspector, so it scrolls, follows
 * the tail and closes the same way.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type Focusable, type OverlayOptions, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { renderBand } from "../band/band.ts";
import { everyFrame, FRAME_MS } from "../band/clock.ts";
import { closeOnOutsideClick, OnScreen, type OverlayPresence, type ShownOverlay } from "../band/modal.ts";
import { paletteFrom } from "../band/palette.ts";
import { onBackground, panelBackground } from "../band/surface.ts";
import { transcriptLines } from "./transcript.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";
import { phaseOf, rowRail, rowSegs } from "./widget.ts";

export const INSPECTOR_HEIGHT_SHARE = 0.85;
export const INSPECTOR_MIN_ROWS = 14;
export const INSPECTOR_WIDTH = "86%";
const TASK_LINES = 4;
const MIN_VIEWPORT_ROWS = 3;
const FRAME_COLUMNS = 4;
const NOTICE_MS = 4_000;
const HINT = "enter message · x stop · ↑↓ PgUp/PgDn g/G scroll · esc close";

export interface InspectorTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

export interface InspectorSource {
	record(): AgentRecord | undefined;
	messages(): readonly unknown[];
	send(text: string): Promise<string>;
	stop(): Promise<void>;
	describe(tool: string, args: unknown): string;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export class AgentInspector implements Component, Focusable {
	focused = false;
	private scroll = 0;
	private follow = true;
	private viewport = MIN_VIEWPORT_ROWS;
	private maxScroll = 0;
	private composing: string | null = null;
	private armedStop = false;
	private notice: { text: string; color: string; at: number } | null = null;
	private stopFrames: (() => void) | null = null;
	private closed = false;
	private readonly screen = new OnScreen();
	private readonly undoOutside: () => void;
	private readonly tui: InspectorTui;
	private readonly theme: Theme;
	private readonly source: InspectorSource;
	private readonly onClose: () => void;

	constructor(tui: InspectorTui, theme: Theme, source: InspectorSource, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.source = source;
		this.onClose = onClose;
		this.undoOutside = closeOnOutsideClick(tui, () => this.close(), () => this.screen.shown());
		// Taken off screen without being closed, nothing else would stop the timer.
		this.stopFrames = everyFrame(() => (this.screen.shown() ? tui.requestRender() : this.dispose()), FRAME_MS);
	}

	attach(handle: OverlayPresence): void {
		this.screen.attach(handle);
	}

	isOpen(): boolean {
		return !this.closed && this.screen.shown();
	}

	private paint = (color: string, text: string): string => {
		try { return this.theme.fg(color as never, text); } catch { return text; }
	};

	handleInput(data: string): void {
		if (this.composing !== null) return this.compose(data);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return this.close();
		if (data === "x") return void this.stopPressed();
		this.armedStop = false;
		if (matchesKey(data, "enter") || data === "m") {
			const record = this.source.record();
			if (record && record.state !== "failed" && record.state !== "stopped") this.composing = "";
			else this.flash("It has ended; it can't take messages.", "warning");
		} else if (matchesKey(data, "up")) this.scrollTo(this.scroll - 1);
		else if (matchesKey(data, "down")) this.scrollTo(this.scroll + 1);
		else if (matchesKey(data, "pageUp")) this.scrollTo(this.scroll - this.viewport);
		else if (matchesKey(data, "pageDown")) this.scrollTo(this.scroll + this.viewport);
		else if (matchesKey(data, "home") || data === "g") this.scrollTo(0);
		else if (matchesKey(data, "end") || data === "G") this.scrollTo(this.maxScroll);
		this.tui.requestRender();
	}

	private compose(data: string): void {
		const draft = this.composing ?? "";
		if (matchesKey(data, "escape")) this.composing = null;
		else if (matchesKey(data, "enter")) {
			this.composing = null;
			if (draft.trim()) {
				this.flash("sending…", "dim");
				this.source.send(draft.trim()).then((said) => this.flash(said, "success"), (error: Error) => this.flash(error.message, "error"));
			}
		} else if (matchesKey(data, "backspace")) this.composing = draft.slice(0, -1);
		else if (!/[\u0000-\u001f\u007f]/.test(data.replace(/\n/g, " "))) this.composing = draft + data.replace(/\n/g, " ");
		this.tui.requestRender();
	}

	private async stopPressed(): Promise<void> {
		const record = this.source.record();
		if (!record || !LIVE_STATES.has(record.state)) return this.flash("It is not running.", "dim");
		if (!this.armedStop) {
			this.armedStop = true;
			return this.flash("Press x again to stop it.", "warning");
		}
		this.armedStop = false;
		await this.source.stop();
		this.flash("Stopped.", "muted");
	}

	private flash(text: string, color: string): void {
		this.notice = { text, color, at: Date.now() };
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scrollTo(this.scroll + (event.wheelDelta ?? 0));
			return { handled: true };
		}
		if (event.type === "click") return { handled: true };
		return undefined;
	}

	invalidate(): void {}

	dispose(): void {
		this.undoOutside();
		this.stopFrames?.();
		this.stopFrames = null;
	}

	render(width: number): string[] {
		this.screen.drew();
		const w = Math.max(FRAME_COLUMNS + 12, width);
		const inner = w - FRAME_COLUMNS;
		const border = (text: string) => this.paint("border", text);
		const row = (content: string) => `${border("│")} ${truncateToWidth(content, inner, "…", true)} ${border("│")}`;
		const rule = (left: string, right: string) => border(`${left}${"─".repeat(w - 2)}${right}`);
		const record = this.source.record();
		const now = Date.now();
		const header: string[] = [];
		if (!record) header.push(row(this.paint("warning", "This agent is gone.")));
		else {
			header.push(row(renderBand(this.theme, paletteFrom(this.theme), { width: inner, phase: phaseOf(record, now), segs: rowSegs({ record, depth: 0 }), rail: rowRail(record, now), clockMs: now })));
			const facts = [record.state, record.model, record.thinking && `thinking ${record.thinking}`, `${record.toolCalls} tool calls`,
				record.runs > 1 && `${record.runs} runs`, record.readOnly && "read-only", record.parent !== "main" && `under ${record.parent}`].filter(Boolean).join(" · ");
			header.push(row(this.paint("dim", facts)));
			const task = wrapTextWithAnsi(record.task.replace(/\s+/g, " "), inner);
			for (const line of task.slice(0, TASK_LINES)) header.push(row(this.paint("muted", line)));
			if (task.length > TASK_LINES) header.push(row(this.paint("dim", `… ${task.length - TASK_LINES} more lines of task`)));
			if (record.error) header.push(row(this.paint("error", record.error)));
		}
		const fixed = header.length + 5;
		const maxRows = Math.max(INSPECTOR_MIN_ROWS, Math.floor(this.tui.terminal.rows * INSPECTOR_HEIGHT_SHARE));
		this.viewport = Math.max(MIN_VIEWPORT_ROWS, maxRows - fixed);
		const lines = transcriptLines(this.source.messages(), inner, this.paint, this.source.describe);
		if (lines.length === 0) lines.push(this.paint("dim", record?.state === "queued" ? "(queued; not started yet)" : "(nothing yet)"));
		this.maxScroll = Math.max(0, lines.length - this.viewport);
		this.scroll = this.follow ? this.maxScroll : clamp(this.scroll, 0, this.maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + this.viewport);
		while (visible.length < this.viewport) visible.push("");
		const frame = [rule("╭", "╮"), ...header, rule("├", "┤"), ...visible.map(row), rule("├", "┤"), row(this.footer(inner, record, lines.length)), rule("╰", "╯")];
		return onBackground(frame, w, panelBackground(this.theme));
	}

	private footer(inner: number, record: AgentRecord | undefined, total: number): string {
		if (this.composing !== null) {
			const label = `message ${record?.name ?? ""}: `;
			const room = Math.max(4, inner - visibleWidth(label) - 1);
			const draft = this.composing.length > room ? `…${this.composing.slice(-(room - 1))}` : this.composing;
			return `${this.paint("accent", label)}${draft}${this.paint("accent", "▏")}`;
		}
		if (this.notice && Date.now() - this.notice.at < NOTICE_MS) return this.paint(this.notice.color, this.notice.text);
		const position = `${total === 0 ? 0 : this.scroll + 1}–${Math.min(total, this.scroll + this.viewport)} of ${total}${this.follow ? " · following" : ""}`;
		const gap = Math.max(1, inner - visibleWidth(HINT) - visibleWidth(position));
		return this.paint("dim", `${HINT}${" ".repeat(gap)}${position}`);
	}

	private scrollTo(target: number): void {
		const next = clamp(target, 0, this.maxScroll);
		this.follow = next >= this.maxScroll;
		this.scroll = next;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.onClose();
	}
}

export interface InspectorHost {
	custom<T>(
		factory: (tui: InspectorTui, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void },
		options: { overlay: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayPresence) => void },
	): Promise<T>;
}

export function openAgentInspector(ui: InspectorHost, source: InspectorSource): ShownOverlay {
	let inspector: AgentInspector | undefined;
	const closed = ui.custom<void>(
		(tui, theme, _keys, done) => (inspector = new AgentInspector(tui, theme, source, () => done(undefined))),
		{ overlay: true, overlayOptions: { anchor: "center", width: INSPECTOR_WIDTH, margin: 1 }, onHandle: (handle) => inspector?.attach(handle) },
	);
	return { closed, isOpen: () => inspector?.isOpen() ?? false };
}
