/**
 * Live repro of finding F5 (README.md): a message that main steers into a
 * running child while the child's `input` handler awaits I/O is lost. Pi's
 * steer() awaits the input handlers before it queues (agent-session.js:1752-1766).
 * The run ends first: late() finds no queued message, settle() clears `unread`
 * (team.ts:869), and the steer then lands in the queue of an idle session. The
 * quiet-spell release drops it with the session.
 *
 *   node formal/subagents-lifecycle/repro-f5.mts            (the message is lost)
 *   node formal/subagents-lifecycle/repro-f5.mts --no-hold  (control: the input handler does not wait)
 *
 * It prints JSON and exits 1 when the message is kept nowhere.
 */
import { hold, liveTeam, open, release, sleep, spawn, until } from "./repro-support.mts";

const holdInput = !process.argv.includes("--no-hold");
const { team, launches, reports } = await liveTeam({ holdEvent: "input", bashGate: (_n, call) => (call === 1 ? "bash-1" : undefined) });
spawn(team, "kid");
// 1. The child's run waits in its first bash call.
await until("run 1 calls bash", () => launches[0]?.modelCalls === 1);
await sleep(200);
const id = launches[0]!.session.sessionId;
// 2. The child's input handler now awaits I/O; main steers a message into the running child.
if (holdInput) hold(id);
await team.send("main", "kid", "MSG-ONE: also do Y.");
await sleep(100);
const afterSend = { state: team.get("kid")!.state, unread: team.get("kid")!.unread, queued: launches[0]!.session.agent.hasQueuedMessages() };
// 3. The bash call ends. At HEAD the run ends before the steer reaches Pi's queue; with the fix it waits for the steer.
open("bash-1");
await until("the run ends", () => team.get("kid")!.state !== "running", 1_500).catch(() => undefined);
await sleep(300);
const atEnd = { state: team.get("kid")!.state, unread: team.get("kid")!.unread, inbox: team.get("kid")!.inbox, queued: launches[0]!.session.agent.hasQueuedMessages(), reports: reports.length };
// 4. The input handler ends: the steer lands in Pi's queue.
release(id);
await until("the run ends after the steer", () => team.get("kid")!.state !== "running");
await sleep(300);
const afterSteerLands = { state: team.get("kid")!.state, queued: launches[0]!.session.agent.hasQueuedMessages(), inTranscript: JSON.stringify(launches[0]!.session.messages).includes("MSG-ONE") };
// 5. The quiet-spell timer releases the idle session (sessions.ts:140-143), called here at once.
if (team.get("kid")!.state === "idle") await (team as any).sessions.release("kid");
await sleep(200);
const record = team.get("kid")!;
const kept = JSON.stringify([record.inbox ?? [], record.unread ?? []]).includes("MSG-ONE") || JSON.stringify(launches[0]!.session.messages).includes("MSG-ONE");
const result = { holdInput, afterSend, atEnd, afterSteerLands, afterIdleRelease: { held: (team as any).sessions.get("kid") !== undefined, messageKeptAnywhere: kept } };
console.log(JSON.stringify(result));
process.exit(kept ? 0 : 1);
