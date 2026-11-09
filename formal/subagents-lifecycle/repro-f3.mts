/**
 * Live repro of finding F3 (README.md) with the real Team and real Pi
 * sessions: a message from main relaunches a child while a stop still waits
 * for its abort. A second stop of the child, which now runs again, is refused
 * as if it had ended, and the child goes on to the end of its run.
 *
 *   node formal/subagents-lifecycle/repro-f3.mts            (the second stop returns undefined)
 *   node formal/subagents-lifecycle/repro-f3.mts --no-message (control: one stop, no relaunch)
 *
 * The abort waits because an agent_end handler awaits I/O (Pi's abort waits
 * for the run to end, agent-session.js:1971-1989). It prints JSON and exits 1
 * when a stop was refused for a running child.
 */
import { liveTeam, open, sleep, spawn, until } from "./repro-support.mts";

const message = !process.argv.includes("--no-message");
const { team, launches, reports } = await liveTeam({ slow: "agent_end", bashWaits: "bash" });
spawn(team, "kid");
// 1. The child runs a bash call that waits.
await until("the child runs bash", () => launches[0]?.modelCalls === 1);
await sleep(200);
// 2. Main stops it. The abort ends the bash call; agent_end handlers still run, so the abort waits.
const first = team.stop("kid");
await sleep(200);
// 3. Main messages it during the abort: routing relaunches it in a new session.
if (message) await team.send("main", "kid", "Go on with the task.");
await until("the new run calls bash", () => !message || launches[1]?.modelCalls === 1).catch(() => undefined);
const stateBeforeSecondStop = team.get("kid")!.state;
// 4. Main stops it again. A stop that goes on waits for the abort, as the first did; a refused one returns undefined at once.
let secondResult = "waits";
const second = team.stop("kid").then((record) => { secondResult = record === undefined ? "refused" : "stopped"; });
await sleep(300);
const refused = secondResult === "refused";
// 5. Everything ends.
open("agent_end");
open("bash");
await first;
await second;
await until("the team settles", () => !["queued", "starting", "running"].includes(team.get("kid")!.state), 15_000).catch(() => undefined);
await sleep(500);
const result = {
	message, stateBeforeSecondStop, secondStopRefused: refused, finalState: team.get("kid")!.state,
	newSessionBashRuns: launches[1]?.toolRuns ?? 0, reports,
};
console.log(JSON.stringify(result));
process.exit(refused && ["queued", "starting", "running"].includes(stateBeforeSecondStop) ? 1 : 0);
