/**
 * shell-jobs-inspector: the live job view.
 *
 * A click on a job's transcript row, its row above the editor, or `/jobs`
 * opens one of these over the whole terminal (see band/sheet.ts): the job's
 * live band (its progress, as above the editor), id and pid, the full
 * command (not the flattened preview), cwd and log path, then the tail of
 * the log, re-read every frame while the process is alive. It reads the runtime's job record through a
 * lookup on every frame, so it follows the job through running, stopping and
 * done, and notices when the record is evicted.
 *
 * Output is wrapped, not cut, because the end of a long line is usually where
 * the error is. The view follows the end of the log until the reader scrolls
 * up, and resumes following when they scroll back to the bottom.
 */
import { statSync } from "node:fs";
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ShownOverlay } from "./band/modal.ts";
import type { Motion } from "./band/band.ts";
import { openSheet, type SheetCopy, type SheetHost, type SheetKey, type SheetSource } from "./band/sheet.ts";
import { overwritten } from "./band/job-look.ts";
import { factsOf, jobRow, liveRow } from "./shell-jobs-band.ts";
import { commandPreview, readLogWindow, sanitizeControl } from "./shell-jobs-core.ts";
import { type Job, jobStatusText } from "./shell-jobs-process.ts";
import type { Progress } from "./shell-jobs-progress.ts";
import { formatElapsed } from "./shell-jobs-widget.ts";

// Enough for a build's last few screens; the log path is shown for the rest.
export const INSPECTOR_TAIL_BYTES = 64 * 1024;
// What `copy output` takes from the log: all of any ordinary run.
export const INSPECTOR_COPY_BYTES = 4 * 1024 * 1024;
// A command block is capped so a pasted script cannot push the output away.
export const INSPECTOR_COMMAND_LINES = 8;
const INSPECTOR_FLAT_BYTES = 4096;
const OMITTED_MARKER = "\u2026 earlier output omitted; read the log for the rest";
const KEYS: readonly SheetKey[] = [
	{ key: "esc", label: "close" },
	{ key: "\u2191\u2193", label: "scroll" },
	{ key: "c", label: "copy command" },
	{ key: "o", label: "copy output" },
	{ key: "g/G", label: "top/end" },
];

/** Reads the current record of the job on every refresh; undefined once evicted. */
export type JobLookup = () => Job | undefined;
/** How far along a running job is and whether it has gone quiet, as its row above the editor shows it. */
export type ProgressLookup = (job: Job, now: number) => { readonly progress?: Progress; readonly quiet?: boolean };

type PaintKey = "accent" | "border" | "dim" | "muted" | "success" | "error" | "warning" | "toolTitle" | "toolOutput";

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

/** One job's parts for the sheet, read fresh every frame. */
export class JobView implements SheetSource {
	private job: Job | undefined;
	private tracked = true;
	private text = "";
	private truncated = false;
	private logBytes = -1;
	private lastState: string | null = null;
	private version = 0;
	private wrapped: { width: number; version: number; state: string; lines: string[] } | undefined;
	private readonly theme: Theme;
	private readonly lookup: JobLookup;
	private readonly now: () => number;
	private readonly motion: () => Motion;
	private readonly progressOf: ProgressLookup;

	constructor(theme: Theme, lookup: JobLookup, now: () => number = Date.now, motion: () => Motion = () => "full", progressOf: ProgressLookup = () => ({})) {
		this.theme = theme;
		this.lookup = lookup;
		this.now = now;
		this.motion = motion;
		this.progressOf = progressOf;
		this.refresh();
	}

	private fg(key: PaintKey, text: string): string {
		try { return this.theme.fg(key, text); } catch { return text; }
	}

	frame(): void {
		this.refresh();
	}

	/** Re-read the job record and, when the log grew or the state changed, the log window. */
	refresh(): void {
		const job = this.lookup();
		if (job === undefined) {
			this.tracked = false;
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
			const shown = overwritten(window.text);
			this.text = shown.endsWith("\n") ? shown.slice(0, -1) : shown;
			this.truncated = window.truncated;
			this.logBytes = bytes;
			this.version += 1;
		}
		this.lastState = job.state;
	}

	title(): string {
		return this.job ? `${this.job.title ?? this.job.id} \u00b7 shell job` : "Shell job";
	}

	/** The live band while this session runs the job; the transcript's still one once it no longer does. */
	band(width: number): string {
		const job = this.job;
		if (job === undefined) return this.fg("warning", truncateToWidth(" no job", width)).padEnd(width);
		const now = this.now();
		if (!this.tracked) return jobRow(this.theme, factsOf(job), { width, now });
		// No output line on the band: the log is right under it.
		const { progress, quiet } = this.progressOf(job, now);
		return liveRow(this.theme, job, { width, now, motion: this.motion(), ...(progress ? { progress } : {}), ...(quiet ? { quiet } : {}) });
	}

	head(width: number, rows: number): string[] {
		const job = this.job;
		if (job === undefined || rows === 0) return [];
		const lost = this.tracked ? "" : `no longer tracked in this session \u00b7 last seen ${jobStatusText(job)} \u00b7 `;
		const fixed = [
			`${this.fg("warning", lost)}${this.fg("dim", detailsOf(job, this.now()))}`,
			this.fg("muted", `cwd ${fitTail(job.cwd, width - 4)}`),
			this.fg("muted", `log ${fitTail(job.logPath, width - 4)}`),
		];
		// The band above shows a command that fits on its line; a longer one gets the rows the facts leave, up to its own cap.
		// Whether the band line above (drawn at the sheet's full width) shows the whole command, uncut.
		const flat = commandPreview(job.command, INSPECTOR_FLAT_BYTES);
		const whole = !/\n/.test(job.command.trim()) && flat === sanitizeControl(job.command).trim() && stripTerminalSequences(this.band(width + 2)).includes(`$ ${flat} `);
		const command = whole ? [] : this.commandLines(job, width, Math.max(1, Math.min(INSPECTOR_COMMAND_LINES, rows - fixed.length)));
		return [fixed[0]!, ...command, fixed[1]!, fixed[2]!].slice(0, rows);
	}

	private commandLines(job: Job, width: number, max: number): string[] {
		const wrapped = wrapTextWithAnsi(`$ ${sanitizeControl(job.command)}`, width);
		if (wrapped.length <= max) return wrapped.map((line) => this.fg("toolTitle", line));
		const kept = wrapped.slice(0, Math.max(0, max - 1)).map((line) => this.fg("toolTitle", line));
		return [...kept, this.fg("muted", `\u2026 (+${wrapped.length - kept.length} more lines)`)];
	}

	bodyLabel(): string {
		return this.truncated ? `output \u00b7 last ${INSPECTOR_TAIL_BYTES / 1024} KB` : "output";
	}

	/** Wrapped output lines, cached until the width, the log, or the state changes. */
	body(width: number): string[] {
		const state = this.tracked ? (this.job?.state ?? "gone") : "gone";
		const cached = this.wrapped;
		if (cached !== undefined && cached.width === width && cached.version === this.version && cached.state === state) return cached.lines;
		let lines: string[];
		if (this.text.length === 0) {
			lines = [this.fg("dim", state === "done" || state === "gone" ? "(no output)" : "(no output yet)")];
		} else {
			lines = wrapTextWithAnsi(this.text, width).map((line) => this.fg("toolOutput", line));
			if (this.truncated) lines.unshift(this.fg("dim", truncateToWidth(OMITTED_MARKER, width, "\u2026")));
		}
		this.wrapped = { width, version: this.version, state, lines };
		return lines;
	}

	copies(): readonly SheetCopy[] {
		const job = this.job;
		return [
			{ label: "copy command", key: "c", text: () => job?.command },
			{ label: "copy output", key: "o", text: () => (job ? readLogWindow(job.logPath, INSPECTOR_COPY_BYTES).text.replace(/\n$/, "") || undefined : undefined) },
		];
	}

	keys(): readonly SheetKey[] {
		return KEYS;
	}

	live(): boolean {
		return this.tracked && this.job !== undefined && this.job.state !== "done";
	}
}

/** Show the inspector over the whole terminal. */
export function openInspector(ui: SheetHost, lookup: JobLookup, motion?: () => Motion, progressOf?: ProgressLookup): ShownOverlay {
	return openSheet(ui, (theme) => new JobView(theme as unknown as Theme, lookup, Date.now, motion, progressOf), { copy: copyToClipboard });
}

export type InspectorHost = SheetHost;

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
