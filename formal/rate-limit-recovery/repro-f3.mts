/**
 * Live repro of finding F3 (reviewer, README.md) in Pi's real AgentSessionRuntime: the user
 * leaves a session during the idle wait for a local server and comes back more than 10 min later
 * (/resume, or pi --continue). session_start "resume" refuses the restore (RESTART_RESTORE_MAX_AGE_MS),
 * but the open local-wait entry stays the last one on the branch. The user works in the session.
 * A later /reload restores the wait (RESTORE_MAX_AGE_MS, 48 h), and when the server answers, a run
 * starts on its own.
 *
 *   node formal/rate-limit-recovery/repro-f3.mts          (back after 11 min: 1 run starts on its own)
 *   node formal/rate-limit-recovery/repro-f3.mts --soon   (control: back at once, the wait goes on, 0 runs)
 *
 * Real: Pi's AgentSessionRuntime.newSession() and switchSession(), session_shutdown and
 * session_start, AgentSession.reload(), and the whole rate-limit-recovery extension. Not real: the
 * model (a faux provider), the server check, the timers, and the 11 min gap (a Date.now patch
 * before the switch back). It exits 1 when the run starts on its own.
 */
import { LOCAL_FAILURE, ai, world } from "./repro-support.mts";

const late = !process.argv.includes("--soon");
const w = await world();
w.faux.setResponses([LOCAL_FAILURE(), ai.fauxAssistantMessage("Something else is done."), ai.fauxAssistantMessage("I continue the old task.")]);
// 1. The request to the local server fails. The run ends and the idle wait starts.
await w.host.session.prompt("Work on the task.");
await w.idle();
const pathA = w.host.session.sessionFile;
const afterFailure = w.localWaits();
// 2. The user leaves the session during the idle wait (session_shutdown: stop(true) keeps the entry open).
await w.host.newSession();
// 3. The user comes back 11 min later (or, in the control, at once).
const realNow = Date.now;
if (late) Date.now = () => realNow() + 11 * 60_000;
await w.host.switchSession(pathA);
const afterResume = w.localWaits();
// 4. The user works in the session.
await w.host.session.prompt("Do something else.");
await w.idle();
const callsBeforeReload = w.faux.state.callCount;
const beforeReload = w.localWaits();
// 5. The server is back. The user runs /reload.
w.release();
await w.host.session.reload();
await w.idle();
const result = {
	late, localWaitEntriesAfterFailure: afterFailure, localWaitEntriesAfterResume: afterResume, localWaitEntriesBeforeReload: beforeReload,
	modelCallsBeforeReload: callsBeforeReload, modelCallsAfterReload: w.faux.state.callCount,
	runsStartedOnTheirOwn: w.faux.state.callCount - callsBeforeReload, resumeMessages: w.resumeMessages(),
	lastReply: w.host.session.getLastAssistantText(), extensionErrors: w.errors.length,
};
console.log(JSON.stringify(result, null, 2));
await w.close();
process.exit(result.runsStartedOnTheirOwn > 0 ? 1 : 0);
