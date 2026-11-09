/**
 * Live repro of finding F1 (README.md) in Pi's real AgentSessionRuntime: a
 * /clone during the idle wait for a local server copies the open local-wait
 * entry. A later /reload in the clone restores the wait, and when the server
 * answers, a run starts on its own in the clone.
 *
 *   node formal/rate-limit-recovery/repro-f1.mts             (the clone starts 1 run on its own)
 *   node formal/rate-limit-recovery/repro-f1.mts --no-clone  (control: the same steps in the first session, 0 runs)
 *
 * Real: Pi's AgentSessionRuntime.fork(leaf, { position: "at" }) (what /clone
 * calls), session_shutdown and session_start, AgentSession.reload(), and the
 * whole rate-limit-recovery extension. Not real: the model (a faux provider
 * at http://localhost:0), the server check (it always answers) and the timers
 * (they end on release()). It exits 1 when the run starts on its own.
 */
import { LOCAL_FAILURE, ai, world } from "./repro-support.mts";

const clone = !process.argv.includes("--no-clone");
const w = await world();
// 1. The request to the local server fails. The run ends and the idle wait starts.
w.faux.setResponses([LOCAL_FAILURE(), ai.fauxAssistantMessage("Something else is done."), ai.fauxAssistantMessage("I continue the old task.")]);
await w.host.session.prompt("Work on the task.");
await w.idle();
const afterFailure = w.localWaits();
// 2. The user runs /clone, then works in the clone (or, in the control, in the same session).
if (clone) await w.host.fork(w.host.session.sessionManager.getLeafId(), { position: "at" });
await w.host.session.prompt("Do something else.");
await w.idle();
const callsBeforeReload = w.faux.state.callCount;
const beforeReload = w.localWaits();
// 3. The server is back. The user runs /reload.
w.release();
await w.host.session.reload();
await w.idle();
const result = {
	clone, localWaitEntriesAfterFailure: afterFailure, localWaitEntriesBeforeReload: beforeReload,
	modelCallsBeforeReload: callsBeforeReload, modelCallsAfterReload: w.faux.state.callCount,
	runsStartedOnTheirOwn: w.faux.state.callCount - callsBeforeReload, resumeMessages: w.resumeMessages(),
	lastReply: w.host.session.getLastAssistantText(), extensionErrors: w.errors.length,
};
console.log(JSON.stringify(result, null, 2));
await w.close();
process.exit(result.runsStartedOnTheirOwn > 0 ? 1 : 0);
