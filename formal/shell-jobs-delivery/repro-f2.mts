/**
 * Live repro of findings F2a and F4 (README.md) in Pi's real AgentSession
 * with real model runs (Pi's faux provider). No /reload and no other
 * extension take part.
 *
 *   node formal/shell-jobs-delivery/repro-f2.mts                         (F2a: two jobs, Esc: a job gets 2 messages)
 *   node formal/shell-jobs-delivery/repro-f2.mts --one-job               (control: 1 message)
 *   node formal/shell-jobs-delivery/repro-f2.mts --one-job --keep-queue  (F4: one job, an abort without clearQueue, as RPC "abort" and ctx.abort() do: 2 messages)
 *
 * Real: AgentSession, prompt(), steer, clearQueue() and abort() (what Esc
 * does in interactive mode), agent_settled and its deferred sends, and the
 * whole shell-jobs extension with real jobs. Not real: the model is Pi's faux
 * provider, which answers after a short wait.
 * It prints the completion messages per job and exits 1 when a job has 2.
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
await session.bindExtensions({ mode: "print", uiContext: { notify: () => undefined } });

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
// 2. The jobs end during the run. Their completions are steered into the run.
for (const command of jobs) await tool("shell_job_start").execute("call", { command, title: command });
await sleep(800);
// 3. The user presses Esc: interactive mode clears the queues and aborts the run.
// With --keep-queue, the abort keeps the queue, as the RPC "abort" command
// (rpc-mode.js:328) and an extension's ctx.abort() (runner.js:666-668) do.
if (!process.argv.includes("--keep-queue")) session.clearQueue();
const aborting = session.abort();
// The faux model does not watch the abort signal; let its held answer return.
writeFileSync(holdTurn, "");
await aborting;
await run.catch(() => undefined);
// 4. agent_settled: shell-jobs sends both again; Pi defers both and runs them one at a time.
await session.waitForIdle();
await sleep(1500);
await session.waitForIdle();
const counts = perJob();
console.log(JSON.stringify({ jobs: jobs.length, completionMessages: counts, turns }));
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
rmSync(scratch, { recursive: true, force: true });
process.exit(Object.values(counts).some((n) => n >= 2) ? 1 : 0);
