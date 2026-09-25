/**
 * shell-jobs-band: a job drawn as a header band, the way Tool Display draws
 * a tool call. The same band heads the widget row, the start row, the
 * completion message and the inspector, so a job looks alike everywhere.
 *
 * A job has one live indicator: the widget row above the editor animates
 * while the job runs, and the start row in the transcript stays calm, saying
 * only that the job is in the background, until it ends.
 */
import { formatTime, renderBand, timeSeg, type BandPhase, type Motion, type Outcome, type Seg } from "./band/band.ts";
import { paletteFrom, type BandTheme } from "./band/palette.ts";
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
