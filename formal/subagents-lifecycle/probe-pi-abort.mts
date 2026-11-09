/**
 * Checks the Pi rule that the model uses for an abort (README.md, rule P1):
 * AgentSession.abort() stops a run only when the agent loop runs. An abort
 * while prompt() still waits before its run (an `input` handler, or
 * `_prepareRun`: compaction check, `before_agent_start` handlers) does not
 * stop the run that follows.
 *
 *   node formal/subagents-lifecycle/probe-pi-abort.mts input     (abort in an input handler)
 *   node formal/subagents-lifecycle/probe-pi-abort.mts prepare   (abort in before_agent_start)
 *   node formal/subagents-lifecycle/probe-pi-abort.mts dispose   (dispose in before_agent_start)
 *   node formal/subagents-lifecycle/probe-pi-abort.mts running   (control: abort in a tool call)
 *
 * Real: Pi's AgentSession, its extension runner, abort(), dispose(), the
 * agent loop and the bash tool. The model is Pi's faux provider. It prints
 * what happened after the abort, as JSON.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const mode = process.argv[2] ?? "prepare";
const scratch = mkdtempSync(join(tmpdir(), "fv-probe-abort-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;

// An extension that holds the prompt before its run, until a file exists.
const gate = join(scratch, "gate");
const entered = join(scratch, "entered");
const slow = join(scratch, "slow.ts");
const event = mode === "input" ? "input" : "before_agent_start";
writeFileSync(slow, `
import { existsSync, writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on(${JSON.stringify(event)}, async () => {
		if (${JSON.stringify(mode)} === "running") return undefined;
		writeFileSync(${JSON.stringify(entered)}, "");
		while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 10));
		return undefined;
	});
}
`);

const touched = join(scratch, "tool-ran");
let modelCalls = 0;
const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
runtime.registerNativeProvider(faux.provider);
faux.setResponses(Array.from({ length: 10 }, () => (context: any) => {
	modelCalls += 1;
	// First a tool call that writes a file (a change in the work tree), then a final reply.
	if (context.messages.at(-1)?.role !== "toolResult") {
		const wait = mode === "running" ? `until [ -f '${gate}' ]; do sleep 0.02; done; ` : "";
		return ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `${wait}touch '${touched}'` }));
	}
	return ai.fauxAssistantMessage("done");
}));
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
	noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [slow] });
await loader.reload();
const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: faux.getModel("cheap"),
	settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch) });
await session.bindExtensions({ mode: "print" } as never);

const until = async (check: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await sleep(10);
	return check();
};

let promptDone = false;
const prompt = session.prompt("Work.").then(() => { promptDone = true; }, (error) => { promptDone = true; console.error("prompt threw", error.message); });
if (mode === "running") await until(() => modelCalls >= 1);
else await until(() => existsSync(entered));
const callsAtAbort = modelCalls;

let abortDone = false;
const started = Date.now();
if (mode === "dispose") { session.dispose(); abortDone = true; }
else void session.abort().then(() => { abortDone = true; });
await sleep(200);
const abortResolvedBeforeGate = abortDone;
writeFileSync(gate, "");
await until(() => promptDone, 5000);
await sleep(300);
const assistant = session.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.stopReason);
const agentMessages = (session.agent.state.messages as any[]).map((m) => m.role === "toolResult" ? `toolResult:${JSON.stringify(m.content).slice(0, 80)}` : m.role);
console.log(JSON.stringify({ agentMessages: process.argv.includes("--verbose") ? agentMessages : agentMessages.length,
	mode,
	modelCallsAtAbort: callsAtAbort,
	modelCallsAfter: modelCalls,
	abortResolvedBeforeGate,
	abortResolved: abortDone,
	abortWaitMs: abortDone ? Date.now() - started : null,
	toolRanAfterAbort: existsSync(touched),
	assistantStopReasons: assistant,
	promptResolved: promptDone,
}));
await prompt;
process.exit(0);
