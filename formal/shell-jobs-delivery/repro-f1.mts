/**
 * Live repro of finding F1 (README.md) in Pi's real AgentSession: a /reload
 * while agent_settled handlers still run makes shell-jobs deliver one
 * completion twice.
 *
 *   node formal/shell-jobs-delivery/repro-f1.mts              (before the fix, cf08a6a: 2 messages; with it: 1)
 *   node formal/shell-jobs-delivery/repro-f1.mts --no-reload  (control: 1 message)
 *
 * Real: Pi's AgentSession, its extension runner, reload(), the deferral of
 * sendCustomMessage during agent_settled, and the whole shell-jobs extension
 * with a real job. Not real: no model, so the test calls Pi's own
 * _emitAgentSettled (what Pi runs when a run ends), and a deferred send is
 * appended to the session at once instead of starting a model run. A second
 * extension stands for any extension whose agent_settled handler awaits I/O.
 * It prints the number of completion messages and exits 1 when it is not 1.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot } from "../../tests/support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "fv-repro-f1-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");

// An extension with a slow agent_settled handler. It waits for a file.
const gate = join(scratch, "settle-gate");
const slow = join(scratch, "slow-settle.ts");
writeFileSync(slow, `
import { existsSync } from "node:fs";
export default function (pi: any) {
	pi.on("agent_settled", async () => {
		while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 10));
	});
}
`);

const settingsManager = sdk.SettingsManager.inMemory();
const loader = new sdk.DefaultResourceLoader({
	cwd: scratch, agentDir, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	// shell-jobs first, so its agent_settled handler runs before the slow one.
	additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/shell-jobs.ts", import.meta.url)), slow],
});
await loader.reload();
const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(scratch) });
const s = session as any;
// No model: keep Pi's deferral branch (triggerTurn while agent_settled runs),
// but append a send that is not deferred at once, as a started run would.
const send = s.sendCustomMessage.bind(s);
s.sendCustomMessage = (message: any, options: any) => send(message, s._isEmittingAgentSettled ? options : { ...options, triggerTurn: false });
await session.bindExtensions({ onError: (error: unknown) => console.error("extension error", error) });

const tool = (name: string) => session.agent.state.tools.find((t: any) => t.name === name)!;
const release = join(scratch, "release-job");
const job = await tool("shell_job_start").execute("call", { command: `while [ ! -f '${release}' ]; do sleep 0.02; done; echo done` }) as any;
const completions = () => session.sessionManager.getBranch().filter((e: any) => e.type === "custom_message" && e.customType === "shell-job-complete").length;

// 1. A run ends: Pi emits agent_settled. The slow handler holds the emission open.
const settled = s._emitAgentSettled();
await sleep(50);
// 2. The job ends during the emission. Its completion is sent, and Pi defers it.
writeFileSync(release, "");
await sleep(500);
const afterExit = completions();
// 3. The user runs /reload. Pi allows it: no run is active (isStreaming is false).
const reload = !process.argv.includes("--no-reload");
if (reload) await session.reload();
await sleep(300);
// 4. The slow handler ends; Pi runs the deferred sends.
writeFileSync(gate, "");
await settled;
await sleep(200);
const total = completions();
console.log(JSON.stringify({ reload, job: job.details.id, inSessionAfterExit: afterExit, completionMessages: total }));
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
rmSync(scratch, { recursive: true, force: true });
process.exit(total === 1 ? 0 : 1);
