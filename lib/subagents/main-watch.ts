/**
 * Where main is, for the mail its subagents send it (deliver.ts `Route`),
 * and the hooks that keep main from settling before it has replied after
 * mail that landed while it worked.
 *
 * Pi's `isIdle()` says whether main is idle. When it isn't, a run between
 * `agent_start` and `agent_settled` means main is working and can take mail
 * at its next turn boundary; otherwise it is compacting or summarizing a
 * branch with no run to take it, and a turn started then would run on the
 * context being rewritten, so the mail waits. It also waits while a run is
 * settling, once main's settle check has passed: mail landing then would
 * miss it, and goes out as a new turn once main has settled instead.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MainMail, Route } from "./deliver.ts";

/**
 * How long mail waits for a prompt the user sent while main looked idle.
 * Pi checks whether main is busy only at the end of a prompt's preflight
 * (input handlers, templates), so mail that wakes main in between makes the
 * prompt fail; the prompt's own run starting ends the wait sooner.
 */
const INPUT_GRACE_MS = 2_000;
/**
 * A /compact stops main's run and compacts with nothing said in between.
 * Other extensions' handlers can take a while before ours sees it start, so
 * the window is wide; it only rules out an Esc followed much later by a
 * /compact.
 */
const STOP_WINDOW_MS = 60_000;
/**
 * How long a prompt can still be on its way. Pi may compact before starting
 * one, and that can take minutes; input another extension handled starts no
 * run, so past this it no longer holds mail after a compaction.
 */
const PENDING_INPUT_MS = 300_000;

export interface MainWatch {
	route(ctx: { isIdle(): boolean }): Route;
}

/** The id of the last message in the conversation, ignoring entries that only hold an extension's state. */
function lastSaid(ctx: { sessionManager?: { getBranch(): readonly unknown[] } }): string | undefined {
	try {
		const entry = ctx.sessionManager?.getBranch().findLast((e) => {
			const type = (e as { type?: string }).type;
			return type === "message" || type === "custom_message";
		}) as { id?: string } | undefined;
		return entry?.id;
	} catch {
		// A stale context after a session switch; with no mark there is no reminder.
		return undefined;
	}
}

export function watchMain(pi: Pick<ExtensionAPI, "on">, mail: () => MainMail | null | undefined, now: () => number = Date.now): MainWatch {
	let running = false;
	let settling = false;
	let inputAt = Number.NEGATIVE_INFINITY;
	let stoppedRun = false;
	/** Whether this run reached the settle check; Pi skips it only for a run that was stopped. */
	let checked = false;
	let settledAt = Number.NEGATIVE_INFINITY;
	/** The last thing said when a stopped run settled; a compaction that follows it with nothing said since stopped it. */
	let stopMark: string | undefined;
	let compactionStopped = false;
	const retry = () => mail()?.retry();
	// Pi still says it is compacting while these events run; look again once it has let go.
	const retrySoon = () => { setTimeout(retry, 0); };
	const compacted = (remind: boolean) => {
		if (remind && compactionStopped) mail()?.remind();
		compactionStopped = false;
		// A prompt Pi compacted for before starting it is still in its preflight.
		if (now() - inputAt < PENDING_INPUT_MS) inputAt = now();
		retrySoon();
	};
	pi.on("session_start", async () => {
		running = false;
		settling = false;
		inputAt = Number.NEGATIVE_INFINITY;
		stoppedRun = false;
		checked = false;
		stopMark = undefined;
		compactionStopped = false;
	});
	pi.on("input", async () => { inputAt = now(); });
	pi.on("agent_start", async () => {
		running = true;
		settling = false;
		checked = false;
		inputAt = Number.NEGATIVE_INFINITY;
		retry();
	});
	pi.on("agent_before_settle", async (event) => {
		checked = true;
		if (mail()?.owed(event.context)) return { continue: true };
		settling = true;
		return undefined;
	});
	pi.on("agent_end", async (event) => {
		const last = event.messages.at(-1) as { stopReason?: string } | undefined;
		stoppedRun = last?.stopReason === "aborted";
	});
	pi.on("agent_settled", async (_event, ctx) => {
		running = false;
		settling = false;
		settledAt = now();
		// Stopped mid-reply, or between turns (waiting to retry, compacting) where the last reply looks finished.
		stopMark = stoppedRun || !checked ? lastSaid(ctx) : undefined;
		// Input given while main ran was steered into that run, which has ended.
		inputAt = Number.NEGATIVE_INFINITY;
		retry();
	});
	pi.on("turn_end", async (_event, ctx) => {
		try {
			mail()?.answered(ctx.sessionManager.getBranch());
		} catch {
			// A stale context after a session switch; that session's mail is gone with it.
		}
	});
	// Pi doesn't continue a turn a /compact stopped, so mail main hadn't replied to would sit there.
	pi.on("session_before_compact", async (event, ctx) => {
		compactionStopped = event.reason === "manual" && stopMark !== undefined && now() - settledAt < STOP_WINDOW_MS && lastSaid(ctx) === stopMark;
		return undefined;
	});
	pi.on("session_compact", async (event) => compacted(event.reason === "manual"));
	pi.on("session_compact_failed", async (event) => compacted(event.reason === "manual" && !event.aborted));
	pi.on("session_tree", async () => retrySoon());
	return {
		route(ctx) {
			if (ctx.isIdle()) return now() - inputAt < INPUT_GRACE_MS ? "hold" : "wake";
			return running && !settling ? "queue" : "hold";
		},
	};
}
