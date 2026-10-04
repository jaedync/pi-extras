/**
 * The full-screen view a click on a row opens: a tool call, a shell job or a
 * subagent, drawn over the whole terminal. A title bar says what it is and
 * holds copy buttons and a close button. Under it sit the lines that stay
 * put: the row's live band, its facts, the command or task. Then comes the
 * output or transcript, which scrolls, shows a scrollbar when it overflows
 * and follows the end while the thing runs. Last come any composer and a
 * footer of keys.
 *
 * It covers everything, so nothing outside it can be clicked: Esc, q or the
 * close button closes it. While something else has the keyboard (a prompt
 * Pi shows in the editor's place, Pi's search) it draws nothing, so that
 * thing is seen rather than answered blind; Pi hands the keyboard back when
 * it is done, and the view returns. A press on text is left to Pi, whose selection
 * copies whole screen rows, so the view draws no side borders, and its
 * scrollbar is colored spaces rather than glyphs: a copied line ends in
 * spaces, which the copy trims. The content knows nothing about the frame: a source
 * supplies each part, read again every frame so a running call stays live.
 *
 * A source can drop the band, head and rule to read as a plain conversation
 * (the agent inspector), and can set one ground color for the whole view so
 * it doesn't read as main's transcript.
 */
import {
	decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth,
	type Component, type Focusable, type OverlayOptions, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { paintFg } from "./band.ts";
import { everyFrame } from "./clock.ts";
import { bgSgr, mix, parseAnsiColor, type Rgb } from "./color.ts";
import { OnScreen, type OverlayPresence, type ShownOverlay } from "./modal.ts";
import { paletteFrom, type BandTheme } from "./palette.ts";
import { bodyBackground, onBackground, panelBackground } from "./surface.ts";

export interface SheetKey {
	readonly key: string;
	readonly label: string;
}

export interface SheetCopy {
	/** The button's words, e.g. `copy output`. */
	readonly label: string;
	/** A letter that copies it too, when the view isn't typing. */
	readonly key?: string;
	/** What it copies; undefined while there is nothing yet. */
	readonly text: () => string | undefined;
}

export interface SheetSource {
	/** Called at the start of every frame, before any part is read: a place to pick up new state. */
	frame?(): void;
	/** What this is, bold at the left of the title bar: `bash · 3 commands`, `Shell job`. */
	title(): string;
	/** The row's live band, across the full width under the title bar; none when absent. */
	band?(width: number): string;
	/** Lines that stay put under the band (facts, the command, steps, a task), at most `rows`. */
	head(width: number, rows: number): string[];
	/** A click on a head line, counted from 0; true when it did something. */
	pick?(line: number): boolean;
	/** The label on the rule above the body: `output`, `output of 2 · npm test`. No rule when absent. */
	bodyLabel?(): string;
	/** Every body line, styled and wrapped to `width`. */
	body(width: number): string[];
	/** Names what the body shows; when it changes (another step), the view goes back to following the end. */
	bodyKey?(): unknown;
	/** A click on a body line, counted from the body's first line; true when it did something. */
	pickBody?(line: number): boolean;
	/** A click on the body for components drawn in it: `y` counts from the body's first line, `x` from where its lines start. */
	bodyMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	/**
	 * Body lines to keep in view, such as a selected item. While a source names
	 * some, its body stays put instead of following the end, and scrolls only
	 * as far as it must when they change.
	 */
	focus?(): { readonly line: number; readonly rows: number } | undefined;
	/** Lines between the body and the footer, e.g. a composer. */
	foot?(width: number): string[];
	copies?(): readonly SheetCopy[];
	/** The footer's keys, most important first; ones that don't fit are dropped from the end. */
	keys(): readonly SheetKey[];
	/** A message that stands in for the keys for a while. */
	notice?(): { readonly text: string; readonly color: string } | undefined;
	/** Whether the view redraws every frame, as it does while its call runs. */
	live(): boolean;
	/** Offered every key first (steps, typing); true when it used the key. */
	key?(data: string): boolean;
	/** Letters are text for the view, so q, j, k, g, G and the copy letters are not shortcuts. */
	readonly typing?: boolean;
	/** The title's color, when it isn't the tool color: a theme key or `#rrggbb` (an agent's provider color). */
	titleColor?(): string;
	/** A styled line that takes the title's place, cut to `width`, such as an agent's live row. */
	titleLine?(width: number): string;
	/** One color the whole view sits on; the title bar and footer sit a step above it. */
	ground?(): Rgb | undefined;
	/** Body and foot lines bring their own margins, as Pi's chat components do, so the view adds none. */
	readonly flush?: boolean;
}

export interface SheetTheme extends BandTheme {
	bold(text: string): string;
}

export interface SheetTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

export interface SheetOptions {
	readonly copy?: (text: string) => Promise<unknown>;
}

export const COPIED = "✓ copied";
export const COPIED_MS = 1_500;
export const NOTICE_MS = 4_000;
/** Where Pi puts an overlay that covers the terminal. */
export const SHEET_OVERLAY: OverlayOptions = { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 };
// The head never takes more than this, so a long script can't push the output away.
const HEAD_MAX = 12;
const MIN_BODY = 3;
const GAP = "   ";
const CLOSE = "✕";
// How far a ground's bars lean toward the muted text color, so they read as frame.
const GROUND_BAR_LIFT = 0.08;
// Below these heights the title bar, then the footer, then the rule give their row to the body.
const TITLE_ROWS = 8;
const FOOTER_ROWS = 5;
const RULE_ROWS = 4;

type Hover = { kind: "copy"; index: number } | { kind: "close" } | { kind: "bar" } | null;
interface Hits {
	title: number;
	buttons: { x0: number; x1: number; index: number }[];
	close: [number, number] | null;
	headTop: number;
	headRows: number;
	bodyTop: number;
	bodyRows: number;
	bodyLeft: number;
	bodyWidth: number;
	bar: number;
	thumb: { top: number; height: number } | null;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const noClipboard = async () => { throw new Error("no clipboard here"); };

export class Sheet implements Component, Focusable {
	private hasKeys = false;
	private hadKeys = false;
	private scroll = 0;
	private follow = true;
	private viewport = MIN_BODY;
	private maxScroll = 0;
	private total = 0;
	private shownKey: unknown;
	private shownFocus: string | undefined;
	private hover: Hover = null;
	private drag: { grab: number } | null = null;
	private readonly copiedAt = new Map<number, number>();
	private flash: { text: string; color: string; at: number } | null = null;
	private hits: Hits = { title: -1, buttons: [], close: null, headTop: 0, headRows: 0, bodyTop: 0, bodyRows: 0, bodyLeft: 0, bodyWidth: 0, bar: -1, thumb: null };
	private stopFrames: (() => void) | null = null;
	private closed = false;
	private readonly screen = new OnScreen();
	private readonly copyText: (text: string) => Promise<unknown>;
	private readonly tui: SheetTui;
	private readonly theme: SheetTheme;
	private readonly source: SheetSource;
	private readonly onClose: () => void;

	constructor(tui: SheetTui, theme: SheetTheme, source: SheetSource, onClose: () => void, options: SheetOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.source = source;
		this.onClose = onClose;
		this.copyText = options.copy ?? noClipboard;
		this.tick();
	}

	/** Pi's handle for this overlay, from `onHandle`. */
	attach(handle: OverlayPresence): void {
		this.screen.attach(handle);
	}

	/** Set by Pi when the keyboard comes to or leaves this view. */
	get focused(): boolean {
		return this.hasKeys;
	}

	set focused(value: boolean) {
		this.hasKeys = value;
		this.hadKeys ||= value;
		this.tui.requestRender();
	}

	isOpen(): boolean {
		return !this.closed && this.screen.shown();
	}

	private fg(key: string, text: string): string {
		return paintFg(this.theme, key, text);
	}

	private bold(text: string): string {
		try { return this.theme.bold(text); } catch { return text; }
	}

	/** Frames run while the source is live or a `✓ copied` or notice is showing. */
	private busy(now = Date.now()): boolean {
		const copied = [...this.copiedAt.values()].some((at) => now - at < COPIED_MS);
		return this.source.live() || copied || (this.flash !== null && now - this.flash.at < NOTICE_MS);
	}

	private tick(): void {
		if (this.closed || this.stopFrames !== null || !this.busy()) return;
		this.stopFrames = everyFrame(() => {
			// Taken off screen without being closed: nothing else will stop this.
			if (!this.screen.shown()) return this.dispose();
			this.tui.requestRender();
			if (!this.busy()) this.stopTimer();
		});
	}

	private stopTimer(): void {
		this.stopFrames?.();
		this.stopFrames = null;
	}

	handleInput(data: string): void {
		if (this.source.key?.(data)) {
			this.tick();
			return this.tui.requestRender();
		}
		const typing = this.source.typing === true;
		// Kitty-protocol terminals send letters as escape sequences.
		const letter = typing ? undefined : (decodeKittyPrintable(data) ?? data);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || letter === "q") return this.close();
		const copy = letter === undefined ? -1 : (this.source.copies?.() ?? []).findIndex((item) => item.key === letter);
		if (copy >= 0) return void this.copy(copy);
		if (matchesKey(data, "up") || letter === "k") this.scrollTo(this.scroll - 1);
		else if (matchesKey(data, "down") || letter === "j") this.scrollTo(this.scroll + 1);
		else if (matchesKey(data, "pageUp") || letter === "b") this.scrollTo(this.scroll - this.viewport);
		else if (matchesKey(data, "pageDown") || letter === " ") this.scrollTo(this.scroll + this.viewport);
		else if (matchesKey(data, "home") || letter === "g") this.scrollTo(0);
		else if (matchesKey(data, "end") || letter === "G") this.scrollTo(this.maxScroll);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hits = this.hits;
		const onBar = event.x === hits.bar && event.y >= hits.bodyTop && event.y < hits.bodyTop + hits.bodyRows && hits.thumb !== null;
		switch (event.type) {
			case "wheel":
				this.scrollTo(this.scroll + (event.wheelDelta ?? 0));
				return { handled: true };
			case "move": {
				const next = this.hoverAt(event.x, event.y, onBar);
				const changed = JSON.stringify(next) !== JSON.stringify(this.hover);
				this.hover = next;
				return { handled: true, render: changed };
			}
			case "press":
				if (!onBar || event.button !== "left") return undefined;
				this.drag = { grab: this.grabOffset(event.y) };
				this.dragTo(event.y);
				return { capture: true };
			case "drag":
				if (!this.drag) return undefined;
				this.dragTo(event.y);
				return { handled: true };
			case "release":
				if (!this.drag) return undefined;
				this.drag = null;
				return { handled: true };
			case "click":
				return this.clicked(event);
			default:
				return undefined;
		}
	}

	private clicked(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		const hits = this.hits;
		if (event.y === hits.title) {
			const button = hits.buttons.find((hit) => event.x >= hit.x0 && event.x < hit.x1);
			if (button) void this.copy(button.index);
			else if (hits.close && event.x >= hits.close[0] && event.x < hits.close[1]) this.close();
			else return undefined;
			return { handled: true };
		}
		const line = event.y - hits.headTop;
		if (line >= 0 && line < hits.headRows && this.source.pick?.(line)) {
			this.tui.requestRender();
			return { handled: true };
		}
		const row = event.y - hits.bodyTop;
		if (row < 0 || row >= hits.bodyRows || event.x >= hits.bar) return undefined;
		const used = this.source.bodyMouse?.({ ...event, x: event.x - hits.bodyLeft, y: this.scroll + row, width: hits.bodyWidth, height: this.total }) !== undefined
			|| this.source.pickBody?.(this.scroll + row) === true;
		if (!used) return undefined;
		this.tui.requestRender();
		return { handled: true };
	}

	private hoverAt(x: number, y: number, onBar: boolean): Hover {
		if (onBar) return { kind: "bar" };
		if (y !== this.hits.title) return null;
		const button = this.hits.buttons.find((hit) => x >= hit.x0 && x < hit.x1);
		if (button) return { kind: "copy", index: button.index };
		const close = this.hits.close;
		return close && x >= close[0] && x < close[1] ? { kind: "close" } : null;
	}

	/** Where in the thumb the pointer holds it; a press on the track grabs the thumb's middle, as Pi's scrollbar does. */
	private grabOffset(y: number): number {
		const thumb = this.hits.thumb!;
		const row = y - this.hits.bodyTop;
		return row >= thumb.top && row < thumb.top + thumb.height ? row - thumb.top : Math.floor(thumb.height / 2);
	}

	private dragTo(y: number): void {
		const thumb = this.hits.thumb;
		if (!thumb || !this.drag) return;
		const room = this.hits.bodyRows - thumb.height;
		const top = clamp(y - this.hits.bodyTop - this.drag.grab, 0, room);
		this.scrollTo(room === 0 ? 0 : Math.round((top / room) * this.maxScroll));
	}

	private async copy(index: number): Promise<void> {
		const text = this.source.copies?.()[index]?.text();
		if (!text) return this.say("Nothing to copy yet.", "dim");
		try {
			await this.copyText(text);
			this.copiedAt.set(index, Date.now());
		} catch (error) {
			this.say(`Couldn't copy: ${(error as Error).message}`, "error");
		}
		this.tick();
		this.tui.requestRender();
	}

	private say(text: string, color: string): void {
		this.flash = { text, color, at: Date.now() };
		this.tick();
		this.tui.requestRender();
	}

	private scrollTo(target: number): void {
		const next = clamp(target, 0, this.maxScroll);
		this.follow = next >= this.maxScroll;
		this.scroll = next;
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		this.stopTimer();
	}

	/** A source asking for its own sheet to close; openSheet hands it this. */
	requestClose(): void {
		this.close();
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.onClose();
	}

	render(width: number): string[] {
		this.screen.drew();
		// Stepped aside for whatever took the keyboard; still open, so Pi can hand it back.
		if (this.hadKeys && !this.hasKeys) return [];
		this.source.frame?.();
		const w = Math.max(1, width);
		const h = Math.max(1, this.tui.terminal.rows);
		const now = Date.now();
		const flush = this.source.flush === true;
		const shows = { title: h >= TITLE_ROWS, footer: h >= FOOTER_ROWS, rule: h >= RULE_ROWS && this.source.bodyLabel !== undefined, band: this.source.band !== undefined };
		const foot = this.source.foot?.(Math.max(1, flush ? w : w - 2)) ?? [];
		const fixed = Number(shows.band) + foot.length + Number(shows.title) + Number(shows.footer) + Number(shows.rule);
		const headRoom = clamp(h - fixed - MIN_BODY, 0, HEAD_MAX);
		const head = this.source.head(Math.max(1, w - 2), headRoom).slice(0, headRoom);
		const bodyRows = Math.max(0, h - fixed - head.length);
		const { chrome, gray, ground } = this.backgrounds();
		const out: string[] = [];
		const title = shows.title ? out.push(...onBackground([this.titleBar(w, now)], w, chrome)) - 1 : -1;
		if (shows.band) out.push(this.source.band!(w));
		const headTop = out.length;
		// Lines the source didn't fit end in an ellipsis rather than a cut word.
		const fit = (line: string) => ` ${truncateToWidth(line, Math.max(1, w - 2), "…")}`;
		out.push(...onBackground(head.map(fit), w, gray));
		const body = this.body(w, bodyRows);
		if (shows.rule) out.push(this.rule(w));
		const bodyTop = out.length;
		out.push(...(ground ? onBackground(body, w, ground) : body));
		out.push(...onBackground(flush ? foot.map((line) => truncateToWidth(line, w, "…")) : foot.map(fit), w, gray));
		if (shows.footer) out.push(...onBackground([this.footer(w, now)], w, chrome));
		this.hits = { ...this.hits, title, headTop, headRows: head.length, bodyTop, bodyRows };
		return out.slice(0, h).map((line) => truncateToWidth(line, w, "", true));
	}

	/** Behind the bars, the head and foot, and the body: the theme's grays, or the source's ground and a step above it. */
	private backgrounds(): { chrome: string | undefined; gray: string | undefined; ground: string | undefined } {
		const rgb = this.source.ground?.();
		const palette = rgb ? paletteFrom(this.theme) : undefined;
		if (!rgb || !palette) return { chrome: panelBackground(this.theme), gray: bodyBackground(this.theme), ground: undefined };
		const ground = bgSgr(rgb, palette.mode);
		return { chrome: bgSgr(mix(rgb, palette.muted, GROUND_BAR_LIFT), palette.mode), gray: ground, ground };
	}

	/** The body's rows at the current scroll, each with its scrollbar cell. */
	private body(w: number, rows: number): string[] {
		const margin = this.source.flush === true ? "" : " ";
		const inner = Math.max(1, w - 2 - margin.length);
		const key = this.source.bodyKey?.();
		if (key !== this.shownKey) this.follow = true;
		this.shownKey = key;
		const lines = this.source.body(inner);
		this.total = lines.length;
		this.viewport = Math.max(1, rows);
		this.maxScroll = Math.max(0, lines.length - rows);
		this.keepFocus();
		this.scroll = this.follow ? this.maxScroll : clamp(this.scroll, 0, this.maxScroll);
		const overflow = rows > 0 && lines.length > rows;
		// Pi's scrollbar geometry, so both bars move alike.
		const height = overflow ? Math.max(Math.min(2, rows), Math.min(rows, Math.round((rows * rows) / lines.length))) : 0;
		const thumb = overflow ? { top: this.maxScroll === 0 ? 0 : Math.round((this.scroll / this.maxScroll) * (rows - height)), height } : null;
		this.hits = { ...this.hits, bar: w - 1, thumb, bodyLeft: margin.length, bodyWidth: inner };
		const colors = thumb ? this.barColors(this.drag !== null || this.hover?.kind === "bar") : undefined;
		const cell = (row: number) => {
			if (!thumb) return " ";
			const inThumb = row >= thumb.top && row < thumb.top + thumb.height;
			// A theme whose colors can't be read back gets Pi's glyphs instead.
			if (!colors) return this.fg(inThumb ? "scrollbarThumb" : "scrollbarTrack", inThumb ? "┃" : "│");
			return `${inThumb ? colors.thumb : colors.track} \x1b[49m`;
		};
		return Array.from({ length: rows }, (_, row) => `${margin}${truncateToWidth(lines[this.scroll + row] ?? "", inner, "…", true)} ${cell(row)}`);
	}

	/**
	 * Scrolls just far enough to show the lines the source names, once each
	 * time they change. Scrolling to the bottom would otherwise set the view
	 * following again, and new lines would carry the focus out of sight.
	 */
	private keepFocus(): void {
		const focus = this.source.focus?.();
		const key = focus ? `${focus.line}:${focus.rows}` : undefined;
		if (focus) this.follow = false;
		if (focus && key !== this.shownFocus) {
			this.scroll = clamp(clamp(this.scroll, focus.line + focus.rows - this.viewport, focus.line), 0, this.maxScroll);
		}
		this.shownFocus = key;
	}

	/** The scrollbar's backgrounds, from the colors Pi's own scrollbar uses; brighter while held or hovered. */
	private barColors(active: boolean): { thumb: string; track: string } | undefined {
		const palette = paletteFrom(this.theme);
		const read = (key: string): Rgb | undefined => {
			try { return parseAnsiColor(this.theme.getFgAnsi(key)); } catch { return undefined; }
		};
		const thumb = read("scrollbarThumb") ?? palette?.muted;
		if (!palette || !thumb) return undefined;
		const track = mix(palette.base, read("scrollbarTrack") ?? palette.muted, 0.15);
		return { thumb: bgSgr(active ? mix(thumb, palette.accent, 0.5) : thumb, palette.mode), track: bgSgr(track, palette.mode) };
	}

	private titleBar(w: number, now: number): string {
		const copies = this.source.copies?.() ?? [];
		const buttons = copies.map((copy, index) => {
			const done = now - (this.copiedAt.get(index) ?? -Infinity) < COPIED_MS;
			const hovered = this.hover?.kind === "copy" && this.hover.index === index;
			const text = (done ? COPIED : copy.label).padEnd(Math.max(copy.label.length, COPIED.length));
			return { index, width: visibleWidth(text), painted: this.fg(done ? "success" : hovered ? "accent" : "muted", text) };
		});
		const close = this.fg(this.hover?.kind === "close" ? "accent" : "muted", CLOSE);
		const line = this.source.titleLine;
		const label = line ? "" : this.source.title();
		// Buttons give way from the end before the title is cut; the close button stays.
		let shown = buttons;
		const rightWidth = () => shown.reduce((sum, button) => sum + button.width + GAP.length, 0) + visibleWidth(CLOSE) + 1;
		while (shown.length > 0 && 1 + visibleWidth(label) + 2 + rightWidth() > w) shown = shown.slice(0, -1);
		const titleRoom = Math.max(0, w - 1 - rightWidth() - 1);
		const title = line ? truncateToWidth(line.call(this.source, titleRoom), titleRoom, "…")
			: this.fg(this.source.titleColor?.() ?? "toolTitle", this.bold(truncateToWidth(label, titleRoom, "…")));
		let x = w - rightWidth();
		const hits: Hits["buttons"] = [];
		for (const button of shown) {
			hits.push({ x0: x, x1: x + button.width, index: button.index });
			x += button.width + GAP.length;
		}
		// The ✕ takes a column either side, so it is easy to hit.
		this.hits = { ...this.hits, buttons: hits, close: [x - 1, x + 2] };
		const right = `${shown.map((button) => button.painted).join(GAP)}${shown.length ? GAP : ""}${close} `;
		const gap = Math.max(1, w - 1 - visibleWidth(title) - visibleWidth(right));
		return ` ${title}${" ".repeat(gap)}${right}`;
	}

	private rule(w: number): string {
		const rows = this.viewport;
		const position = this.total === 0 ? ""
			: this.total <= rows ? `${this.total} ${this.total === 1 ? "line" : "lines"}`
			: `${this.scroll + 1}–${Math.min(this.total, this.scroll + rows)} of ${this.total}${this.follow && this.source.live() ? " · following" : ""}`;
		const right = position ? ` ${position} ` : "";
		const label = truncateToWidth(this.source.bodyLabel?.() ?? "", Math.max(0, w - 4 - visibleWidth(right)), "…");
		const fill = Math.max(1, w - 3 - visibleWidth(label) - visibleWidth(right) - 1);
		return `${this.fg("border", "─")} ${this.fg("dim", label)} ${this.fg("border", "─".repeat(fill))}${this.fg("dim", right)}${this.fg("border", "─")}`;
	}

	private footer(w: number, now: number): string {
		const flash = this.flash && now - this.flash.at < NOTICE_MS ? this.flash : this.source.notice?.();
		if (flash) return ` ${this.fg(flash.color, truncateToWidth(flash.text, Math.max(1, w - 2), "…"))}`;
		const sep = this.fg("dim", " · ");
		let text = "";
		let used = 0;
		for (const { key, label } of this.source.keys()) {
			const width = (used ? 3 : 0) + visibleWidth(key) + 1 + visibleWidth(label);
			if (used + width > w - 2) break;
			text += `${used ? sep : ""}${this.fg("dim", key)} ${this.fg("muted", label)}`;
			used += width;
		}
		return ` ${text}`;
	}
}

export interface SheetHost {
	custom<T>(
		factory: (tui: SheetTui, theme: SheetTheme, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void },
		options: { overlay: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayPresence) => void },
	): Promise<T>;
}

/**
 * Shows a sheet over the whole terminal; `make` builds its source once Pi
 * hands over the theme, with a `close` for a source that ends its own sheet,
 * as a list does when it opens one of its items.
 */
export function openSheet(ui: SheetHost, make: (theme: SheetTheme, tui: SheetTui, close: () => void) => SheetSource, options: SheetOptions = {}): ShownOverlay {
	let sheet: Sheet | undefined;
	const close = () => sheet?.requestClose();
	const closed = ui.custom<void>(
		(tui, theme, _keybindings, done) => (sheet = new Sheet(tui, theme, make(theme, tui, close), () => done(undefined), options)),
		{ overlay: true, overlayOptions: SHEET_OVERLAY, onHandle: (handle) => sheet?.attach(handle) },
	);
	return { closed, isOpen: () => sheet?.isOpen() ?? false };
}
