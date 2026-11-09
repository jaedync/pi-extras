/**
 * Live repro of finding F1 (README.md) with the real Team and real Pi
 * sessions: a stop while the child's prompt still waits before its run (here
 * in an async `input` handler) reports the child stopped at once, but Pi's
 * abort found no run, and the prompt runs after the stop: the session, already
 * disposed by the stop, calls the model with no listener.
 *
 *   node formal/subagents-lifecycle/repro-f1.mts            (the stopped child calls the model)
 *   node formal/subagents-lifecycle/repro-f1.mts --no-stop  (control: one normal run)
 *
 * It prints JSON and exits 1 when the stopped child called the model after the stop.
 */
import { entered, liveTeam, open, sleep, spawn, until } from "./repro-support.mts";

const stop = !process.argv.includes("--no-stop");
const { team, launches, reports } = await liveTeam({ slow: "input" });
spawn(team, "kid");
// 1. The child's first prompt waits in an input handler, before Pi marks a run active.
await until("the prompt waits in the input handler", () => entered("input"));
let stopDone = false;
// 2. Main stops it. Pi's abort finds no run and resolves; the team hands up a "stopped" report.
if (stop) void team.stop("kid").then(() => { stopDone = true; });
await sleep(300);
const stoppedBeforeRun = stopDone;
const callsAtStop = launches[0]!.modelCalls;
// 3. The input handler ends.
open("input");
await until("the team settles", () => !["queued", "starting", "running"].includes(team.get("kid")!.state), 15_000).catch(() => undefined);
await sleep(800);
const result = {
	stop, stopResolvedBeforeTheRun: stoppedBeforeRun, modelCallsAtStop: callsAtStop,
	modelCallsAfter: launches[0]!.modelCalls, bashRuns: launches[0]!.toolRuns, disposed: launches[0]!.disposed,
	state: team.get("kid")!.state, reports,
};
console.log(JSON.stringify(result));
process.exit(stop && result.modelCallsAfter > 0 ? 1 : 0);
