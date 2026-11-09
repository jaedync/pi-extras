/**
 * Probe of the three Pi rules behind finding F (README.md), with no
 * pi-extras code: a minimal extension sends a custom message with
 * `triggerTurn: true` and reads `ctx.isIdle()`. Use it to check whether a new
 * Pi release still behaves this way.
 *
 *   node formal/shell-jobs-delivery/pi-probe.mts
 *   PI_TEST_AGENT_ROOT=<path to @earendil-works/pi-coding-agent> node formal/shell-jobs-delivery/pi-probe.mts
 *
 * Each field is true when Pi still holds a sent message that is not in the
 * session while `ctx.isIdle()` is true:
 * - idleWhileDeferred: a send from an agent_settled handler waits in Pi's
 *   deferred actions.
 * - idleWithKeptQueue: AgentSession.abort() without clearQueue() (the RPC
 *   abort) keeps a steered message for the next run.
 * - idleAfterClearThenSteer: clearQueue() then abort() (what Esc does in the
 *   TUI), and a message steered before the run stops, is kept for the next run.
 * For each kept message, `landsInNextRun` tells that the next user run puts it
 * in the session.
 *
 * The pi-extras fix relies on two more rules (`fixRules`): ctx.signal is
 * undefined while no agent loop runs, defined while one runs, and aborted
 * once abort() ran; and before_agent_start names the custom message that
 * starts a run, also for a deferred send. When a field is false, read the fix
 * again (lib/shell-jobs-delivery.ts) before you use that Pi release. Real: AgentSession, its extension runner, prompt(), steer,
 * clearQueue(), abort(). Not real: the model is Pi's faux provider.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "fv-pi-probe-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;
const version = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")).version as string;

// The probe extension: it hands its API to this script, and it can send one
// message from its agent_settled handler.
const probe = join(scratch, "probe.ts");
writeFileSync(probe, `
export default function (pi: any) {
	const state: any = (globalThis as any).__probe;
	state.pi = pi;
	pi.on("agent_settled", (_event: any, ctx: any) => {
		state.ctx = ctx;
		if (state.sendOnSettle) {
			state.sendOnSettle = false;
			state.signalInSettle = ctx.signal === undefined ? "undefined" : "defined";
			pi.sendMessage(state.message("deferred"), { triggerTurn: true, deliverAs: "steer" });
			state.idleAfterSettleSend = ctx.isIdle();
		}
	});
	pi.on("session_start", (_event: any, ctx: any) => { state.ctx = ctx; });
	pi.on("before_agent_start", (event: any) => {
		if (event.messageType === "custom" && event.message?.customType === "probe") state.started.push(event.message.details?.id);
	});
}
`);
const state: any = {
	sendOnSettle: false,
	started: [] as string[],
	message: (id: string) => ({ customType: "probe", display: true, content: `probe ${id}`, details: { id } }),
};
(globalThis as any).__probe = state;

// While the gate is closed, the model does not answer, so the run stays active.
let gateOpen = true;
const step = async () => {
	while (!gateOpen) await sleep(10);
	return ai.fauxAssistantMessage("ok");
};
const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 100_000 }] });
runtime.registerNativeProvider(faux.provider);
faux.setResponses(Array.from({ length: 40 }, () => step));
const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: "off" });
const loader = new sdk.DefaultResourceLoader({
	cwd: scratch, agentDir, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [probe],
});
await loader.reload();
const { session } = await sdk.createAgentSession({
	cwd: scratch, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "m"),
	settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch),
});
await session.bindExtensions({ mode: "rpc", uiContext: { notify: () => undefined } });

const inSession = (id: string) => (session.sessionManager.getBranch() as any[])
	.filter((e) => e.type === "custom_message" && e.customType === "probe" && e.details?.id === id).length;
const idle = () => state.ctx.isIdle() as boolean;
/** Start a run whose model answer waits until `release` is called. */
const heldRun = () => {
	gateOpen = false;
	return { run: session.prompt("work").catch(() => undefined), release: () => { gateOpen = true; } };
};
const nextRun = async () => {
	gateOpen = true;
	await session.prompt("next");
	await session.waitForIdle();
	await sleep(200);
};

// 1. A send from an agent_settled handler.
state.sendOnSettle = true;
await session.prompt("first");
const deferred = { idleRightAfterSend: state.idleAfterSettleSend, landsLater: 0 };
await session.waitForIdle();
await sleep(200);
deferred.landsLater = inSession("deferred");

// 2. A steered message, then abort() with no clearQueue().
let held = heldRun();
await sleep(200);
const signalInRun = state.ctx.signal;
const signalInRunAborted = signalInRun?.aborted;
state.pi.sendMessage(state.message("kept"), { triggerTurn: true, deliverAs: "steer" });
const aborting = session.abort();
held.release();
await aborting;
await held.run;
await session.waitForIdle();
await sleep(200);
const kept = { idleAfterSettle: idle(), inSessionAfterSettle: inSession("kept"), landsInNextRun: 0 };
await nextRun();
kept.landsInNextRun = inSession("kept");

// 3. clearQueue() and abort() first (Esc in the TUI), then a steered message before the run stops.
held = heldRun();
await sleep(200);
session.clearQueue();
const aborting2 = session.abort();
const signalAfterAbort = state.ctx.signal;
state.pi.sendMessage(state.message("late"), { triggerTurn: true, deliverAs: "steer" });
held.release();
await aborting2;
await held.run;
await session.waitForIdle();
await sleep(200);
const late = { idleAfterSettle: idle(), inSessionAfterSettle: inSession("late"), landsInNextRun: 0 };
await nextRun();
late.landsInNextRun = inSession("late");

const result = {
	pi: version,
	idleWhileDeferred: deferred.idleRightAfterSend === true,
	idleWithKeptQueue: kept.idleAfterSettle && kept.inSessionAfterSettle === 0 && kept.landsInNextRun === 1,
	idleAfterClearThenSteer: late.idleAfterSettle && late.inSessionAfterSettle === 0 && late.landsInNextRun === 1,
	fixRules: {
		signalUndefinedInSettle: state.signalInSettle === "undefined",
		signalDefinedInRun: signalInRun !== undefined && signalInRunAborted === false,
		signalAbortedAfterAbort: signalAfterAbort?.aborted === true,
		beforeAgentStartNamesDeferredSend: state.started.includes("deferred"),
	},
	detail: { deferred, kept, late },
};
console.log(JSON.stringify(result));
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
