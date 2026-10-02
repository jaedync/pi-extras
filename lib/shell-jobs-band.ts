/**
 * shell-jobs-band: what a job says about itself, and how it reads as a band.
 *
 * In the transcript a job is a still band (jobRow): `$ command`, its title
 * and where it is, gray while it runs out of sight and green or red once it
 * ends, so the start row and the completion read alike. Above the editor the
 * same band is alive (liveRow): its fill is the job's progress when that can
 * be known, a sweep when it can't, and the margin spinner slows to a crawl
 * once the log goes quiet.
 */
import { formatTime, timeSeg, type BandPhase, type Motion, type Outcome, type Seg } from "./band/band.ts";
import { BULLET_GLYPH, FAILURE_GLYPH, JOB_ANIMATION, JOB_STOPPING_ANIMATION, STOPPED_GLYPH, SUCCESS_GLYPH, animationFrameMs, glyphAt } from "./band/glyph.ts";
import { jobBand } from "./band/job-look.ts";
import type { BandTheme } from "./band/palette.ts";
import { commandPreview, titlePreview } from "./shell-jobs-core.ts";
import { jobStatusText, type Job } from "./shell-jobs-process.ts";
import type { Progress } from "./shell-jobs-progress.ts";

/** What the band needs to know about a job; a completion message carries the same facts. */
export interface JobFacts {
	readonly title: string | null;
	readonly command: string;
	readonly state: Job["state"] | "unknown";
	readonly code: number | null;
	readonly signal: string | null;
	readonly startedAt?: number;
	readonly endedAt?: number | null;
	readonly deliveryFailed?: boolean;
	/** Stopped through shell_job kill, so the end was asked for. */
	readonly claimed?: boolean;
}

export const JOB_COMMAND_BYTES = 200;
/** Frame period of a quiet job's crawl: still moving, but plainly idle next to a busy one. */
export const QUIET_FRAME_MS = 1000;
/**
 * A kill through shell_job was asked for, so it reads as stopped, not failed.
 * Any other signal came from elsewhere (the OOM killer, say): a failure.
 */
export function jobOutcome(facts: Pick<JobFacts, "code" | "signal" | "claimed">): Outcome {
	if (facts.claimed) return "aborted";
	return facts.signal === null && facts.code === 0 ? "ok" : "fail";
}

export function factsOf(job: Job): JobFacts {
	return {
		title: job.title,
		command: job.command,
		state: job.state,
		code: job.code,
		signal: job.signal,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		deliveryFailed: job.deliveryFailed,
		claimed: job.claimed,
	};
}

/** How a start row reads: the job's own state, or the start call's while there is no job yet. */
export type RowState = "writing" | "unstarted" | "job";

const SEP: Seg = { text: " · ", color: "dim" };
const DONE = Number.POSITIVE_INFINITY;
const OUTCOME_COLOR: Record<Outcome, string> = { ok: "success", fail: "error", timeout: "warning", aborted: "muted" };

const took = (facts: JobFacts, now: number): Seg[] => (facts.startedAt === undefined ? [] : [SEP, timeSeg((facts.endedAt ?? now) - facts.startedAt)]);

/** `✓ exit 0`, `✗ exit 2`, `■ stopped`. */
function endedSeg(facts: JobFacts): Seg {
	const outcome = jobOutcome(facts);
	if (outcome === "aborted") return { text: `${STOPPED_GLYPH} stopped`, color: "muted" };
	return { text: `${outcome === "ok" ? SUCCESS_GLYPH : FAILURE_GLYPH} ${jobStatusText(facts as Job)}`, color: OUTCOME_COLOR[outcome] };
}

/**
 * Where a job is, or how it ended and how long it took: `⇢ background`,
 * `✓ exit 0 · 29.9s`, `✗ exit 2 · 3.1s`, `■ stopped · 4.0s`.
 */
export function jobStatus(facts: JobFacts, now: number, state: RowState = "job"): Seg[] {
	if (state === "writing") return [];
	if (state === "unstarted") return [{ text: `${FAILURE_GLYPH} not started`, color: "error" }];
	if (facts.deliveryFailed) return [{ text: "not delivered", color: "warning" }, ...took(facts, now)];
	if (facts.state === "done") return [endedSeg(facts), ...took(facts, now)];
	if (facts.state === "stopping") return [{ text: "stopping", color: "warning" }, ...took(facts, now)];
	return [{ text: "\u21e2 background", color: "muted" }];
}

/** The band's color in the transcript: gray until the job ends, then the color it ended in. */
function rowPhase(facts: JobFacts, state: RowState): BandPhase {
	if (state === "writing") return { kind: "writing" };
	if (state === "unstarted") return { kind: "done", outcome: "fail", sinceMs: DONE };
	if (facts.deliveryFailed) return { kind: "done", outcome: "timeout", sinceMs: DONE };
	if (facts.state === "done") return { kind: "done", outcome: jobOutcome(facts), sinceMs: DONE };
	return { kind: "queued" };
}

function rowMargin(facts: JobFacts, state: RowState): Seg {
	if (state === "unstarted") return { text: BULLET_GLYPH, color: "error" };
	if (state === "job" && facts.deliveryFailed) return { text: BULLET_GLYPH, color: "warning" };
	if (state === "job" && facts.state === "done") return { text: BULLET_GLYPH, color: OUTCOME_COLOR[jobOutcome(facts)] };
	return { text: BULLET_GLYPH, color: "dim" };
}

export interface JobRowOptions {
	readonly width: number;
	readonly now: number;
	readonly state?: RowState;
}

/**
 * A job in the transcript: a band that holds still, gray while the job runs
 * out of sight, then the color it ended in. The start row and the completion
 * both read this way; the command is cut before the title, never the status.
 */
export function jobRow(theme: BandTheme, facts: JobFacts, options: JobRowOptions): string {
	const state = options.state ?? "job";
	return jobBand(theme, {
		width: options.width,
		phase: rowPhase(facts, state),
		margin: rowMargin(facts, state),
		command: commandPreview(facts.command, JOB_COMMAND_BYTES),
		commandColor: state === "writing" ? "dim" : "toolTitle",
		title: titlePreview(facts.title),
		status: jobStatus(facts, options.now, state),
		clockMs: options.now,
	});
}

export interface LiveRowOptions {
	readonly width: number;
	readonly now: number;
	readonly motion?: Motion;
	/** How far along it is, when its command or output says. */
	readonly progress?: Progress;
	/** Its latest output line, shown when there is no progress to show. */
	readonly tail?: string;
	/**
	 * Its log has stopped growing: the spinner crawls and the band holds still.
	 * Ignored while its share is known, since then the fill shows it moving
	 * (a sleep is silent by design, not stuck).
	 */
	readonly quiet?: boolean;
}

/** How much of the job is done, when that is known. */
const shareOf = (options: LiveRowOptions): number | undefined => options.progress?.share;

/** The live band's motion while the job runs: its progress, else a sweep, else (quiet) a steady tint. */
function livePhase(job: Job, options: LiveRowOptions): BandPhase {
	const share = shareOf(options);
	if (share !== undefined) return { kind: "progress", share };
	return options.quiet ? { kind: "calm" } : { kind: "running", elapsedMs: options.now - job.startedAt };
}

function spinner(job: Job, options: LiveRowOptions): Seg {
	const reduced = options.motion === "reduced";
	if (job.state === "stopping") return { text: glyphAt(JOB_STOPPING_ANIMATION, options.now, { reduced }), color: "warning" };
	if (!options.quiet || shareOf(options) !== undefined) return { text: glyphAt(JOB_ANIMATION, options.now, { reduced }), color: "accent" };
	// The same frames, slowed to one a second: alive, but silent.
	return { text: glyphAt(JOB_ANIMATION, options.now * (animationFrameMs(JOB_ANIMATION) / QUIET_FRAME_MS), { reduced }), color: "dim" };
}

/**
 * A job above the editor or in its inspector, alive while it runs: the band
 * fills with its progress (`45% · 32s left · 312M/690M`). When it can't know
 * how far along it is it sweeps, with what a meter still says (`312M ·
 * 12.1M/s`) or else its latest output line. Once it ends it is the same band
 * as in the transcript, until its completion is delivered.
 */
export function liveRow(theme: BandTheme, job: Job, options: LiveRowOptions): string {
	const facts = factsOf(job);
	if (job.state === "done" || job.deliveryFailed) return jobRow(theme, facts, { width: options.width, now: options.now });
	const running = job.state === "running";
	const share = running ? shareOf(options) : undefined;
	const percent: Seg[] = share !== undefined ? [{ text: "  ", color: "dim" }, { text: `${Math.floor(share * 100)}%`, color: "accent", bold: true }] : [];
	return jobBand(theme, {
		width: options.width,
		phase: running ? livePhase(job, options) : { kind: "calm" },
		margin: spinner(job, options),
		command: commandPreview(job.command, JOB_COMMAND_BYTES),
		title: titlePreview(job.title),
		// A running time stays plain, as on a tool row; only a finished one turns warm for being slow.
		status: running ? [{ text: formatTime(options.now - job.startedAt), color: "text" }, ...percent] : jobStatus(facts, options.now),
		...(running && options.progress ? { facts: options.progress.parts } : {}),
		...(running && !options.progress && options.tail ? { tail: options.tail } : {}),
		clockMs: options.now,
		...(options.motion ? { motion: options.motion } : {}),
	});
}
