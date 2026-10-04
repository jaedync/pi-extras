/**
 * The agent inspector: one agent's chat over the whole terminal, drawn as Pi
 * draws main's (chat.ts), on a ground washed with the agent's color so it
 * never reads as main. Its live row sits in the title bar, and a message box
 * between two rules writes to it, as Pi's editor does for main. It scrolls,
 * follows the tail and closes like the other sheets (see band/sheet.ts);
 * letters go to the message box, so it has no letter shortcuts.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { agentGround, agentHue } from "../band/agent-look.ts";
import { paintFg, paintLine } from "../band/band.ts";
import type { Motion } from "../band/band.ts";
import type { Rgb } from "../band/color.ts";
import type { ShownOverlay } from "../band/modal.ts";
import { paletteFrom } from "../band/palette.ts";
import { openSheet, type SheetHost, type SheetKey, type SheetSource } from "../band/sheet.ts";
import { drawnTool } from "../tool-row.ts";
import { ChatLog } from "./chat.ts";
import type { Voices } from "./transcript.ts";
import { type AgentRecord, LIVE_STATES } from "./types.ts";
import { rowSegs } from "./widget.ts";

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
	/** The reply being written now, before it joins the messages. */
	streaming?(): unknown;
	/** The agent's own definition of a tool, for a tool Tool Display doesn't draw. */
	tool?(name: string): object | undefined;
	/** Where the agent works, which tool rows show paths against. */
	readonly cwd?: string;
	/** Pi's settings for main's chat, so this one matches it. */
	readonly hideThinking?: boolean;
	readonly outputPad?: number;
	send(text: string): Promise<string>;
	stop(): Promise<void>;
	/** Tool Display's motion setting; reduced holds what the agent is doing still. */
	motion?(): Motion;
	/** Another agent's color by name, for messages it sent this one; absent, others keep the purple. */
	hue?(name: string): string;
}

export class AgentView implements SheetSource {
	readonly typing = true;
	readonly flush = true;
	/** The message box is always live: an inspector is where you talk to the agent. */
	private draft = "";
	private armedStop = false;
	private shownNotice: { text: string; color: string; at: number } | null = null;
	private readonly chat: ChatLog;
	private readonly theme: Theme;
	private readonly source: InspectorSource;
	private readonly redraw: () => void;

	constructor(theme: Theme, source: InspectorSource, tui: TUI, redraw: () => void = () => undefined) {
		this.theme = theme;
		this.source = source;
		this.redraw = redraw;
		this.chat = new ChatLog({
			tui, cwd: source.cwd ?? process.cwd(),
			// Main's look first: Tool Display's own rows for Pi's tools, then the agent's definition, which Tool Display adopts.
			tool: (name) => drawnTool(name) ?? source.tool?.(name),
			paint: this.paint, voices: () => this.voices(),
			hideThinking: source.hideThinking, pad: source.outputPad,
		});
	}

	private paint = (color: string, text: string): string => paintFg(this.theme, color, text);

	private voices(): Voices {
		const record = this.source.record();
		return { self: record?.name ?? "", hue: (name) => this.source.hue?.(name) ?? agentHue(name === record?.name ? record.model : undefined) };
	}

	title(): string {
		return this.source.record()?.name ?? "Subagent";
	}

	/** Its live row: who, how long, spend, model, then what it is doing. */
	titleLine(width: number): string {
		const record = this.source.record();
		if (!record) return this.paint("warning", "This agent is gone.");
		const segs = rowSegs({ record, depth: 0 }, Date.now(), this.source.motion?.() ?? "full");
		return paintLine(this.theme, paletteFrom(this.theme), { width, left: segs, indent: 0 }).trimEnd();
	}

	ground(): Rgb | undefined {
		return agentGround(this.theme, this.source.record()?.model);
	}

	head(): string[] {
		return [];
	}

	body(width: number): string[] {
		const record = this.source.record();
		this.chat.sync(this.source.messages(), this.source.streaming?.(), record !== undefined && LIVE_STATES.has(record.state));
		const lines = this.chat.render(width);
		const pad = " ".repeat(this.source.outputPad ?? 1);
		if (this.chat.empty && record) {
			lines.push(pad + this.paint("dim", record.state === "queued" ? "Queued; it hasn't started yet. Its task:" : "Nothing yet. Its task:"));
			lines.push(...wrapTextWithAnsi(record.task, Math.max(4, width - pad.length * 2)).map((line) => pad + this.paint("muted", line)));
		}
		// A failure from outside its replies (a launch or quota error) has no message of its own.
		if (record?.error && record.state === "failed" && !this.saidInChat(record.error)) lines.push("", ...wrapTextWithAnsi(record.error, Math.max(4, width - pad.length * 2)).map((line) => pad + this.paint("error", line)));
		return lines;
	}

	/** A click on the chat goes to the row under it: a tool row expands, a code block copies. */
	bodyMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.chat.mouse(event);
	}

	/** Whether its last reply already shows this error, as Pi shows a reply that failed. */
	private saidInChat(error: string): boolean {
		const last = this.source.messages().at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		return last?.role === "assistant" && last.stopReason === "error" && last.errorMessage === error;
	}

	/** The message box between two rules, as Pi's editor sits; the top rule carries the facts the row leaves out. */
	foot(width: number): string[] {
		const record = this.source.record();
		const hue = agentHue(record?.model);
		const facts = record ? this.facts(record) : "";
		const label = facts ? ` ${facts} ` : "";
		const room = Math.max(0, width - visibleWidth(label) - 1);
		const top = `${this.paint(hue, "─".repeat(room))}${this.paint("dim", truncateToWidth(label, Math.max(0, width - 1)))}${this.paint(hue, "─")}`;
		return [top, ` ${this.composer(width - 2)}`, this.paint(hue, "─".repeat(width))];
	}

	private facts(record: AgentRecord): string {
		const context = record.contextTokens && record.contextWindow ? `ctx ${Math.round((100 * record.contextTokens) / record.contextWindow)}%` : "";
		const calls = `${record.toolCalls} tool ${record.toolCalls === 1 ? "call" : "calls"}`;
		return [context, calls, record.runs > 1 && `${record.runs} runs`, record.readOnly && "read-only", record.parent !== "main" && `under ${record.parent}`].filter(Boolean).join(" · ");
	}

	keys(): readonly SheetKey[] {
		return this.draft ? KEYS_DRAFT : KEYS;
	}

	notice(): { text: string; color: string } | undefined {
		return this.shownNotice && Date.now() - this.shownNotice.at < NOTICE_MS ? this.shownNotice : undefined;
	}

	/** Always redraws: its row moves while it runs, and a message can resume it at any time. */
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
		const label = `→ ${record.name} `;
		const hue = agentHue(record.model);
		const caret = this.paint(hue, "▏");
		if (!this.draft) return `${this.paint(hue, label)}${caret}${this.paint("dim", record.state === "idle" ? "write to resume it" : "write to it")}`;
		const room = Math.max(4, width - visibleWidth(label) - 1);
		const draft = this.draft.length > room ? `…${this.draft.slice(-(room - 1))}` : this.draft;
		return `${this.paint(hue, label)}${draft}${caret}`;
	}
}

export type InspectorHost = SheetHost;

export function openAgentInspector(ui: InspectorHost, source: InspectorSource): ShownOverlay {
	return openSheet(ui, (theme, tui) => new AgentView(theme as unknown as Theme, source, tui as unknown as TUI, () => tui.requestRender()));
}
