/**
 * Live repro of a further harm of finding F4 (README.md): the old stop's
 * relaunch branch also runs `this.stoppedByParent.delete(name)` (team.ts:421).
 * When the newer stop is by the child's parent (here main), which should get
 * no report (hand-up.ts:46, `silent`), the parent gets a "stopped" report.
 *
 *   node formal/subagents-lifecycle/repro-f4-byparent.mts          (main gets a "stopped" report)
 *   node formal/subagents-lifecycle/repro-f4-byparent.mts --alone  (control: one stop by main, no report)
 *
 * It prints JSON and exits 1 when main got a "stopped" report for a stop by main.
 */
import { hold, liveTeam, open, release, sleep, spawn, until } from "./repro-support.mts";

const alone = process.argv.includes("--alone");
if (alone) {
	const { team, launches, reports } = await liveTeam({ bashGate: (_n, call) => (call === 1 ? "bash-1" : undefined) });
	spawn(team, "kid");
	await until("run 1 calls bash", () => launches[0]?.modelCalls === 1);
	await team.stop("kid", { by: "main" });
	open("bash-1");
	await sleep(300);
	const stoppedReports = reports.filter((r) => r.state === "stopped").length;
	console.log(JSON.stringify({ alone, state: team.get("kid")!.state, reports, stoppedReports }));
	process.exit(stoppedReports > 0 ? 1 : 0);
}

const { team, launches, reports } = await liveTeam({ holdEvent: "agent_end", bashGate: (n, call) => (n === 1 ? "bash-1" : call === 2 ? "bash-2" : undefined) });
spawn(team, "kid");
await until("run 1 calls bash", () => launches[0]?.modelCalls === 1);
await sleep(200);
const first = launches[0]!.session.sessionId;
// 1. Stop 1 (by the user): its abort waits, since session 1's agent_end handler holds.
hold(first);
let firstDone = false;
const stop1 = team.stop("kid").then(() => { firstDone = true; });
await sleep(300);
// 2. A message relaunches it in session 2; that run ends idle and reports.
await team.send("main", "kid", "Go on with the task.");
await until("run 2 ends idle", () => team.get("kid")!.state === "idle");
const second = launches[1]!.session.sessionId;
// 3. A second message starts a run in the held session 2; it waits in bash.
await team.send("main", "kid", "One more thing.");
await until("run 3 calls bash", () => launches[1]!.modelCalls >= 3);
// 4. Stop 2, by main, the child's parent: no report should go up. Its abort also waits.
hold(second);
let secondDone = false;
const stop2 = team.stop("kid", { by: "main" }).then(() => { secondDone = true; });
await sleep(300);
// 5. Session 1's handler ends: stop 1 sees a newer launch and clears `ending` and `stoppedByParent`.
release(first);
await stop1;
await sleep(200);
const afterFirstStop = { stopping: team.stopping(), secondStopInFlight: !secondDone, reports: reports.length };
// 6. Stop 2 ends and hands a report up.
release(second);
open("bash-1"); open("bash-2");
await stop2;
await sleep(300);
const stoppedReports = reports.filter((r) => r.state === "stopped").length;
console.log(JSON.stringify({ alone, firstDone, afterFirstStop, final: { state: team.get("kid")!.state }, reports, stoppedReports }));
process.exit(stoppedReports > 0 ? 1 : 0);
