/**
 * Stopping wv by a signal. A host tool timeout, a Ctrl-C or systemd sends
 * SIGTERM or SIGINT, and Node runs no finally block for either: preview.html
 * stayed in the project (and the next hyperframes check failed on two root
 * compositions), the staging folder stayed on disk, and a render's children ran
 * on with no parent. So the work that a finally would do is registered here.
 *
 * The whole shutdown has a deadline. A cleanup that never settles, or a
 * descendant that ignores both signals, must not keep wv alive: at the
 * deadline wv says what is left and exits with the code of the signal.
 */
import { writeSync } from "node:fs";
import { liveChildPids, refuseNewChildren, stopChildTrees } from "./proc.mjs";

/** At the deadline wv stops waiting, prints what is left and exits. */
export const SHUTDOWN_MS = 15000;

/** @type {Map<() => any, string>} */
const cleanups = new Map();
let stopping = false;

/**
 * Runs `cleanup` when the process is told to stop; returns a function that
 * unregisters it. `name` is what the deadline message calls it.
 */
export function onSignalCleanup(cleanup, name = "cleanup") {
	cleanups.set(cleanup, name);
	return () => cleanups.delete(cleanup);
}

/** A stop warning goes to stderr, never to the capture's output files. */
function warn(message) {
	// Synchronous: the deadline path calls process.exit, which drops a buffered write to a pipe.
	try {
		writeSync(2, `wv: ${message}\n`);
	} catch {
		// A closed stderr must not stop the shutdown.
	}
}

/** Waits for `promise` until `until`, and says whether it finished in time. */
async function untilDeadline(promise, until) {
	const left = until - Date.now();
	if (left <= 0) return { done: false, value: undefined };
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ done: false, value: undefined }), left);
	});
	try {
		return await Promise.race([promise.then((value) => ({ done: true, value })), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What the child stop leaves behind, as warnings: a tree cut at the cap, pids
 * that ignored both signals, and pids whose state could not be read. Unresolved
 * pids are reported before any cleanup runs, because a cleanup may remove the
 * files those processes still write. Returned, so a test can read it.
 */
export function shutdownNotes({ survivors = [], unresolved = [], truncated = false, lastSignal = null } = {}) {
	const notes = [];
	if (truncated) notes.push("the process tree was cut at the cap: some descendants may still run");
	if (unresolved.length) notes.push(`state unknown after ${lastSignal ?? "the stop"}: ${unresolved.map((entry) => entry.pid).join(", ")} (they may still run)`);
	if (survivors.length) notes.push(`still running after SIGKILL: ${survivors.map((entry) => entry.pid).join(", ")}`);
	return notes;
}

/** Prints what the deadline stopped, so a user can stop the pids by hand. */
function reportStuck(until, pending) {
	const pids = liveChildPids();
	const lines = ["wv: the shutdown deadline passed"];
	if (pids.length) lines.push(`still running: ${pids.join(", ")}`);
	if (pending) lines.push(`still pending: ${pending}`);
	if (until > Date.now()) lines.push("this should not happen: the deadline is not reached");
	warn(lines.join("; "));
}

/**
 * Installs the SIGINT, SIGTERM and SIGHUP handlers at wv's start. SIGINT is a
 * Ctrl-C (130), SIGTERM a timeout or a stop request (143) and SIGHUP a closed
 * terminal (129), as a shell reports them. Each signal stays handled after it
 * fires: a second Ctrl-C must not restore the default action in the middle of a
 * cleanup.
 */
export function installSignalHandlers() {
	/** @type {[NodeJS.Signals, number][]} */
	const signals = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];
	for (const [signal, code] of signals) {
		if (process.listenerCount(signal)) continue;
		process.on(signal, () => void shutdown(code));
	}
}

/**
 * Stops the children first and waits for them, so a render cannot write into a
 * folder that a cleanup then removes. Then the cleanups, in the order they were
 * registered. The exit code is set before the first await, so a deadline exit
 * still reports the signal.
 */
async function shutdown(code) {
	if (stopping) return;
	stopping = true;
	// Before the snapshot: a loop that catches a cancelled child must not start another.
	refuseNewChildren();
	const exitCode = code;
	process.exitCode = exitCode;
	const until = Date.now() + SHUTDOWN_MS;
	// The stop kills the children, so a run that waits on one fails, and its error can reach the
	// top level before the cleanups finish: Node then exits with 1 and skips them. From here the
	// shutdown owns the exit, and such an error is only reported.
	process.on("uncaughtException", (error) => warn(`during the stop: ${error?.message ?? error}`));

	const children = await untilDeadline(
		stopChildTrees({
			onError: (error, pid, name) => warn(`cannot send ${name} to ${pid}: ${error?.message ?? error}`),
		}).catch((error) => {
			warn(`the child stop failed: ${error?.message ?? error}`);
			return null;
		}),
		until,
	);
	if (!children.done) {
		reportStuck(until, "the child stop");
		process.exit(exitCode);
	}
	for (const note of shutdownNotes(children.value ?? {})) warn(note);

	for (const [cleanup, name] of cleanups) {
		// One failure is reported and the next cleanup still runs.
		const result = await untilDeadline(Promise.resolve().then(cleanup).catch((error) => warn(`${name} failed: ${error?.message ?? error}`)), until);
		if (!result.done) {
			reportStuck(until, name);
			process.exit(exitCode);
		}
	}
	process.exit(exitCode);
}
