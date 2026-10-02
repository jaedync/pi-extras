/**
 * shell-jobs-widget: the background-job rows above the editor.
 *
 * One keyed widget. In the TUI each visible job is a live band (liveRow in
 * shell-jobs-band.ts): visible means still running, stopping, waiting on an
 * undelivered completion, or failed to deliver. Delivered jobs disappear so
 * the rows only ever show work that still needs attention. A click on a row
 * opens its job.
 *
 * In TUI mode it installs a factory component so it can read the live job map,
 * honor the terminal width, and use theme colors. While a job is running or
 * stopping, a timer samples each log's size and latest line and asks for a
 * render; motion is limited to that window, and a job that is only waiting
 * for delivery is static. In RPC mode a plain string array is used because a
 * component factory is not serializable, so those rows carry no spinner,
 * elapsed or activity.
 *
 * A running job answers "how far along?" with its band's fill, when its
 * command (a leading sleep) or its latest output (a curl or rsync meter, say)
 * tells (shell-jobs-progress.ts). Otherwise the band sweeps and the latest
 * output line says what it is doing. Its spinner answers "is it still
 * going?": full speed in the accent colour while the log grows, a dim
 * one-frame-a-second crawl once it has not grown for QUIET_AFTER_MS. The
 * process is alive either way (a dead one leaves the rows), so the crawl
 * says "alive but silent", the one cue that separates a slow build from a
 * hung one.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Motion } from "./band/band.ts";
import { FRAME_MS, everyFrame } from "./band/clock.ts";
import { BULLET_GLYPH, FAILURE_GLYPH, JOB_ANIMATION, JOB_STOPPING_ANIMATION, SUCCESS_GLYPH, animationFrameMs, glyphAt } from "./band/glyph.ts";
import { lastLine } from "./band/job-look.ts";
import { statSync } from "node:fs";
import { QUIET_FRAME_MS, liveRow } from "./shell-jobs-band.ts";
export { QUIET_FRAME_MS };
import { commandPreview, readLogEnd } from "./shell-jobs-core.ts";
import { minutesAndUp } from "./duration.ts";
import { type Job, jobStatusText } from "./shell-jobs-process.ts";
import { nextProgress, progressNow, sleepProgress, type Progress, type ProgressState } from "./shell-jobs-progress.ts";

export const WIDGET_ID = "shell-jobs";
export const WIDGET_MAX_ROWS = 4;
export const WIDGET_COMMAND_BYTES = 64;
// Slow enough to sit in peripheral vision; pi's foreground loader runs at 80 ms.
export const WIDGET_REFRESH_MS = 250;
// No log growth for this long puts the spinner into its quiet crawl.
export const QUIET_AFTER_MS = 30_000;
export const SPINNER_FRAMES = JOB_ANIMATION.frames;
export const STOPPING_FRAMES = JOB_STOPPING_ANIMATION.frames;
// RPC rows carry no animation clock.
const RUNNING_STATIC = BULLET_GLYPH;
const STOPPING_STATIC = JOB_STOPPING_ANIMATION.frames[JOB_STOPPING_ANIMATION.still ?? 0]!;

/** Log growth seen for a live job: its size, when it last changed, its latest line and what that says about progress. */
export interface Activity {
	readonly bytes: number;
	readonly changedAt: number;
	readonly tail?: string;
	readonly progress?: ProgressState;
}
/** How much of a log's end is read for its latest line. */
const TAIL_READ_BYTES = 2048;
export type ActivityLookup = (job: Job) => Activity | null;
export const noActivity: ActivityLookup = () => null;

/** All spinners share one phase, derived from the clock so frames need no state. */
export function frameAt(frames: readonly string[], now: number, periodMs?: number): string {
	const animation = frames === SPINNER_FRAMES ? JOB_ANIMATION : frames === STOPPING_FRAMES ? JOB_STOPPING_ANIMATION : undefined;
	if (animation) {
		const scale = periodMs === undefined ? 1 : animationFrameMs(animation) / periodMs;
		return glyphAt(animation, now * scale);
	}
	return frames[Math.floor(now / (periodMs ?? WIDGET_REFRESH_MS)) % frames.length]!;
}

export type PaintKey = "accent" | "success" | "error" | "warning" | "muted" | "dim";
export type Paint = (key: PaintKey, text: string) => string;
export const plainPaint: Paint = (_key, text) => text;

export function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	return totalSec < 60 ? `${totalSec}s` : minutesAndUp(totalSec);
}

export function isVisible(job: Job): boolean {
	if (job.state !== "done") return true;
	if (job.deliveryFailed) return true;
	return job.attempts > 0 && !job.delivered;
}

/**
 * Keep at most WIDGET_MAX_ROWS visible jobs. Failures are never dropped,
 * because nothing else reports them; running rows go oldest-first, then
 * pending completions, and everything dropped is counted in `hidden`.
 */
export function selectRows(jobs: Iterable<Job>): { rows: Job[]; hidden: number } {
	const all = [...jobs].filter(isVisible);
	if (all.length <= WIDGET_MAX_ROWS) return { rows: all, hidden: 0 };
	const keep = new Set<Job>();
	for (const job of all) {
		if (keep.size >= WIDGET_MAX_ROWS) break;
		if (job.deliveryFailed) keep.add(job);
	}
	for (const job of [...all].reverse()) {
		if (keep.size >= WIDGET_MAX_ROWS) break;
		if (job.state === "done" && !job.deliveryFailed) keep.add(job);
	}
	for (const job of [...all].reverse()) {
		if (keep.size >= WIDGET_MAX_ROWS) break;
		if (job.state !== "done") keep.add(job);
	}
	const rows = all.filter((job) => keep.has(job));
	return { rows, hidden: all.length - rows.length };
}

/** Failed deliveries first, then running jobs oldest first, then finished ones waiting to be delivered. */
export function rowOrder(jobs: Iterable<Job>): Job[] {
	const rank = (job: Job) => (job.deliveryFailed ? 0 : job.state !== "done" ? 1 : 2);
	return [...jobs].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? (a.endedAt ?? 0) - (b.endedAt ?? 0) : a.startedAt - b.startedAt));
}

interface RowParts {
	icon: string;
	key: PaintKey;
	tag: string;
	tagKey: PaintKey;
}

/**
 * The running row. The spinner is the whole activity signal: full speed in
 * accent while output flows, a dim one-frame-a-second crawl once the log has
 * stalled. Nothing else on the row changes, so the columns never move.
 */
function runningParts(job: Job, now: number | null, activity: ActivityLookup): RowParts {
	if (now === null) return { icon: RUNNING_STATIC, key: "accent", tag: "", tagKey: "muted" };
	const seen = activity(job);
	const quiet = seen !== null && now - seen.changedAt >= QUIET_AFTER_MS;
	return {
		icon: frameAt(SPINNER_FRAMES, now, quiet ? QUIET_FRAME_MS : undefined),
		key: quiet ? "dim" : "accent",
		tag: "",
		tagKey: "muted",
	};
}

function rowParts(job: Job, now: number | null, activity: ActivityLookup): RowParts {
	if (job.deliveryFailed) {
		return { icon: FAILURE_GLYPH, key: "warning", tag: `${jobStatusText(job)} · not delivered`, tagKey: "warning" };
	}
	if (job.state === "stopping") {
		const icon = now === null ? STOPPING_STATIC : frameAt(STOPPING_FRAMES, now);
		return { icon, key: "warning", tag: "stopping", tagKey: "muted" };
	}
	if (job.state !== "done") return runningParts(job, now, activity);
	const failed = job.signal !== null || (job.code ?? 0) !== 0;
	return {
		icon: failed ? FAILURE_GLYPH : SUCCESS_GLYPH,
		key: failed ? "error" : "success",
		tag: `${jobStatusText(job)} · pending`,
		tagKey: "muted",
	};
}

/**
 * Pure row rendering. `now === null` (RPC) omits the elapsed column and every
 * animated or sampled part; `activity` supplies log growth for running rows.
 */
export function renderJobLines(jobs: Iterable<Job>, now: number | null, paint: Paint, activity: ActivityLookup = noActivity): string[] {
	const { rows, hidden } = selectRows(jobs);
	if (rows.length === 0) return [];
	const idWidth = Math.max(...rows.map((job) => job.id.length));
	const lines = rows.map((job) => {
		const parts = rowParts(job, now, activity);
		const fields = [paint(parts.key, parts.icon), paint("accent", job.id.padEnd(idWidth))];
		if (now !== null) fields.push(paint("muted", formatElapsed((job.endedAt ?? now) - job.startedAt).padEnd(5)));
		if (parts.tag.length > 0) fields.push(paint(parts.tagKey, parts.tag));
		// A job parked by an older version has no title field; treat it as untitled.
		const title = typeof job.title === "string" ? job.title : "";
		const command = commandPreview(job.command, WIDGET_COMMAND_BYTES);
		// The title leads and the command follows it muted, so the row still says
		// what is actually running and truncation at the width cuts the command first.
		if (title.length > 0) fields.push(title, paint("muted", command));
		else fields.push(command);
		return fields.join("  ");
	});
	if (hidden > 0) lines.push(paint("dim", `+${hidden} more`));
	return lines;
}

function paintDim(theme: Theme, text: string): string {
	try { return theme.fg("dim", text); } catch { return text; }
}

export interface WidgetUi {
	setWidget(id: string, content: unknown, options?: unknown): void;
}

interface TuiHost {
	requestRender(): void;
}

export interface JobsWidget {
	/** `onSelect` receives the job whose row was clicked (TUI only). */
	attach(ui: WidgetUi, tuiMode: boolean, jobs: () => Iterable<Job>, onSelect?: (job: Job) => void): void;
	update(): void;
	detach(): void;
	/** How far along a running job is, when its output or command says; the inspector shows the same. */
	progressOf(job: Job, now: number): Progress | undefined;
	/** Whether a running job's log has gone quiet, as its row shows; the inspector shows the same. */
	isQuiet(job: Job, now: number): boolean;
}

interface WidgetMouseEvent {
	type: string;
	button: string;
	y: number;
}

/** `motion` is Tool Display's setting, read each frame: reduced holds the spinners still. */
export function createJobsWidget(motion: () => Motion = () => "full"): JobsWidget {
	let ui: WidgetUi | null = null;
	let listJobs: (() => Iterable<Job>) | null = null;
	let tui: TuiHost | null = null;
	let tuiMode = false;
	let shown = false;
	let onSelect: ((job: Job) => void) | null = null;
	// The jobs in the rows last painted, so a click's row maps to a job.
	let lastRows: Job[] = [];
	let stopFrames: (() => void) | null = null;
	const activity = new Map<string, Activity>();

	const snapshot = (): Job[] => (listJobs ? [...listJobs()] : []);

	/**
	 * One stat per live job per tick. A job's first sample dates its growth from
	 * the start so a command that never prints reads as quiet after the threshold,
	 * not as fresh. Records for finished jobs are dropped so the map stays bounded.
	 */
	const sample = (now: number): void => {
		const live = new Set<string>();
		for (const job of snapshot()) {
			if (job.state === "done") continue;
			live.add(job.id);
			let bytes: number;
			try {
				bytes = statSync(job.logPath).size;
			} catch {
				// Between spawn and the first write, or after a log was removed: leave the job plain.
				continue;
			}
			const seen = activity.get(job.id);
			// Only a log that grew is read again; most ticks cost one stat per job.
			if (seen !== undefined && seen.bytes === bytes) continue;
			const line = lastLine(readLogEnd(job.logPath, TAIL_READ_BYTES));
			// A window with nothing to show (a run of blanks) keeps the line and progress shown before.
			const tail = line ?? seen?.tail;
			const progress = line === undefined ? seen?.progress ?? {} : nextProgress(seen?.progress ?? {}, line, now);
			const changedAt = seen === undefined ? (bytes > 0 ? now : job.startedAt) : now;
			activity.set(job.id, { bytes, changedAt, progress, ...(tail !== undefined ? { tail } : {}) });
		}
		for (const id of [...activity.keys()]) if (!live.has(id)) activity.delete(id);
	};
	const lookup: ActivityLookup = (job) => activity.get(job.id) ?? null;
	const isQuiet = (job: Job, now: number): boolean => {
		const seen = lookup(job);
		return job.state === "running" && seen !== null && now - seen.changedAt >= QUIET_AFTER_MS;
	};
	let sampledAt = 0;
	// What the output shows first; a leading sleep only while the output says nothing.
	const progressOf = (job: Job, now: number): Progress | undefined =>
		job.state === "running" ? progressNow(activity.get(job.id)?.progress ?? {}, now) ?? sleepProgress(job.command, now - job.startedAt) : undefined;

	// Captured by the TUI: the factory runs inside pi's render loop, so `tui`
	// and `theme` are only available from here.
	const factory = (host: TuiHost, theme: Theme) => {
		tui = host;
		return {
			render: (width: number) => {
				const { rows, hidden } = selectRows(snapshot());
				lastRows = rowOrder(rows);
				const now = Date.now();
				const look = motion();
				// Pi already puts a blank line between the transcript and the widgets.
				const lines = lastRows.map((job) => {
					const progress = progressOf(job, now);
					const tail = lookup(job)?.tail;
					return liveRow(theme, job, { width, now, motion: look, quiet: isQuiet(job, now), ...(progress ? { progress } : {}), ...(tail ? { tail } : {}) });
				});
				if (hidden > 0) lines.push(truncateToWidth(`  ${paintDim(theme, `+${hidden} more`)}`, Math.max(1, width), "…"));
				return lines;
			},
			invalidate: () => {},
			handleMouse: (event: WidgetMouseEvent) => {
				if (event.type !== "click" || event.button !== "left" || onSelect === null) return undefined;
				const job = lastRows[event.y];
				if (job === undefined) return undefined;
				onSelect(job);
				return { handled: true };
			},
		};
	};

	const setWidget = (content: unknown): void => {
		try {
			ui?.setWidget(WIDGET_ID, content);
		} catch {
			// The extension context can go stale after session replacement.
		}
	};

	const stopTimer = (): void => {
		stopFrames?.();
		stopFrames = null;
	};

	return {
		attach(nextUi, nextTuiMode, jobs, select) {
			ui = nextUi;
			listJobs = jobs;
			tuiMode = nextTuiMode;
			onSelect = select ?? null;
			lastRows = [];
			shown = false;
			stopTimer();
			this.update();
		},
		update() {
			if (ui === null || listJobs === null) return;
			const rows = snapshot();
			if (!rows.some(isVisible)) {
				if (shown) setWidget(undefined);
				shown = false;
				stopTimer();
				return;
			}
			if (tuiMode) {
				sample(Date.now());
				// Re-setting the widget would rebuild the component; once shown,
				// a render request is enough because render() reads live state.
				if (!shown) {
					setWidget(factory);
					shown = true;
				} else {
					tui?.requestRender();
				}
			} else {
				setWidget(renderJobLines(rows, null, plainPaint));
				shown = true;
			}
			// Motion and sampling only while something is alive; pending rows are static.
			if (rows.some((job) => job.state !== "done")) {
				if (stopFrames === null && tuiMode) {
					stopFrames = everyFrame(() => {
						const now = Date.now();
						// Bands move at the animation rate; the logs are sampled less often.
						// Half a frame early, or frames at FRAME_MS would stretch each wait to the next frame after it.
						if (now - sampledAt >= WIDGET_REFRESH_MS - FRAME_MS / 2) {
							sample(now);
							sampledAt = now;
						}
						tui?.requestRender();
					});
				}
			} else {
				stopTimer();
				activity.clear();
			}
		},
		detach() {
			stopTimer();
			activity.clear();
			if (shown) setWidget(undefined);
			shown = false;
			ui = null;
			listJobs = null;
			tui = null;
			onSelect = null;
			lastRows = [];
		},
		progressOf,
		isQuiet,
	};
}
