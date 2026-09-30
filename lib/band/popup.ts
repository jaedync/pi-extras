/**
 * What a click on a tool row opens: the row's live band, where it ran, the
 * full command (or every step of a chain), then all of its output, over the
 * whole terminal (see sheet.ts). For a chain, a step is picked with a click,
 * its number, tab or the arrow keys, and the output narrows to it.
 *
 * The popup knows nothing about tools; a source supplies each part, read
 * again on every frame so a running call stays live.
 */
import { matchesKey, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { ShownOverlay } from "./modal.ts";
import { openSheet, type SheetCopy, type SheetHost, type SheetKey, type SheetSource, type SheetTheme } from "./sheet.ts";

export type PopupTheme = SheetTheme;

export interface PopupSource {
	/** The title bar's words, e.g. `bash · 3 commands`. */
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
	/** What the title bar can copy; the default is the output of the selected step. */
	copies?(selected: number): readonly SheetCopy[];
}

/** Output is copied unwrapped; nothing a tool prints is this wide. */
export const UNWRAPPED = 1_000_000;

export const plainText = (lines: readonly string[]): string => lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");

/** The popup's parts for the sheet: the source's, plus which step is selected. */
export class PopupView implements SheetSource {
	private selected: number;
	private readonly theme: PopupTheme;
	private readonly source: PopupSource;

	constructor(theme: PopupTheme, source: PopupSource) {
		this.theme = theme;
		this.source = source;
		this.selected = source.firstStep();
	}

	/** Exposed for tests. */
	get step(): number {
		return this.selected;
	}

	private fg(key: string, text: string): string {
		try { return this.theme.fg(key, text); } catch { return text; }
	}

	title(): string {
		return this.source.label();
	}

	band(width: number): string {
		return this.source.band(this.theme, width);
	}

	private details(): string[] {
		const details = this.source.details();
		return details ? [this.fg("muted", details)] : [];
	}

	head(width: number, rows: number): string[] {
		let head = this.source.head(this.theme, width, this.selected);
		// A single command the band already shows whole isn't repeated under it; the sheet
		// draws the band two columns wider than the head. Wrapping only adds whitespace.
		const squeeze = (text: string) => stripTerminalSequences(text).replace(/\s+/g, "");
		if (this.source.stepCount() === 0 && squeeze(this.band(width + 2)).includes(squeeze(head.join(" ")))) head = [];
		const lines = [...this.details(), ...head];
		if (lines.length <= rows) return lines;
		const kept = lines.slice(0, Math.max(0, rows - 1));
		return rows > 0 ? [...kept, this.fg("muted", `… ${lines.length - kept.length} more lines`)] : [];
	}

	pick(line: number): boolean {
		const step = line - this.details().length;
		if (step < 0 || step >= this.source.stepCount()) return false;
		this.select(step);
		return true;
	}

	bodyLabel(): string {
		return this.source.outputLabel(this.selected);
	}

	bodyKey(): number {
		return this.selected;
	}

	body(width: number): string[] {
		const lines = this.source.output(this.theme, width, this.selected);
		return lines.length > 0 ? lines : [this.fg("dim", truncateToWidth(this.source.live() ? "(no output yet)" : "(no output)", width))];
	}

	copies(): readonly SheetCopy[] {
		return this.source.copies?.(this.selected)
			?? [{ label: "copy output", key: "o", text: () => plainText(this.source.output(this.theme, UNWRAPPED, this.selected)) || undefined }];
	}

	keys(): readonly SheetKey[] {
		const steps = this.source.stepCount();
		const copy = this.copies().filter((item) => item.key).map((item) => ({ key: item.key!, label: item.label }));
		const pick = steps > 0 ? [{ key: `1–${Math.min(9, steps)}`, label: "step" }] : [];
		return [{ key: "esc", label: "close" }, ...pick, { key: "↑↓", label: "scroll" }, ...copy, { key: "g/G", label: "top/end" }];
	}

	live(): boolean {
		return this.source.live();
	}

	key(data: string): boolean {
		const steps = this.source.stepCount();
		if (steps === 0) return false;
		const digit = Number(data);
		if (/^[1-9]$/.test(data) && digit <= steps) this.select(digit - 1);
		else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.select((this.selected + 1) % steps);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.select((this.selected - 1 + steps) % steps);
		else return false;
		return true;
	}

	private select(step: number): void {
		this.selected = step;
	}
}

export type PopupHost = SheetHost;

/** Shows the popup over the whole terminal. */
export function openPopup(ui: PopupHost, source: PopupSource): ShownOverlay {
	return openSheet(ui, (theme) => new PopupView(theme, source), { copy: copyToClipboard });
}
