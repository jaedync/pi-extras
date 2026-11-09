/**
 * Live repro of finding F2 (README.md) with the real Team and real Pi
 * sessions: a stop while the child's prompt waits in before_agent_start, and
 * a message from main during that stop's abort, leave the old session's run
 * going on a disposed session. It calls the model with no listener.
 *
 *   node formal/subagents-lifecycle/repro-f2.mts             (the old session calls the model after the stop)
 *   node formal/subagents-lifecycle/repro-f2.mts --no-message (control: the stop alone stops it)
 *
 * It prints JSON and exits 1 when the stopped session called the model.
 */
import { entered, liveTeam, open, sleep, spawn, until } from "./repro-support.mts";

const message = !process.argv.includes("--no-message");
const { team, launches, reports } = await liveTeam({ slow: "before_agent_start" });
spawn(team, "kid");
// 1. The child's first prompt waits in before_agent_start (Pi's _prepareRun).
await until("the prompt waits in before_agent_start", () => entered("before_agent_start"));
// 2. Main stops it. Pi records the abort; it waits for the run to start and end.
const stopped = team.stop("kid");
await sleep(100);
const stopWaits = launches.length === 1 && team.get("kid")?.state === "stopped";
// 3. Main messages it during the stop's abort: routing relaunches it and releases the old session.
if (message) await team.send("main", "kid", "Go on with the task.");
await sleep(300);
const oldDisposed = launches[0]!.disposed;
// 4. The hook ends (the I/O it waited for is done).
open("before_agent_start");
await stopped;
await until("the team settles", () => !["queued", "starting", "running"].includes(team.get("kid")!.state), 15_000).catch(() => undefined);
await sleep(500);
const result = {
	message, stopWaits, oldSessionDisposedBeforeRun: oldDisposed,
	oldSessionModelCalls: launches[0]!.modelCalls, oldSessionBashRuns: launches[0]!.toolRuns,
	launches: launches.length, newSessionModelCalls: launches[1]?.modelCalls ?? 0,
	finalState: team.get("kid")!.state, reports,
};
console.log(JSON.stringify(result));
process.exit(result.oldSessionModelCalls > 0 ? 1 : 0);
