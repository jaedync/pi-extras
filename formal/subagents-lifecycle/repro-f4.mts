/**
 * Live repro of finding F4 (README.md) with the real Team and real Pi
 * sessions: a stop whose abort waits long (an agent_end handler that awaits
 * I/O) goes on only after a message relaunched the child, its new run ended,
 * a second message started another run and a second stop began. The first
 * stop's `this.ending.delete(name)` (team.ts:420) then clears the second
 * stop's mark: the team says no stop is under way and that it is quiet while
 * the second stop still aborts the child.
 *
 *   node formal/subagents-lifecycle/repro-f4.mts
 *
 * It prints JSON and exits 1 when stopping() is false while a stop is in flight.
 */
import { hold, liveTeam, open, release, sleep, spawn, until } from "./repro-support.mts";

const { team, launches, reports } = await liveTeam({ holdEvent: "agent_end", bashGate: (n, call) => (n === 1 ? "bash-1" : call === 2 ? "bash-2" : undefined) });
spawn(team, "kid");
await until("run 1 calls bash", () => launches[0]?.modelCalls === 1);
await sleep(200);
const first = launches[0]!.session.sessionId;
// 1. Stop 1: its abort waits, since session 1's agent_end handler holds.
hold(first);
let firstDone = false;
const stop1 = team.stop("kid").then(() => { firstDone = true; });
await sleep(300);
// 2. A message relaunches it in session 2; that run ends idle.
await team.send("main", "kid", "Go on with the task.");
await until("run 2 ends idle", () => team.get("kid")!.state === "idle");
const second = launches[1]!.session.sessionId;
// 3. A second message starts a run in the held session 2; it waits in bash.
await team.send("main", "kid", "One more thing.");
await until("run 3 calls bash", () => launches[1]!.modelCalls >= 3);
// 4. Stop 2, whose abort also waits.
hold(second);
let secondDone = false;
const stop2 = team.stop("kid").then(() => { secondDone = true; });
await sleep(300);
const beforeRelease = { stopping: team.stopping(), quiet: team.quiet(), state: team.get("kid")!.state };
// 5. Session 1's handler ends: stop 1 goes on, sees a newer launch, and clears `ending`.
release(first);
await stop1;
await sleep(200);
const afterFirstStop = { stopping: team.stopping(), quiet: team.quiet(), secondStopInFlight: !secondDone, state: team.get("kid")!.state, reports: reports.length };
// 6. Everything ends.
release(second);
open("bash-1"); open("bash-2");
await stop2;
await sleep(300);
const result = { firstDone, beforeRelease, afterFirstStop, final: { state: team.get("kid")!.state, stopping: team.stopping() }, reports };
console.log(JSON.stringify(result));
process.exit(afterFirstStop.secondStopInFlight && !afterFirstStop.stopping ? 1 : 0);
