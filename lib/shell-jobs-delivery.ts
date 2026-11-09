/** Reloadable delivery adapter. Process callbacks retain the runtime, never a Pi API. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capPayload, commandPreview, formatDuration, NOTIFY_TAIL_BYTES, NOTIFY_TAIL_LINES, readLogTail } from "./shell-jobs-core.ts";
import { type Delivery, type HeldCompletion, type Job, type Runtime, jobStatusText } from "./shell-jobs-process.ts";

export const COMPLETION_CUSTOM_TYPE = "shell-job-complete";
const MAX_COMPLETION_ATTEMPTS = 3;
const COMMAND_PREVIEW_BYTES = 120;
/** How soon a send that waited in a gap of a run tries again. */
export const GAP_RETRY_MS = 500;

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

/** A runtime that an older version parked has no held map. */
function heldOf(runtime: Runtime): Map<string, HeldCompletion> {
	runtime.held ??= new Map();
	return runtime.held;
}

/** What sendCompletion reads of the session that an attachment serves, just before a send. */
export interface SessionProbe {
	/** ctx.signal: defined only while an agent loop runs. */
	signal(): AbortSignal | undefined;
	/** ctx.isIdle(): false from the start of a run to its agent_settled, and during a compaction. */
	idle(): boolean;
}

const NO_SESSION: SessionProbe = { signal: () => undefined, idle: () => true };

function retryLater(flush: () => void): void {
	setTimeout(flush, GAP_RETRY_MS).unref?.();
}

/**
 * Where Pi would put a send now (sendCustomMessage). With a signal, an agent
 * loop runs and Pi steers the message into its queue: "steered". With no
 * signal and an idle session, Pi starts a run for the message or defers it
 * while agent_settled handlers run: "pending". With no signal and a busy
 * session, a run waits between its loops (before_agent_start handlers, the
 * agent_before_settle boundary) or a compaction runs: "gap". In a gap Pi can
 * queue the message where an Esc drops it with no proof, so sendCompletion
 * does not send then. When the probe fails, "pending" is the safe answer.
 */
function sendPlace(probe: SessionProbe): HeldCompletion | "gap" {
	try {
		if (probe.signal() !== undefined) return "steered";
		return probe.idle() ? "pending" : "gap";
	} catch {
		return "pending";
	}
}

/**
 * before_agent_start: Pi starts a run with this completion as its first
 * message. It lands as the run starts, or the start failed; either way the
 * next settled run proves where it went, as for a steered message.
 */
export function noteRunStart(runtime: Runtime, event: { messageType?: string; message?: { customType?: string; details?: unknown } }): void {
	if (event.messageType !== "custom" || event.message?.customType !== COMPLETION_CUSTOM_TYPE) return;
	const details = event.message.details as { id?: unknown; runtimeId?: unknown } | undefined;
	if (typeof details?.id !== "string" || details.runtimeId !== runtime.runtimeId) return;
	const held = heldOf(runtime);
	if (held.get(details.id) === "pending") held.set(details.id, "steered");
}

export function acknowledgeCompletion(runtime: Runtime, id: string): void {
	heldOf(runtime).delete(id);
	const job = runtime.jobs.get(id);
	if (!job || (job.delivered && !job.deliveryFailed)) return;
	runtime.outbox.delete(id);
	runtime.jobs.set(id, { ...job, delivered: true, deliveryFailed: false });
	runtime.widget.update();
}

/**
 * Only the current attachment may submit, including after asynchronous log reads.
 * `probe` reads the session that this attachment serves. `scheduleRetry` runs a
 * flush later after a gap wait; the agent_start handler flushes too.
 */
export function attachDelivery(
	runtime: Runtime, pi: ExtensionAPI, readTail = readLogTail, probe: SessionProbe = NO_SESSION,
	scheduleRetry: (flush: () => void) => void = retryLater,
): Delivery {
	const inFlight = new Map<string, Promise<void>>();
	let retryArmed = false;
	const waitForGap = () => {
		if (retryArmed) return;
		retryArmed = true;
		scheduleRetry(() => {
			retryArmed = false;
			void binding.flush();
		});
	};
	const binding: Delivery = {
		async flush() {
			if (runtime.delivery !== binding || runtime.closing) return;
			const pending = [...runtime.outbox].map((id) => {
				const existing = inFlight.get(id);
				if (existing) return existing;
				const job = runtime.jobs.get(id);
				if (!job) { runtime.outbox.delete(id); return Promise.resolve(); }
				const sent = sendCompletion(runtime, binding, pi, job, readTail, probe, waitForGap).finally(() => inFlight.delete(id));
				inFlight.set(id, sent);
				return sent;
			});
			await Promise.all(pending);
		},
	};
	runtime.delivery = binding;
	return binding;
}

async function sendCompletion(
	runtime: Runtime, binding: Delivery, pi: ExtensionAPI, job: Job, readTail: typeof readLogTail,
	probe: SessionProbe, waitForGap: () => void,
): Promise<void> {
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
	// A job that ended while no Pi watched it, with no exit file, has no status to give.
	const lines = [job.codeUnknown === true ? `Job ${job.id} ended, exit code unknown, after ${duration}` : `Job ${job.id} finished: ${jobStatusText(job)} after ${duration}`];
	// The title helps the model tie the completion back to what it started,
	// which matters once compaction has dropped the start call.
	if (title !== null) lines.push(`title: ${title}`);
	lines.push(`log: ${job.logPath}`);
	if (job.cleanupError !== null) lines.push(`warning: ${job.cleanupError}`);
	const stopped = stoppedLine(job.stoppedBackground);
	if (stopped !== null) lines.push(stopped);
	lines.push("", tail.text.length > 0 ? tail.text : "(no output)");
	if (tail.notice !== null) lines.push("", tail.notice);
	const place = sendPlace(probe);
	// The outbox entry stays, so the retry or the agent_start flush sends it.
	// Reconcile skips it meanwhile and counts no attempt for it.
	if (place === "gap") {
		waitForGap();
		return;
	}
	// Removing before send prevents reentrant acknowledgements/settles from
	// submitting twice. Failed sends use the same bounded history reconciliation.
	runtime.outbox.delete(job.id);
	// Pi holds the message until it lands; reconcile must not send it again
	// meanwhile. Set before the send, so that a landing during it clears it.
	const held = heldOf(runtime);
	held.set(job.id, place);
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
		held.delete(job.id);
	}
}

/** Background work the exit cleanup stopped; the exit status alone reads as if all of it finished. */
function stoppedLine(count: number | null | undefined): string | null {
	if (count === undefined || count === 0) return null;
	const what = count === null ? "background processes" : `${count} background process${count === 1 ? "" : "es"}`;
	return `stopped: ${what} that ${count === 1 ? "was" : "were"} still running when the command exited`;
}

/**
 * The agent_settled handler. A run that was not aborted ends only when its
 * queue is empty, so its "steered" completions are in the session or gone, and
 * reconcile may send the gone ones again. An aborted run proves nothing: the
 * RPC abort, and /compact, /new, /resume and /fork in the TUI, keep the queue
 * for the next run. A "pending" send is never released here: Pi still holds
 * it in its deferred actions or as the message that starts a run, and
 * before_agent_start makes it "steered". The gap wait keeps "pending" sends
 * out of the queue, so an Esc cannot drop one.
 */
export async function settleDeliveries(runtime: Runtime, ctx: ExtensionContext, event: { aborted?: boolean }): Promise<void> {
	if (runtime.closing || runtime.delivery === null) return;
	if (event.aborted !== true) {
		const held = heldOf(runtime);
		for (const [id, kind] of held) if (kind === "steered") held.delete(id);
	}
	await reconcileDeliveries(runtime, ctx);
}

/**
 * Recover discarded messages only once Pi has drained its existing queue.
 * Returns true when it flushed the outbox, and false when it returned early.
 */
export async function reconcileDeliveries(runtime: Runtime, ctx: ExtensionContext): Promise<boolean> {
	if (runtime.closing || runtime.delivery === null) return false;
	if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return false;
	let changed = false;
	const held = heldOf(runtime);
	for (const job of runtime.jobs.values()) {
		if (job.state !== "done" || job.delivered || job.attempts === 0) continue;
		const lookup = lookupCompletion(ctx, runtime.runtimeId, job.id);
		if (lookup === "in") {
			acknowledgeCompletion(runtime, job.id);
			continue;
		}
		// A read in progress or a completion produced during reload already has
		// an outbox entry. Neither consumes another delivery attempt here. A
		// held completion is still in Pi: ctx.isIdle() is true while Pi runs
		// deferred sends, and after an abort that kept the queue.
		if (lookup === "unknown" || runtime.outbox.has(job.id) || held.has(job.id)) continue;
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
	return true;
}
