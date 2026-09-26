/**
 * The popup a click on a tool row opens: the row's live band, where it ran,
 * the full command (or every step of a chain), then all of its output in a
 * scrolling view that follows the end while the call runs. For a chain, a
 * step is picked with a click or its number and the output narrows to it.
 *
 * The popup knows nothing about tools; a source supplies each part, read
 * again on every frame so a running call stays live. It sits on a panel a
 * step lighter than the tool rows beneath, and a click outside it closes it.
 */
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type OverlayOptions,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { everyFrame } from "./clock.ts";
import { closeOnOutsideClick } from "./modal.ts";
import type { BandTheme } from "./palette.ts";
import { onBackground, panelBackground } from "./surface.ts";

export interface PopupTheme extends BandTheme {
	bold(text: string): string;
}

export interface PopupSource {
	/** Shown in the top border, e.g. `bash · 3 commands`. */
	label(): string;
	band(theme: PopupTheme, width: number): string;
	/** One muted line: where it ran, the timeout, when it started. */
	details(): string;
	/** The command, or one line per step with `selected` highlighted. */
	head(theme: PopupTheme, width: number, selected: number): string[];
	/** Steps to choose between; 0 for a single call. */
	stepCount(): number;
	firstStep(): number;
	outputLabel(selected: number): string;
	/** Every output line, styled and wrapped to `width`. */
	output(theme: PopupTheme, width: number, selected: number): string[];
	/** Whether the call is still running, so the popup keeps refreshing. */
	live(): boolean;
}

export interface PopupTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

export const POPUP_FRAME_MS = 100;
export const POPUP_HEIGHT_SHARE = 0.85;
export const POPUP_WIDTH = "92%";
const MIN_ROWS = 12;
const MIN_VIEWPORT = 3;
const HEAD_MAX = 12;
const FRAME_COLUMNS = 4;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

export class Popup implements Component, Focusable {
	focused = false;
	private selected: number;
	private scroll = 0;
	private follow = true;
	private viewport = MIN_VIEWPORT;
	private maxScroll = 0;
	private headTop = 0;
	private headRows = 0;
	private stopFrames: (() => void) | null = null;
	private closed = false;
	private readonly tui: PopupTui;
	private readonly theme: PopupTheme;
	private readonly source: PopupSource;
	private readonly onClose: () => void;
	private readonly undoOutside: () => void;

	constructor(tui: PopupTui, theme: PopupTheme, source: PopupSource, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.source = source;
		this.onClose = onClose;
		this.selected = source.firstStep();
		this.undoOutside = closeOnOutsideClick(tui, () => this.close());
		this.tick();
	}

	/** Exposed for tests. */
	get step(): number {
		return this.selected;
	}

	private tick(): void {
		if (this.closed) return;
		if (this.source.live() && this.stopFrames === null) {
			this.stopFrames = everyFrame(() => {
				this.tui.requestRender();
				if (!this.source.live()) this.stop();
			}, POPUP_FRAME_MS);
		}
	}

	private stop(): void {
		this.stopFrames?.();
		this.stopFrames = null;
		// One more frame so the band settles on its final color.
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.close();
			return;
		}
		const steps = this.source.stepCount();
		const digit = Number(data);
		if (steps > 0 && /^[1-9]$/.test(data) && digit <= steps) this.select(digit - 1);
		else if (steps > 0 && (matchesKey(data, "tab") || matchesKey(data, "right"))) this.select((this.selected + 1) % steps);
		else if (steps > 0 && (matchesKey(data, "shift+tab") || matchesKey(data, "left"))) this.select((this.selected - 1 + steps) % steps);
		else if (matchesKey(data, "up") || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, "down") || data === "j") this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-this.viewport);
		else if (matchesKey(data, "pageDown")) this.scrollBy(this.viewport);
		else if (matchesKey(data, "home") || data === "g") this.scrollTo(0);
		else if (matchesKey(data, "end") || data === "G") this.scrollTo(this.maxScroll);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scrollBy(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (event.type === "click") {
			const row = event.y - this.headTop;
			if (this.source.stepCount() > 0 && row >= 0 && row < this.headRows && row < this.source.stepCount()) this.select(row);
			// A click inside the popup must not fall through to the transcript beneath.
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		this.undoOutside();
		this.stopFrames?.();
		this.stopFrames = null;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const fg = (key: string, text: string) => { try { return theme.fg(key, text); } catch { return text; } };
		const bold = (text: string) => { try { return theme.bold(text); } catch { return text; } };
		const w = Math.max(FRAME_COLUMNS + 10, width);
		const inner = w - FRAME_COLUMNS;
		const border = (text: string) => fg("border", text);
		const row = (content: string) => `${border("│")} ${truncateToWidth(content, inner, "…", true)} ${border("│")}`;
		const rule = (left: string, right: string) => border(`${left}${"─".repeat(w - 2)}${right}`);

		const label = truncateToWidth(this.source.label(), w - 6, "…");
		const top = `${border("╭─ ")}${fg("toolTitle", bold(label))}${border(` ${"─".repeat(Math.max(0, w - 5 - visibleWidth(label)))}╮`)}`;
		const bandRow = `${border("│")}${this.source.band(theme, w - 2)}${border("│")}`;
		const details = row(fg("muted", this.source.details()));
		let head = this.source.head(theme, inner, this.selected);
		if (head.length > HEAD_MAX) head = [...head.slice(0, HEAD_MAX - 1), fg("muted", `… ${head.length - HEAD_MAX + 1} more lines`)];
		this.headTop = 3;
		this.headRows = head.length;
		const outputLabel = row(fg("dim", this.source.outputLabel(this.selected)));

		// Rows that never scroll: top, band, details, head, rule, label, rule, footer, bottom.
		const fixed = 3 + head.length + 5;
		const maxRows = Math.max(MIN_ROWS, Math.floor(this.tui.terminal.rows * POPUP_HEIGHT_SHARE));
		this.viewport = Math.max(MIN_VIEWPORT, maxRows - fixed);

		const lines = this.source.output(theme, inner, this.selected);
		this.maxScroll = Math.max(0, lines.length - this.viewport);
		this.scroll = this.follow ? this.maxScroll : clamp(this.scroll, 0, this.maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + this.viewport);
		// Short output gets a short popup; it grows with a running call's output up to the cap.
		while (visible.length < Math.min(this.viewport, MIN_VIEWPORT)) visible.push("");

		const first = lines.length === 0 ? 0 : this.scroll + 1;
		const last = Math.min(lines.length, this.scroll + this.viewport);
		const position = `lines ${first}–${last} of ${lines.length}${this.follow && this.source.live() ? " · following" : ""}`;
		const steps = this.source.stepCount();
		const hint = steps > 0 ? `esc close · click a step or 1–${Math.min(9, steps)} · ↑↓ scroll` : "esc close · ↑↓ scroll · g/G top/end";
		const gap = Math.max(1, inner - visibleWidth(hint) - visibleWidth(position));
		const footer = row(fg("dim", `${hint}${" ".repeat(gap)}${position}`));

		const frame = [top, bandRow, details, ...head.map(row), rule("├", "┤"), outputLabel, ...visible.map(row), rule("├", "┤"), footer, rule("╰", "╯")];
		return onBackground(frame, w, panelBackground(theme));
	}

	private select(step: number): void {
		if (step === this.selected) return;
		this.selected = step;
		this.follow = true;
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scroll + delta);
	}

	private scrollTo(target: number): void {
		const next = clamp(target, 0, this.maxScroll);
		this.follow = next >= this.maxScroll;
		if (next === this.scroll) return;
		this.scroll = next;
		this.tui.requestRender();
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.onClose();
	}
}

export interface PopupHost {
	custom<T>(
		factory: (tui: PopupTui, theme: PopupTheme, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void },
		options: { overlay: boolean; overlayOptions?: OverlayOptions },
	): Promise<T>;
}

/** Shows the popup as a centred overlay; resolves when it closes. */
export function openPopup(ui: PopupHost, source: PopupSource): Promise<void> {
	return ui.custom<void>(
		(tui, theme, _keybindings, done) => new Popup(tui, theme, source, () => done(undefined)),
		{ overlay: true, overlayOptions: { anchor: "center", width: POPUP_WIDTH, margin: 1 } },
	);
}
