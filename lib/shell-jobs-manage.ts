/**
 * The `shell_job` tool's operations (list, logs, kill) and the result shapes
 * both shell-jobs tools return.
 */
import { stopGroup, recordResidual, jobStatusText, type Job, type Runtime } from "./shell-jobs-process.ts";
import {
	DETAILS_BUDGET_BYTES,
	KILL_WAIT_MS,
	capPayload,
	commandPreview,
	readLogPage,
	sanitizeControl,
	utf8Head,
	type ListParams,
	type LogsParams,
	type validateManageParams,
} from "./shell-jobs-core.ts";

const COMMAND_PREVIEW_BYTES = 120;
export const CWD_PREVIEW_BYTES = 200;

export function okResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text: capPayload(sanitizeControl(text)) }], details };
}

export function errResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: capPayload(sanitizeControl(text)) }], details, isError: true };
}

export type ToolResult = ReturnType<typeof okResult> | ReturnType<typeof errResult>;

/** A job parked by an older version has no title field; read it as untitled. */
export function jobTitle(job: Job): string | null {
	return typeof job.title === "string" ? job.title : null;
}

export function jobSummary(job: Job) {
	return {
		id: job.id,
		state: job.state,
		code: job.code,
		signal: job.signal,
		title: jobTitle(job),
		commandPreview: commandPreview(job.command, COMMAND_PREVIEW_BYTES),
		cwd: sanitizeControl(utf8Head(job.cwd, CWD_PREVIEW_BYTES)),
		logPath: job.logPath,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		cleanupError: job.cleanupError,
		deliveryFailed: job.deliveryFailed,
	};
}

export async function manageJob(runtime: Runtime, params: ReturnType<typeof validateManageParams>): Promise<ToolResult> {
	if (!params.ok) return errResult(params.error);
	const { params: parsed } = params;
	if (parsed.op === "list") return listJobs(runtime, parsed);
	const job = runtime.jobs.get(parsed.id);
	if (!job) return errResult(`Unknown job ${parsed.id}. No job with that id exists in this session.`);
	if (parsed.op === "logs") return readJobLogs(job, parsed);
	return job.state === "done" ? recleanFinishedJob(runtime, job) : stopJob(runtime, job);
}

export function listJobs(runtime: Runtime, parsed: ListParams): ToolResult {
	const all = [...runtime.jobs.values()].reverse().slice(0, parsed.limit);
	let omitted = runtime.jobs.size - all.length;
	const summaries = all.map(jobSummary);
	// Details get their own serialized budget rather than relying on the text cap.
	while (summaries.length > 0 && Buffer.byteLength(JSON.stringify(summaries), "utf8") > DETAILS_BUDGET_BYTES) {
		summaries.pop();
		omitted += 1;
	}
	const shown = all.slice(0, summaries.length);
	const lines = shown.map((job) => {
		const title = jobTitle(job);
		const label = title === null ? "" : `[${title}] `;
		return `${job.id} ${jobStatusText(job)} ${label}${commandPreview(job.command, COMMAND_PREVIEW_BYTES)}`;
	});
	if (lines.length === 0) lines.push("No shell jobs in this session.");
	if (omitted > 0) lines.push(`(+${omitted} job(s) omitted)`);
	if (runtime.abandoned > 0) lines.push(`(${runtime.abandoned} completion(s) abandoned undelivered)`);
	return okResult(lines.join("\n"), { jobs: summaries, omitted, abandoned: runtime.abandoned });
}

export function readJobLogs(job: Job, parsed: LogsParams): ToolResult {
	let page;
	try {
		page = readLogPage(job.logPath, { offset: parsed.offset, bytes: parsed.bytes, tail: parsed.tail });
	} catch (error) {
		return errResult(`Could not read the log for ${parsed.id}: ${(error as Error).message}`);
	}
	const text = page.text.length > 0 ? page.text : "(no output yet)";
	return okResult(text, {
		id: job.id,
		state: job.state,
		logPath: job.logPath,
		offset: page.offset,
		nextOffset: page.nextOffset,
		eof: page.eof,
		totalBytes: page.totalBytes,
	});
}

/** Kill on a finished job: report it, or retry a cleanup that could not confirm the group died. */
export async function recleanFinishedJob(runtime: Runtime, job: Job): Promise<ToolResult> {
	if (job.cleanupError === null) {
		return okResult(`Job ${job.id} already finished (${jobStatusText(job)}).`, {
			id: job.id,
			state: job.state,
			code: job.code,
			signal: job.signal,
			cleanupError: null,
		});
	}
	// Retry rather than report a tidy stop that never happened.
	const retry = await stopGroup(job.pid);
	recordResidual(runtime, job.pid, retry.cleaned);
	if (!retry.cleaned) {
		return errResult(`Job ${job.id} finished, but its process group still cannot be terminated: ${job.cleanupError}`, {
			id: job.id,
			state: job.state,
			cleanupError: job.cleanupError,
		});
	}
	runtime.jobs.set(job.id, { ...job, cleanupError: null });
	runtime.widget.update();
	return okResult(`Job ${job.id} finished (${jobStatusText(job)}); its process group is now gone.`, {
		id: job.id,
		state: job.state,
		cleanupError: null,
	});
}

export async function stopJob(runtime: Runtime, job: Job): Promise<ToolResult> {
	runtime.jobs.set(job.id, { ...job, claimed: true, state: "stopping" });
	runtime.widget.update();
	const cleanup = await stopGroup(job.pid);
	recordResidual(runtime, job.pid, cleanup.cleaned);
	const final = await withTimeout(runtime.finals.get(job.id)?.promise, KILL_WAIT_MS);
	if (final) {
		const details = { id: final.id, state: final.state, code: final.code, signal: final.signal, cleanupError: final.cleanupError };
		if (final.cleanupError !== null) {
			return errResult(`Job ${job.id} stopped, but its process group could not be confirmed dead: ${final.cleanupError}`, details);
		}
		return okResult(`Job ${job.id} stopped (${jobStatusText(final)}).`, details);
	}
	const pending = runtime.jobs.get(job.id);
	if (pending && pending.state !== "done") runtime.jobs.set(job.id, { ...pending, claimed: false });
	return okResult(`Job ${job.id} is still stopping; its final status will arrive as a completion message.`, {
		id: job.id,
		state: (runtime.jobs.get(job.id) ?? job).state,
		code: null,
		signal: null,
	});
}

export function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | null> {
	if (!promise) return Promise.resolve(null);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}
