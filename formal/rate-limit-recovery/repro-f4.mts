/**
 * Live repro of finding F4 (reviewer, README.md) in Pi's real AgentSession: /tree while the
 * session is idle does not end the idle wait for a local server (the controller has no
 * session_tree handler, and the TUI aborts only a run that is active). The user goes back to the
 * first prompt, whose text Pi puts back in the editor. When the server answers, the idle wait
 * sends "Continue the task from where it stopped" and a run starts on its own on a branch with
 * no task.
 *
 *   node formal/rate-limit-recovery/repro-f4.mts           (1 run starts on its own on the new branch)
 *   node formal/rate-limit-recovery/repro-f4.mts --no-nav  (control: no /tree, the resume is owed)
 *
 * Real: Pi's AgentSession.navigateTree() (what /tree calls) and the whole rate-limit-recovery
 * extension. Not real: the model (a faux provider), the server check and the timers. It exits 1
 * when a run starts on its own after the navigation.
 */
import { LOCAL_FAILURE, ai, world } from "./repro-support.mts";

const nav = !process.argv.includes("--no-nav");
const w = await world();
const session = w.host.session;
const shape = () => session.sessionManager.getBranch().map((e: any) => e.type + (e.message ? `:${e.message.role}` : "") + (e.customType ? `:${e.customType}` : ""));
w.faux.setResponses([LOCAL_FAILURE(), ai.fauxAssistantMessage("I continue the old task.")]);
// 1. The request to the local server fails. The run ends and the idle wait starts.
await session.prompt("Work on the task.");
await w.idle();
// 2. The user runs /tree and goes back to the first prompt.
const firstPrompt = session.sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user");
const navigated = nav ? await session.navigateTree(firstPrompt.id, {}) : undefined;
const branchAfterNavigation = shape();
const callsBeforeRelease = w.faux.state.callCount;
// 3. The server answers the idle wait's check.
w.release();
await w.idle();
const result = {
	nav, editorText: navigated?.editorText, branchAfterNavigation,
	modelCallsBeforeRelease: callsBeforeRelease, modelCallsAfterRelease: w.faux.state.callCount,
	runsStartedOnTheirOwn: w.faux.state.callCount - callsBeforeRelease, branchAfterRelease: shape(),
	lastReply: session.getLastAssistantText(), extensionErrors: w.errors.length,
};
console.log(JSON.stringify(result, null, 2));
await w.close();
process.exit(nav && result.runsStartedOnTheirOwn > 0 ? 1 : 0);
