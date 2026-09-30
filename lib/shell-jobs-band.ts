/**
 * shell-jobs-band: a job drawn as a header band, the way Tool Display draws
 * a tool call. The same band heads the widget row, the completion message
 * and the inspector, so a job looks alike everywhere.
 *
 * The start row in the transcript is a chip instead (jobChip): only as wide
 * as its words and set in from the edge, so handing a job off reads apart
 * from the full-width rows of calls that ran in place. A job has one live
 * indicator, the widget row above the editor; the chip stays still, saying
 * the job is in the background, and takes the job's outcome when it ends.
 */
import { formatTime, renderBand, timeSeg, type BandPhase, type Motion, type Outcome, type Seg } from "./band/band.ts";
import { handoffChip, type ChipTint } from "./band/job-chip.ts";
import { paletteFrom, type BandTheme } from "./band/palette.ts";
export { CHIP_INDENT } from "./band/job-chip.ts";
import { commandPreview, titlePreview } from "./shell-jobs-core.ts";
import { jobStatusText, type Job } from "./shell-jobs-process.ts";

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
/**
 * A kill through shell_job was asked for, so it reads as stopped, not failed.
 * Any other signal came from elsewhere (the OOM killer, say): a failure.
 */
export function jobOutcome(facts: Pick<JobFacts, "code" | "signal" | "claimed">): Outcome {
	if (facts.claimed) return "aborted";
	return facts.signal === null && facts.code === 0 ? "ok" : "fail";
}

/** The title alone when there is one; the command otherwise. */
export function jobSegs(facts: Pick<JobFacts, "title" | "command">, extra: readonly Seg[] = []): Seg[] {
	const title = titlePreview(facts.title);
	if (title !== null) return [{ text: title, color: "text", bold: true }, ...extra];
	return [{ text: "$ ", color: "accent", bold: true }, { text: commandPreview(facts.command, JOB_COMMAND_BYTES), color: "text" }, ...extra];
}

export type JobView = "live" | "calm";

/**
 * `live` is the widget and inspector: a sweep while output flows, a still
 * tint once the log has gone quiet. `calm` is the transcript row: still while
 * the job runs, since the widget is the one that moves.
 */
export function jobPhase(facts: JobFacts, now: number, view: JobView, quiet = false): BandPhase {
	if (facts.state === "unknown") return { kind: "queued" };
	if (facts.state === "done") return { kind: "done", outcome: jobOutcome(facts), sinceMs: Number.POSITIVE_INFINITY };
	if (view === "calm" || quiet) return { kind: "calm" };
	return { kind: "running", elapsedMs: now - (facts.startedAt ?? now) };
}

export function jobRail(facts: JobFacts, now: number, view: JobView): Seg[] {
	const took = facts.startedAt === undefined ? undefined : (facts.endedAt ?? now) - facts.startedAt;
	if (facts.state === "unknown") return [{ text: "background job", color: "dim" }];
	if (facts.deliveryFailed) return [{ text: "not delivered", color: "warning" }, ...(took === undefined ? [] : [{ text: "  ", color: "dim" }, timeSeg(took)])];
	if (facts.state === "done") {
		const outcome = jobOutcome(facts);
		const said = outcome === "aborted" ? "stopped" : jobStatusText(facts as Job);
		const word: Seg[] = outcome === "ok" ? [] : [{ text: said, color: outcome === "aborted" ? "muted" : "error" }, { text: "  ", color: "dim" }];
		return took === undefined ? word.slice(0, 1) : [...word, timeSeg(took)];
	}
	const stopping: Seg[] = facts.state === "stopping" ? [{ text: "stopping", color: "warning" }, { text: "   ", color: "dim" }] : [];
	if (view === "calm") return [...stopping, { text: "in background", color: "dim" }];
	return [...stopping, { text: took === undefined ? "" : formatTime(took), color: "text" }];
}

export interface JobBandOptions {
	readonly width: number;
	readonly now: number;
	readonly view: JobView;
	readonly quiet?: boolean;
	readonly motion?: Motion;
	readonly extra?: readonly Seg[];
	readonly indent?: number;
}

export function jobBand(theme: BandTheme, facts: JobFacts, options: JobBandOptions): string {
	return renderBand(theme, paletteFrom(theme), {
		width: options.width,
		phase: jobPhase(facts, options.now, options.view, options.quiet),
		segs: jobSegs(facts, options.extra),
		rail: jobRail(facts, options.now, options.view),
		clockMs: options.now,
		...(options.motion ? { motion: options.motion } : {}),
		...(options.indent !== undefined ? { indent: options.indent } : {}),
	});
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

/** How a start chip reads: the job's own state, or the start call's while there is no job yet. */
export type ChipState = "writing" | "unstarted" | "job";

function chipLook(facts: JobFacts, state: ChipState): { tint: ChipTint; glyph: string } {
	if (state === "writing") return { tint: "writing", glyph: "dim" };
	if (state === "unstarted") return { tint: "fail", glyph: "error" };
	if (facts.state === "unknown") return { tint: "unknown", glyph: "muted" };
	if (facts.state !== "done") return { tint: "running", glyph: "accent" };
	const outcome = jobOutcome(facts);
	return { tint: outcome, glyph: outcome === "ok" ? "success" : outcome === "aborted" ? "muted" : "error" };
}

/** The words after the chip's title: where the job is, or how it ended and how long it took. */
export function chipStatus(facts: JobFacts, now: number, state: ChipState = "job"): Seg[] {
	if (state === "writing") return [];
	if (state === "unstarted") return [{ text: "not started", color: "error" }];
	if (facts.state === "unknown") return [{ text: "background job", color: "dim" }];
	const took = facts.startedAt === undefined ? [] : [{ text: "  ", color: "dim" }, timeSeg((facts.endedAt ?? now) - facts.startedAt)];
	if (facts.deliveryFailed) return [{ text: "not delivered", color: "warning" }, ...took];
	if (facts.state === "done") {
		const outcome = jobOutcome(facts);
		const word: Seg = outcome === "ok" ? { text: "done", color: "muted" } : outcome === "aborted" ? { text: "stopped", color: "muted" } : { text: jobStatusText(facts as Job), color: "error" };
		return [word, ...took];
	}
	return facts.state === "stopping" ? [{ text: "stopping", color: "warning" }] : [{ text: "in background", color: "muted" }];
}

export interface JobChipOptions {
	readonly width: number;
	readonly now: number;
	readonly state?: ChipState;
}

/**
 * The start row's chip: `↳ title  status`, on a tint of the job's state. The
 * status is kept whole and the title cut when the line is narrow.
 */
export function jobChip(theme: BandTheme, facts: JobFacts, options: JobChipOptions): string {
	const state = options.state ?? "job";
	const look = chipLook(facts, state);
	return handoffChip(theme, {
		width: options.width, title: jobSegs(facts), status: chipStatus(facts, options.now, state),
		tint: look.tint, glyphColor: look.glyph,
	});
}
