/**
 * Live repro of finding F5 (round-2 review, README.md): /tree away from a
 * branch during the idle wait for a local server, /tree back, then /reload.
 * The closed entry of the wait goes to the new branch, or no entry is written
 * at all, so the old branch keeps "open" as its last local-wait entry. The
 * /reload restores the wait (RESTORE_MAX_AGE_MS, 48 h), and a "continue the
 * task" run starts on its own.
 *
 *   node formal/rate-limit-recovery/repro-f5.mts         (the code as it is: 1 run starts on its own)
 *   node formal/rate-limit-recovery/repro-f5.mts --fix   (the F4 fix as first proposed, done by hand with
 *                                                         /rate-limit-recovery cancel right after the move: 1 run)
 *
 * Real: Pi's AgentSession.navigateTree() and reload(), and the whole
 * rate-limit-recovery extension. Not real: the model (a faux provider), the
 * server check and the timers. It exits 1 when a run starts on its own after
 * the reload.
 */
import { LOCAL_FAILURE, ai, world } from "./repro-support.mts";

const fix = process.argv.includes("--fix");
const w = await world();
const s = () => w.host.session;
w.faux.setResponses([LOCAL_FAILURE(), ai.fauxAssistantMessage("Reply on branch Y."), ai.fauxAssistantMessage("I continue the old task.")]);
// 1. The request to the local server fails on branch X, and the idle wait starts.
await s().prompt("Work on the task.");
await w.idle();
const leafX = s().sessionManager.getLeafId();
const onX = w.localWaits();
// 2. /tree to the first prompt (branch Y). With --fix, the wait ends right after the move.
const first = s().sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user");
await s().navigateTree(first.id, {});
if (fix) { await s().prompt("/rate-limit-recovery cancel"); await w.idle(); }
const onYAfterNav = w.localWaits();
// 3. The server answers.
w.release();
await w.idle();
const onY = w.localWaits();
const callsOnY = w.faux.state.callCount;
// 4. /tree back to branch X, then /reload.
await s().navigateTree(leafX, {});
const backOnX = w.localWaits();
const callsBeforeReload = w.faux.state.callCount;
await s().reload();
await w.idle();
const result = { fix, entriesOnX: onX, entriesOnYAfterNav: onYAfterNav, entriesOnY: onY, modelCallsOnY: callsOnY,
	entriesBackOnX: backOnX, runsStartedOnTheirOwnAfterReload: w.faux.state.callCount - callsBeforeReload,
	lastReply: s().getLastAssistantText(), extensionErrors: w.errors.length };
console.log(JSON.stringify(result, null, 2));
await w.close();
process.exit(result.runsStartedOnTheirOwnAfterReload > 0 ? 1 : 0);
