/** Reloadable delivery adapter. Process callbacks retain the runtime, never a Pi API. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capPayload, commandPreview, formatDuration, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES, readLogTail } from "./shell-jobs-core.ts";
import { type Delivery, type Job, type Runtime, jobStatusText } from "./shell-jobs-process.ts";

export const COMPLETION_CUSTOM_TYPE = "shell-job-complete";
const MAX_COMPLETION_ATTEMPTS = 3;
const COMMAND_PREVIEW_BYTES = 120;

type BranchLookup = "in" | "out" | "unknown";

/** Runtime tokens distinguish this process's jobs from earlier sessions' j1. */
function lookupCompletion(ctx: ExtensionContext, runtimeId: string, id: string): BranchLookup {
	type Details = { id?: string; runtimeId?: string };
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			const details = (entry as { details?: Details }).details;
			const message = (entry as { message?: { role?: string; customType?: string; details?: Details } }).message;
			if (entry.type === "custom_message" && entry.customType === COMPLETION_CUSTOM_TYPE && details?.id === id && details?.runtimeId === runtimeId) return "in";
			if (entry.type === "message" && message?.role === "custom" && message.customType === COMPLETION_CUSTOM_TYPE &&
				message.details?.id === id && message.details?.runtimeId === runtimeId) return "in";
		}
	} catch {
		// Unreadable history is not proof of delivery; defer instead of acking.
		return "unknown";
	}
	return "out";
}

export function acknowledgeCompletion(runtime: Runtime, id: string): void {
	const job = runtime.jobs.get(id);
	if (!job || (job.delivered && !job.deliveryFailed)) return;
	runtime.outbox.delete(id);
	runtime.jobs.set(id, { ...job, delivered: true, deliveryFailed: false });
	runtime.widget.update();
}

/** Only the current attachment may submit, including after asynchronous log reads. */
export function attachDelivery(runtime: Runtime, pi: ExtensionAPI, readTail = readLogTail): Delivery {
	const inFlight = new Map<string, Promise<void>>();
	const binding: Delivery = {
		async flush() {
			if (runtime.delivery !== binding || runtime.closing) return;
			const pending = [...runtime.outbox].map((id) => {
				const existing = inFlight.get(id);
				if (existing) return existing;
				const job = runtime.jobs.get(id);
				if (!job) { runtime.outbox.delete(id); return Promise.resolve(); }
				const sent = sendCompletion(runtime, binding, pi, job, readTail).finally(() => inFlight.delete(id));
				inFlight.set(id, sent);
				return sent;
			});
			await Promise.all(pending);
		},
	};
	runtime.delivery = binding;
	return binding;
}

async function sendCompletion(runtime: Runtime, binding: Delivery, pi: ExtensionAPI, job: Job, readTail: typeof readLogTail): Promise<void> {
	let tail;
	try {
		tail = await readTail(job.logPath, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES);
	} catch {
		// The log can disappear while it is streamed (notably on actual shutdown).
		// Report a useful completion if still attached; never reject an exit callback.
		tail = { text: "(could not read job output; try shell_job logs)", truncated: false, totalLines: 0, notice: null };
	}
	// Reload can happen while the tail is streaming. Leave the outbox entry for
	// the new binding rather than sending through an invalidated Pi context.
	if (runtime.delivery !== binding || runtime.closing || !runtime.outbox.has(job.id)) return;
	const latest = runtime.jobs.get(job.id);
	if (!latest || latest.delivered || latest.claimed) { runtime.outbox.delete(job.id); return; }
	const duration = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
	// A job parked by an older version has no title field.
	const title = typeof job.title === "string" ? job.title : null;
	const lines = [`Job ${job.id} finished: ${jobStatusText(job)} after ${duration}`];
	// The title helps the model tie the completion back to what it started,
	// which matters once compaction has dropped the start call.
	if (title !== null) lines.push(`title: ${title}`);
	lines.push(`log: ${job.logPath}`);
	if (job.cleanupError !== null) lines.push(`warning: ${job.cleanupError}`);
	lines.push("", tail.text.length > 0 ? tail.text : "(no output)");
	if (tail.notice !== null) lines.push("", tail.notice);
	// Removing before send prevents reentrant acknowledgements/settles from
	// submitting twice. Failed sends use the same bounded history reconciliation.
	runtime.outbox.delete(job.id);
	try {
		pi.sendMessage({
			customType: COMPLETION_CUSTOM_TYPE,
			display: true,
			content: capPayload(lines.join("\n")),
			details: {
				id: job.id, pid: job.pid, code: job.code, signal: job.signal,
				durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
				logPath: job.logPath, truncated: tail.truncated, totalLines: tail.totalLines,
				cleanupError: job.cleanupError, runtimeId: job.runtimeId,
				// Renderer only; Pi does not send details to the model.
				command: commandPreview(job.command, COMMAND_PREVIEW_BYTES),
				title,
			},
		}, { triggerTurn: true, deliverAs: "steer" });
	} catch {
		// Pi reports API failures; the unacknowledged job remains visible and retryable.
	}
}

/** Recover discarded messages only once Pi has drained its existing queue. */
export async function reconcileDeliveries(runtime: Runtime, ctx: ExtensionContext): Promise<void> {
	if (runtime.closing || runtime.delivery === null) return;
	if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
	let changed = false;
	for (const job of runtime.jobs.values()) {
		if (job.state !== "done" || job.delivered || job.attempts === 0) continue;
		const lookup = lookupCompletion(ctx, runtime.runtimeId, job.id);
		if (lookup === "in") {
			acknowledgeCompletion(runtime, job.id);
			continue;
		}
		// A read in progress or a completion produced during reload already has
		// an outbox entry. Neither consumes another delivery attempt here.
		if (lookup === "unknown" || runtime.outbox.has(job.id)) continue;
		if (job.attempts >= MAX_COMPLETION_ATTEMPTS) {
			if (!job.deliveryFailed) {
				runtime.jobs.set(job.id, { ...job, deliveryFailed: true });
				changed = true;
			}
			continue;
		}
		runtime.jobs.set(job.id, { ...job, attempts: job.attempts + 1 });
		runtime.outbox.add(job.id);
		changed = true;
	}
	if (changed) runtime.widget.update();
	await runtime.delivery?.flush();
}
