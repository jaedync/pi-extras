/**
 * shell-jobs-inspector: the live job overlay.
 *
 * A click on a job's transcript row, a widget row, or `/jobs` opens one of
 * these on top of the conversation. It shows the whole story of one job: the
 * title, the full command (not the flattened preview), cwd, pid, log path,
 * state and elapsed time, and the tail of the log, refreshed on a timer while
 * the process is alive. Escape or a click outside closes it. The overlay
 * reads the runtime's job record through a lookup on every refresh, so it
 * follows the job through running, stopping and done, and notices when the
 * record is evicted.
 *
 * Output is wrapped, not cut, because the end of a long line is usually where
 * the error is. The view follows the end of the log until the reader scrolls
 * up, and resumes following when they scroll back to the bottom.
 */
import { statSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type OverlayOptions,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { everyFrame, FRAME_MS } from "./band/clock.ts";
import { closeOnOutsideClick } from "./band/modal.ts";
import { onBackground, panelBackground } from "./band/surface.ts";
import { factsOf, jobBand } from "./shell-jobs-band.ts";
import { readLogWindow, sanitizeControl } from "./shell-jobs-core.ts";
import { type Job, jobStatusText } from "./shell-jobs-process.ts";
import { formatElapsed } from "./shell-jobs-widget.ts";

// The band's frame rate, so the job moves as it does in the widget; the log is
// only re-read when its size or the job's state changes.
export const INSPECTOR_REFRESH_MS = FRAME_MS;
// Enough for a build's last few screens; the log path is shown for the rest.
export const INSPECTOR_TAIL_BYTES = 64 * 1024;
// A command block is capped so a pasted script cannot push the output away.
export const INSPECTOR_COMMAND_LINES = 8;
// The overlay takes this share of the terminal height, never fewer rows than the minimum.
export const INSPECTOR_HEIGHT_SHARE = 0.8;
// Frame and header rows plus the smallest output viewport, for a single-line command.
export const INSPECTOR_MIN_ROWS = 13;
export const INSPECTOR_WIDTH = "80%";
// Rows of output kept visible even when the frame leaves little room.
const MIN_VIEWPORT_ROWS = 3;
// Border glyph plus one space of padding on each side.
const FRAME_COLUMNS = 4;
const OMITTED_MARKER = "\u2026 earlier output omitted; read the log for the rest";
const FOOTER_HINT = "\u2191\u2193 scroll \u00b7 PgUp/PgDn \u00b7 g/G top/end \u00b7 esc close";

/** The slice of pi's TUI handle the overlay uses. */
export interface InspectorTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

/** Reads the current record of the job on every refresh; undefined once evicted. */
export type JobLookup = () => Job | undefined;

type PaintKey = "accent" | "border" | "dim" | "muted" | "success" | "error" | "warning" | "toolTitle" | "toolOutput";

interface Paint {
	fg(key: PaintKey, text: string): string;
	bold(text: string): string;
}

/** A theme missing a key must degrade to plain text, not break the overlay. */
function painter(theme: Theme): Paint {
	return {
		fg: (key, text) => {
			try {
				return theme.fg(key, text);
			} catch {
				return text;
			}
		},
		bold: (text) => {
			try {
				return theme.bold(text);
			} catch {
				return text;
			}
		},
	};
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

/** Keep the end of a path when it is too long: the file name matters more than the temp root. */
function fitTail(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const chars = [...text];
	let kept = "";
	for (let index = chars.length - 1; index >= 0; index--) {
		const next = chars[index] + kept;
		if (visibleWidth(next) > width - 1) break;
		kept = next;
	}
	return `\u2026${kept}`;
}

/** Facts under the band: what the band does not say, and the id the model uses. */
function detailsOf(job: Job, now: number): string {
	const parts = [job.id, `pid ${job.pid}`];
	if (job.state === "done") parts.push(`${jobStatusText(job)} after ${formatElapsed((job.endedAt ?? now) - job.startedAt)}`);
	if (job.cleanupError !== null) parts.push(job.cleanupError);
	return parts.join(" \u00b7 ");
}

export class JobInspector implements Component, Focusable {
	/** Set by the TUI when focus changes; the overlay shows no cursor. */
	focused = false;

	private job: Job | undefined;
	private tracked = true;
	private text = "";
	private truncated = false;
	private logBytes = -1;
	private lastState: string | null = null;
	private version = 0;
	private wrapped: { width: number; version: number; state: string; lines: string[] } | undefined;
	private scroll = 0;
	private follow = true;
	private viewport = MIN_VIEWPORT_ROWS;
	private maxScroll = 0;
	private stopFrames: (() => void) | null = null;
	private closed = false;
	private disposed = false;
	private readonly paint: Paint;
	private readonly theme: Theme;
	private readonly tui: InspectorTui;
	private readonly lookup: JobLookup;
	private readonly onClose: () => void;
	private readonly now: () => number;
	private readonly undoOutside: () => void;

	constructor(tui: InspectorTui, theme: Theme, lookup: JobLookup, onClose: () => void, now: () => number = Date.now) {
		this.tui = tui;
		this.lookup = lookup;
		this.onClose = onClose;
		this.now = now;
		this.theme = theme;
		this.paint = painter(theme);
		this.undoOutside = closeOnOutsideClick(tui, () => this.close());
		this.refresh();
	}

	/** First visible output line; exposed for tests. */
	get scrollTop(): number {
		return this.scroll;
	}

	/** Whether the view sticks to the end of the log as it grows. */
	get following(): boolean {
		return this.follow;
	}

	/**
	 * Re-read the job record and, when the log grew or the state changed, the
	 * log window. Runs on the timer while the job is alive and once more when
	 * it finishes; a repaint is requested either way so the elapsed time ticks.
	 */
	refresh(): void {
		if (this.disposed) return;
		const job = this.lookup();
		if (job === undefined) {
			if (this.tracked) {
				this.tracked = false;
				this.stopTimer();
				this.tui.requestRender();
			}
			return;
		}
		this.job = job;
		let bytes = 0;
		try {
			bytes = statSync(job.logPath).size;
		} catch {
			// Between spawn and the first write, or after the log was removed.
		}
		if (bytes !== this.logBytes || job.state !== this.lastState) {
			const window = readLogWindow(job.logPath, INSPECTOR_TAIL_BYTES);
			this.text = window.text.endsWith("\n") ? window.text.slice(0, -1) : window.text;
			this.truncated = window.truncated;
			this.logBytes = bytes;
			this.version += 1;
		}
		this.lastState = job.state;
		if (job.state === "done") this.stopTimer();
		else this.startTimer();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, "up")) this.scrollBy(-1);
		else if (matchesKey(data, "down")) this.scrollBy(1);
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
		// A click inside the overlay must not fall through to the transcript beneath.
		if (event.type === "click") return { handled: true };
		return undefined;
	}

	invalidate(): void {
		this.wrapped = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.undoOutside();
		this.stopTimer();
	}

	render(width: number): string[] {
		const w = Math.max(FRAME_COLUMNS + 8, width);
		const inner = w - FRAME_COLUMNS;
		const { fg } = this.paint;
		const border = (text: string) => fg("border", text);
		const row = (content: string) => `${border("\u2502")} ${truncateToWidth(content, inner, "\u2026", true)} ${border("\u2502")}`;
		const rule = (left: string, right: string) => border(`${left}${"\u2500".repeat(w - 2)}${right}`);
		const job = this.job;
		const now = this.now();

		const top = rule("\u256d", "\u256e");

		const header: string[] = [];
		if (job === undefined) header.push(row(fg("warning", "no job")));
		else {
			header.push(row(jobBand(this.theme, factsOf(job), { width: inner, now, view: this.tracked ? "live" : "calm" })));
			const lost = this.tracked ? "" : `no longer tracked in this session \u00b7 last seen ${jobStatusText(job)} \u00b7 `;
			header.push(row(`${fg("warning", lost)}${fg("dim", detailsOf(job, now))}`));
			for (const line of this.commandLines(job, inner)) header.push(row(line));
			header.push(row(fg("muted", `cwd ${fitTail(job.cwd, inner - 4)}`)));
			header.push(row(fg("muted", `log ${fitTail(job.logPath, inner - 4)}`)));
		}

		// Frame rows that never scroll: top, header, two rules, footer, bottom.
		const fixed = header.length + 5;
		const maxRows = Math.max(INSPECTOR_MIN_ROWS, Math.floor(this.tui.terminal.rows * INSPECTOR_HEIGHT_SHARE));
		this.viewport = Math.max(MIN_VIEWPORT_ROWS, maxRows - fixed);

		const lines = this.outputLines(inner);
		this.maxScroll = Math.max(0, lines.length - this.viewport);
		if (this.follow) this.scroll = this.maxScroll;
		else this.scroll = clamp(this.scroll, 0, this.maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + this.viewport);
		while (visible.length < this.viewport) visible.push("");

		const first = lines.length === 0 ? 0 : this.scroll + 1;
		const last = Math.min(lines.length, this.scroll + this.viewport);
		const position = `lines ${first}\u2013${last} of ${lines.length}${this.follow ? " \u00b7 following" : ""}`;
		const gap = Math.max(1, inner - visibleWidth(FOOTER_HINT) - visibleWidth(position));
		const footer = row(fg("dim", `${FOOTER_HINT}${" ".repeat(gap)}${position}`));

		const frame = [top, ...header, rule("\u251c", "\u2524"), ...visible.map(row), rule("\u251c", "\u2524"), footer, rule("\u2570", "\u256f")];
		return onBackground(frame, w, panelBackground(this.theme));
	}

	private commandLines(job: Job, inner: number): string[] {
		const wrapped = wrapTextWithAnsi(`$ ${sanitizeControl(job.command)}`, inner);
		if (wrapped.length <= INSPECTOR_COMMAND_LINES) return wrapped.map((line) => this.paint.fg("toolTitle", line));
		const kept = wrapped.slice(0, INSPECTOR_COMMAND_LINES - 1).map((line) => this.paint.fg("toolTitle", line));
		kept.push(this.paint.fg("muted", `\u2026 (+${wrapped.length - kept.length} more lines)`));
		return kept;
	}

	/** Wrapped output lines, cached until the width, the log, or the state changes. */
	private outputLines(inner: number): string[] {
		const state = this.job?.state ?? "gone";
		const cached = this.wrapped;
		if (cached !== undefined && cached.width === inner && cached.version === this.version && cached.state === state) return cached.lines;
		let lines: string[];
		if (this.text.length === 0) {
			lines = [this.paint.fg("dim", state === "done" || state === "gone" ? "(no output)" : "(no output yet)")];
		} else {
			lines = wrapTextWithAnsi(this.text, inner).map((line) => this.paint.fg("toolOutput", line));
			if (this.truncated) lines.unshift(this.paint.fg("dim", truncateToWidth(OMITTED_MARKER, inner, "\u2026")));
		}
		this.wrapped = { width: inner, version: this.version, state, lines };
		return lines;
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scroll + delta);
	}

	/** Move the viewport; reaching the end resumes following, leaving it stops. */
	private scrollTo(target: number): void {
		const next = clamp(target, 0, this.maxScroll);
		this.follow = next >= this.maxScroll;
		if (next === this.scroll) return;
		this.scroll = next;
		this.tui.requestRender();
	}

	private startTimer(): void {
		if (this.stopFrames !== null) return;
		this.stopFrames = everyFrame(() => this.refresh(), INSPECTOR_REFRESH_MS);
	}

	private stopTimer(): void {
		this.stopFrames?.();
		this.stopFrames = null;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.undoOutside();
		this.stopTimer();
		this.onClose();
	}
}

/** The slice of pi's extension UI the inspector needs to be shown. */
export interface InspectorHost {
	custom<T>(
		factory: (tui: InspectorTui, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void },
		options: { overlay: boolean; overlayOptions?: OverlayOptions },
	): Promise<T>;
}

/** Show the inspector as a centred overlay; resolves once the reader closes it. */
export function openInspector(ui: InspectorHost, lookup: JobLookup): Promise<void> {
	return ui.custom<void>(
		(tui, theme, _keybindings, done) => new JobInspector(tui, theme, lookup, () => done(undefined)),
		{ overlay: true, overlayOptions: { anchor: "center", width: INSPECTOR_WIDTH, margin: 1 } },
	);
}

/** What a transcript row resolves to when clicked: a job this session knows, one it does not, or nothing. */
export type ClickTarget = { id: string; known: boolean } | null;

/**
 * Give a rendered tool slot a left-click action. Pi wraps each slot in its own
 * click-to-expand region but dispatches to the child first, so returning
 * `handled` here keeps the expand toggle out of the way. A row that resolves
 * to nothing returns undefined and keeps pi's default behaviour.
 */
export function clickToInspect(
	component: Component,
	resolve: () => ClickTarget,
	open: (id: string) => void,
	stale: (id: string) => void,
): Component {
	return {
		render: (width) => component.render(width),
		invalidate: () => component.invalidate(),
		handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const target = resolve();
			if (target === null) return undefined;
			if (target.known) open(target.id);
			else stale(target.id);
			return { handled: true };
		},
	};
}
