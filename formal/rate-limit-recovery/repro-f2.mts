/**
 * Live repro of finding F2 (README.md) in Pi's real AgentSession: a message
 * that the user types while the request to a local server is in flight is
 * queued as a steer. The request fails, the idle wait starts, and Pi
 * continues the same run with the queued message (no before_agent_start, so
 * the idle wait goes on). The continued request succeeds. When the server
 * check answers, the idle wait sends its resume message and a second run
 * starts on its own.
 *
 *   node formal/rate-limit-recovery/repro-f2.mts             (2 resumes of 1 failure: 3 model calls)
 *   node formal/rate-limit-recovery/repro-f2.mts --no-steer  (control: 1 resume, 2 model calls)
 *   node formal/rate-limit-recovery/repro-f2.mts --report    (a shell job style report steers in instead of the user)
 *
 * Real: Pi's AgentSession, its agent loop, the steering queue, the
 * continuation after agent_end, sendCustomMessage, and the whole
 * rate-limit-recovery extension. Not real: the model (a faux provider at
 * http://localhost:0), the server check (it always answers) and the timers
 * (they end on release()). It exits 1 when the failure is resumed twice.
 */
import { LOCAL_FAILURE, ai, world } from "./repro-support.mts";

const steer = !process.argv.includes("--no-steer");
const report = process.argv.includes("--report");
const w = await world();
const session = w.host.session;
w.faux.setResponses([
	() => {
		// 1. While the request is in flight, a message arrives. Pi queues it as a steer
		// (interactive-mode.js:2676-2681 for the user; sendCustomMessage :1857-1862 for a report).
		if (steer && report) void session.sendCustomMessage({ customType: "shell-job-complete", content: "Job 1 finished.", display: true }, { triggerTurn: true });
		else if (steer) void session.prompt("Also look at the tests.", { streamingBehavior: "steer" });
		// 2. The local server refuses the connection.
		return LOCAL_FAILURE();
	},
	ai.fauxAssistantMessage("Done with the task and the tests."),
	ai.fauxAssistantMessage("I continue the task from where it stopped."),
]);
await session.prompt("Work on the task.");
await w.idle();
const callsBeforeRelease = w.faux.state.callCount;
const entriesBeforeRelease = w.localWaits();
// 3. The server answers the idle wait's check.
w.release();
await w.idle();
const result = {
	steer, report, modelCallsBeforeRelease: callsBeforeRelease, localWaitEntriesBeforeRelease: entriesBeforeRelease,
	modelCallsAfterRelease: w.faux.state.callCount, resumeMessages: w.resumeMessages(),
	runsAfterTheTaskWentOn: steer ? w.faux.state.callCount - callsBeforeRelease : 0,
	lastReply: session.getLastAssistantText(), extensionErrors: w.errors.length,
};
console.log(JSON.stringify(result, null, 2));
await w.close();
process.exit(result.runsAfterTheTaskWentOn > 0 ? 1 : 0);
