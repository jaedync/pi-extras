/**
 * Live repro of the gap case (README.md, "Known limits" of the first fix):
 * a job ends while another extension's before_agent_start handler awaits, and
 * the user presses Esc during that wait. The handler is Pull Link auto-pull,
 * the real code from lib/link-context/auto.ts with a reader that takes 2 s
 * (slow-links-extension.ts). Extension order is as in package.json:
 * shell-jobs first.
 *
 *   node formal/shell-jobs-delivery/repro-gap.mts             (Esc in the TUI: clearQueue, then abort)
 *   node formal/shell-jobs-delivery/repro-gap.mts --no-esc    (control: no abort)
 *
 * Steps: start a job that ends after 0.5 s; send a prompt with a link, so
 * the run waits 2 s in before_agent_start; the job ends in that wait; Esc at
 * 1 s; wait until Pi is idle; then one more user run. It prints when the
 * first agent loop started (about 2000 ms: after the read), the
 * completion messages per job after the abort and after the next run, and
 * exits 0 only when the job has exactly 1 message after the next run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "fv-repro-gap-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;

const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
runtime.registerNativeProvider(faux.provider);
faux.setResponses(Array.from({ length: 20 }, () => () => ai.fauxAssistantMessage("ok")));
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off" });
const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const loader = new sdk.DefaultResourceLoader({
	cwd: scratch, agentDir, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [here("../../extensions/shell-jobs.ts"), here("./slow-links-extension.ts")],
});
await loader.reload();
const { session } = await sdk.createAgentSession({
	cwd: scratch, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "m"),
	settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch),
});
await session.bindExtensions({ mode: "tui", uiContext: { notify: () => undefined, setStatus: () => undefined } });

const tool = (name: string) => session.agent.state.tools.find((t: any) => t.name === name);
const perJob = () => {
	const counts: Record<string, number> = {};
	for (const e of session.sessionManager.getBranch() as any[]) {
		if (e.type === "custom_message" && e.customType === "shell-job-complete") counts[e.details.id] = (counts[e.details.id] ?? 0) + 1;
	}
	return counts;
};
const settle = async () => {
	await session.waitForIdle();
	await sleep(1500);
	await session.waitForIdle();
};

const esc = !process.argv.includes("--no-esc");
// When the first agent loop starts, after the prompt: proof that the run waited for the link read.
const t0 = Date.now();
let firstLoopMs: number | undefined;
session.subscribe((event: any) => { if (event.type === "agent_start") firstLoopMs ??= Date.now() - t0; });
// 1. A job that ends during the link wait of the next run.
await tool("shell_job_start").execute("call", { command: "sleep 0.5; echo a", title: "slow echo" });
// 2. A prompt with a link: the run waits in before_agent_start for the read.
const run = session.prompt("read https://example.com/page").catch(() => undefined);
// 3. Esc in the TUI during the wait, after the job ended: clear the queues, then abort.
await sleep(1000);
const busyAtEsc = !session.isIdle;
if (esc) {
	session.clearQueue();
	await session.abort();
}
await run;
await settle();
const afterAbort = perJob();
// 4. One more user run.
await session.prompt("next");
await settle();
const afterNextRun = perJob();
console.log(JSON.stringify({ esc, busyAtEsc, firstLoopMs, afterAbort, afterNextRun }));
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
rmSync(scratch, { recursive: true, force: true });
const counts = Object.values(afterNextRun);
process.exit(counts.length === 1 && counts[0] === 1 ? 0 : 1);
