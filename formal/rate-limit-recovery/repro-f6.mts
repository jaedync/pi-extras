/**
 * Live repro of finding F6 (round-3 review, README.md): the /tree fix
 * "end the idle wait in session_before_tree, before the leaf moves" does not
 * fix F5. The closed entry is appended at the old leaf, as a child of it, so a
 * /tree back to the old leaf gives a path that ends in the open entry, and a
 * /reload restores the wait.
 *
 *   node formal/rate-limit-recovery/repro-f6.mts                   (back to the old leaf: 1 run starts on its own)
 *   node formal/rate-limit-recovery/repro-f6.mts --back-to-closed  (control: back to the closed entry itself: 0 runs)
 *
 * The fix is done by hand: `/rate-limit-recovery cancel` ends the wait before
 * the move, as a session_before_tree handler would. Real: Pi's AgentSession
 * navigateTree() and reload(), and the whole rate-limit-recovery extension.
 * Not real: the model (a faux provider), the server check and the timers.
 * It exits 1 when a run starts on its own after the reload.
 */
import { LOCAL_FAILURE, ai, world } from "./repro-support.mts";

const backToClosed = process.argv.includes("--back-to-closed");
const w = await world();
const s = () => w.host.session;
w.faux.setResponses([LOCAL_FAILURE(), ai.fauxAssistantMessage("Reply on branch Y."), ai.fauxAssistantMessage("I continue the old task.")]);
await s().prompt("Work on the task.");
await w.idle();
const leafX = s().sessionManager.getLeafId();
const leafXEntry = s().sessionManager.getEntry(leafX);
const onX = w.localWaits();
// Close before the move: the closed entry is appended at the old leaf.
await s().prompt("/rate-limit-recovery cancel"); await w.idle();
const leafAfterCancel = s().sessionManager.getLeafId();
const onXAfterCancel = w.localWaits();
const first = s().sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "user");
await s().navigateTree(first.id, {});
w.release();
await w.idle();
const onY = w.localWaits();
await s().navigateTree(backToClosed ? leafAfterCancel : leafX, {});
const backOnX = w.localWaits();
const callsBeforeReload = w.faux.state.callCount;
await s().reload();
await w.idle();
const result = { backToClosed, leafXType: leafXEntry?.type, leafXState: leafXEntry?.data?.state, entriesOnX: onX, entriesOnXAfterCancel: onXAfterCancel,
	entriesOnY: onY, entriesBackOnX: backOnX, runsStartedOnTheirOwnAfterReload: w.faux.state.callCount - callsBeforeReload,
	lastReply: s().getLastAssistantText(), extensionErrors: w.errors.length };
console.log(JSON.stringify(result, null, 2));
await w.close();
process.exit(result.runsStartedOnTheirOwnAfterReload > 0 ? 1 : 0);
