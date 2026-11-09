/**
 * Live repro of findings F2a and F4 (README.md) in Pi's real AgentSession
 * with real model runs (Pi's faux provider). No /reload and no other
 * extension take part.
 *
 *   node formal/shell-jobs-delivery/repro-f2.mts                         (F2a: two jobs, Esc in the TUI)
 *   node formal/shell-jobs-delivery/repro-f2.mts --one-job               (control: one job, Esc in the TUI)
 *   node formal/shell-jobs-delivery/repro-f2.mts --one-job --keep-queue  (F4: one job, an abort without clearQueue, as RPC "abort" does)
 *   node formal/shell-jobs-delivery/repro-f2.mts --one-job --job-after-abort  (F5: Esc in the TUI, then the job ends before the run stops)
 *   node formal/shell-jobs-delivery/repro-f2.mts --one-job --compact          (F4 in the TUI: /compact aborts the run and keeps the queue)
 *   --mode tui|rpc|print   the mode that the extensions see (default: tui, or rpc with --keep-queue)
 *
 * Before the fix (pi-extras cf08a6a) F2a gave {"echo-a":1,"echo-b":2} and F4
 * gave {"echo-a":2}. With the fix every job gets 1 message. After an abort,
 * a kept completion lands in the next run, and a dropped one is sent again
 * when the next run settles, so the script starts one more user run at the end.
 *
 * Real: AgentSession, prompt(), steer, clearQueue() and abort() (what Esc
 * does in interactive mode), agent_settled and its deferred sends, and the
 * whole shell-jobs extension with real jobs. Not real: the model is Pi's faux
 * provider, which answers after a short wait.
 * It prints the completion messages per job, after the abort settled and
 * after one more user run, and exits 1 when a job does not have exactly 1.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "fv-repro-f2-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;

// The first turn waits for a file, so the jobs can end while it runs. Later turns answer at once.
const holdTurn = join(scratch, "hold-turn");
let turns = 0;
const step = async () => {
	turns += 1;
	if (turns === 1) await new Promise<void>((resolve) => {
		const timer = setInterval(() => { try { rmSync(holdTurn); clearInterval(timer); resolve(); } catch { /* not yet */ } }, 10);
	});
	return ai.fauxAssistantMessage("ok");
};

const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
runtime.registerNativeProvider(faux.provider);
faux.setResponses(Array.from({ length: 20 }, () => step));
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off" });
const loader = new sdk.DefaultResourceLoader({
	cwd: scratch, agentDir, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/shell-jobs.ts", import.meta.url))],
});
await loader.reload();
const { session } = await sdk.createAgentSession({
	cwd: scratch, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "m"),
	settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch),
});
const compact = process.argv.includes("--compact");
const keepQueue = process.argv.includes("--keep-queue") || compact;
const modeAt = process.argv.indexOf("--mode");
const mode = modeAt > 0 ? process.argv[modeAt + 1] : keepQueue && !compact ? "rpc" : "tui";
// No UI: shell-jobs reads ctx.mode for the abort rule and skips its widget.
await session.bindExtensions({ mode, uiContext: { notify: () => undefined } });

const tool = (name: string) => session.agent.state.tools.find((t: any) => t.name === name);
const perJob = () => {
	const counts: Record<string, number> = {};
	for (const e of session.sessionManager.getBranch() as any[]) {
		if (e.type === "custom_message" && e.customType === "shell-job-complete") counts[e.details.id] = (counts[e.details.id] ?? 0) + 1;
	}
	return counts;
};

const jobs = process.argv.includes("--one-job") ? ["echo a"] : ["echo a", "echo b"];
// 1. A run is active (the model is slow to answer).
const run = session.prompt("work");
await sleep(200);
const startJobs = async () => {
	for (const command of jobs) await tool("shell_job_start").execute("call", { command, title: command });
	await sleep(800);
};
const afterAbort = process.argv.includes("--job-after-abort");
// 2. The jobs end during the run. Their completions are steered into the run.
if (!afterAbort) await startJobs();
// 3. The user presses Esc: interactive mode clears the queues and aborts the run.
// With --keep-queue, the abort keeps the queue, as the RPC "abort" command
// (rpc-mode.js:328) and ctx.abort() in a mode with no abortHandler do.
if (!keepQueue) session.clearQueue();
// With --compact, /compact in the TUI: AgentSession.compact() calls abort() and keeps the queue.
const aborting = compact ? session.compact().catch(() => undefined) : session.abort();
// With --job-after-abort, the jobs end after the clear, while the aborted run
// still winds down (here: the faux model has not answered yet). Their
// completions stay in the queue, also in the TUI.
if (afterAbort) await startJobs();
// The faux model does not watch the abort signal; let its held answer return.
writeFileSync(holdTurn, "");
await aborting;
await run.catch(() => undefined);
// 4. agent_settled: shell-jobs sends both again; Pi defers both and runs them one at a time.
await session.waitForIdle();
await sleep(1500);
await session.waitForIdle();
const settledCounts = perJob();
// 5. One more user run: it takes a message that the abort kept in the queue.
await session.prompt("next");
await session.waitForIdle();
await sleep(1500);
await session.waitForIdle();
const counts = perJob();
const ids = jobs.map((command) => command.replace(" ", "-"));
console.log(JSON.stringify({ jobs: jobs.length, mode, keepQueue, afterAbort: settledCounts, afterNextRun: counts, turns }));
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
rmSync(scratch, { recursive: true, force: true });
process.exit(ids.every((id) => counts[id] === 1) ? 0 : 1);
