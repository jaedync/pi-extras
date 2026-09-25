/**
 * shell-jobs-widget: the background-job indicator above the editor.
 *
 * One keyed widget, one line per visible job, no header. Visible means: still
 * running, stopping, waiting on an undelivered completion, or failed to
 * deliver. Delivered jobs disappear so the widget only ever shows work that
 * still needs attention.
 *
 * In TUI mode it installs a factory component so it can read the live job map,
 * honor the terminal width, and use theme colors. While a job is running or
 * stopping, a timer samples each log's size and asks for a render; motion is
 * limited to that window, and a row that is only waiting for delivery is
 * static. In RPC mode a plain string array is used because a component factory
 * is not serializable, so those rows carry no spinner, elapsed or activity.
 *
 * A running row answers "is it still going?" with the spinner alone. While the
 * log is growing it runs at full speed in the accent colour; once the log has
 * not grown for QUIET_AFTER_MS it slows to one frame a second and dims. The
 * process is still alive either way (a dead one leaves the row), so the crawl
 * says "alive but silent", which is the one cue that separates a slow build
 * from a hung one, without a number the reader would have to interpret.
 */
import { statSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FRAME_MS } from "./band/clock.ts";
import { factsOf, jobBand } from "./shell-jobs-band.ts";
import { commandPreview } from "./shell-jobs-core.ts";
import { type Job, jobStatusText } from "./shell-jobs-process.ts";

export const WIDGET_ID = "shell-jobs";
export const WIDGET_MAX_ROWS = 4;
export const WIDGET_COMMAND_BYTES = 64;
// Slow enough to sit in peripheral vision; pi's foreground loader runs at 80 ms.
export const WIDGET_REFRESH_MS = 250;
// No log growth for this long puts the spinner into its quiet crawl.
export const QUIET_AFTER_MS = 30_000;
// Frame period of the quiet crawl: still moving, so it cannot be mistaken for
// a static glyph, but slow enough to read as idle next to a busy row.
export const QUIET_FRAME_MS = 1000;
// Pi's own loader frames, so a running job speaks the same visual language.
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Teardown lasts at most KILL_WAIT_MS, so this reads as a brief unwinding.
export const STOPPING_FRAMES: readonly string[] = ["◐", "◓", "◑", "◒"];
// Static glyphs for RPC rows, where nothing ticks.
const RUNNING_STATIC = "●";
const STOPPING_STATIC = "◐";
// Pi wraps string-array widgets in Text(line, 1, 0); a factory component gets raw
// lines, so it pads itself to sit on the same column as everything else.
const WIDGET_PAD = " ";

/** Log growth seen for a live job: its size and when it last changed. */
export interface Activity {
	readonly bytes: number;
	readonly changedAt: number;
}
export type ActivityLookup = (job: Job) => Activity | null;
export const noActivity: ActivityLookup = () => null;

/** All spinners share one phase, derived from the clock so frames need no state. */
export function frameAt(frames: readonly string[], now: number, periodMs = WIDGET_REFRESH_MS): string {
	return frames[Math.floor(now / periodMs) % frames.length];
}

export type PaintKey = "accent" | "success" | "error" | "warning" | "muted" | "dim";
export type Paint = (key: PaintKey, text: string) => string;
export const plainPaint: Paint = (_key, text) => text;

export function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return `${min}m${sec.toString().padStart(2, "0")}s`;
	return `${Math.floor(min / 60)}h${(min % 60).toString().padStart(2, "0")}m`;
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
		icon: frameAt(SPINNER_FRAMES, now, quiet ? QUIET_FRAME_MS : WIDGET_REFRESH_MS),
		key: quiet ? "dim" : "accent",
		tag: "",
		tagKey: "muted",
	};
}

function rowParts(job: Job, now: number | null, activity: ActivityLookup): RowParts {
	if (job.deliveryFailed) {
		return { icon: "✗", key: "warning", tag: `${jobStatusText(job)} · not delivered`, tagKey: "warning" };
	}
	if (job.state === "stopping") {
		const icon = now === null ? STOPPING_STATIC : frameAt(STOPPING_FRAMES, now);
		return { icon, key: "warning", tag: "stopping", tagKey: "muted" };
	}
	if (job.state !== "done") return runningParts(job, now, activity);
	const failed = job.signal !== null || (job.code ?? 0) !== 0;
	return {
		icon: failed ? "✗" : "✓",
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
}

interface WidgetMouseEvent {
	type: string;
	button: string;
	y: number;
}

export function createJobsWidget(): JobsWidget {
	let ui: WidgetUi | null = null;
	let listJobs: (() => Iterable<Job>) | null = null;
	let tui: TuiHost | null = null;
	let tuiMode = false;
	let shown = false;
	let onSelect: ((job: Job) => void) | null = null;
	// The jobs behind the rows last painted, so a click's row maps to a job.
	let lastRows: Job[] = [];
	let timer: ReturnType<typeof setInterval> | null = null;
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
				// Between spawn and the first write, or after a log was removed: leave the row plain.
				continue;
			}
			const seen = activity.get(job.id);
			if (seen === undefined) activity.set(job.id, { bytes, changedAt: bytes > 0 ? now : job.startedAt });
			else if (seen.bytes !== bytes) activity.set(job.id, { bytes, changedAt: now });
		}
		for (const id of [...activity.keys()]) if (!live.has(id)) activity.delete(id);
	};
	const lookup: ActivityLookup = (job) => activity.get(job.id) ?? null;
	const isQuiet = (job: Job, now: number): boolean => {
		const seen = lookup(job);
		return job.state === "running" && seen !== null && now - seen.changedAt >= QUIET_AFTER_MS;
	};
	let sampledAt = 0;

	const paintWith = (theme: Theme): Paint => (key, text) => {
		try {
			return theme.fg(key, text);
		} catch {
			// A user theme missing a key should degrade to plain text, not break the widget.
			return text;
		}
	};

	// Captured by the TUI: the factory runs inside pi's render loop, so `tui`
	// and `theme` are only available from here.
	const factory = (host: TuiHost, theme: Theme) => {
		tui = host;
		return {
			render: (width: number) => {
				const jobs = snapshot();
				const { rows, hidden } = selectRows(jobs);
				lastRows = rows;
				if (rows.length === 0) return [];
				const now = Date.now();
				// One band per job, like a tool row; a quiet log stills the sweep to a tint.
				const bands = rows.map((job) => jobBand(theme, factsOf(job), { width, now, view: "live", quiet: isQuiet(job, now) }));
				const more = hidden > 0 ? [`${WIDGET_PAD}${paintWith(theme)("dim", `+${hidden} more`)}`] : [];
				// Pi already puts a blank line between the transcript and the widgets.
				return [...bands, ...more];
			},
			invalidate: () => {},
			// One band per job in painted order; the `+N more` line is no job.
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
		if (timer !== null) clearInterval(timer);
		timer = null;
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
				if (timer === null && tuiMode) {
					const handle = setInterval(() => {
						const now = Date.now();
						// Bands move at the animation rate; the logs are sampled less often.
						if (now - sampledAt >= WIDGET_REFRESH_MS) {
							sample(now);
							sampledAt = now;
						}
						tui?.requestRender();
					}, FRAME_MS);
					handle.unref?.();
					timer = handle;
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
	};
}
