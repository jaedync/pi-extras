/**
 * Checks the Pi rules that recovery.qnt uses, in Pi's real AgentSession
 * (Pi 1.4.0), with a probe extension that records events and a faux model.
 *
 *   node formal/rate-limit-recovery/check-platform.mts
 *
 * Prints one line for each rule with "ok" or "WRONG", and exits 1 when a rule
 * is wrong. The rules:
 *   R1  A failed reply: message_end, turn_end, agent_end, agent_before_settle, agent_settled.
 *   R2  Pi awaits an async turn_end handler before agent_end.
 *   R3  A steer queued while the run starts (before_agent_start) goes into the first request.
 *   R4  A steer queued during the failing request continues the same run: a new context
 *       event, no before_agent_start, no agent_before_settle in between.
 *   R5  An abort during the turn_end wait aborts ctx.signal; the run ends with no
 *       agent_before_settle and no further request.
 *   R6  agent_before_settle { continue: true } gives a new request (context) in the same
 *       run with no before_agent_start.
 *   R7  sendCustomMessage with triggerTurn steers while a run is active, and starts a run
 *       (before_agent_start with messageType "custom") while idle.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ai, world } from "./repro-support.mts";

void world;
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "../../tests/support/pi-runtime.mjs";

const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;

async function probeSession(hooks: { turnEnd?: (ctx: any) => Promise<void> | void; settle?: () => any; beforeStart?: () => void; dropFailed?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "fv-rl-platform-"));
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
	const faux = ai.fauxProvider({ provider: "probe", models: [{ id: "m" }] });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const log: string[] = [];
	const contexts: any[] = [];
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "probe", factory: (pi: any) => {
			for (const name of ["message_end", "agent_end", "agent_settled"]) pi.on(name, (event: any) => { log.push(name === "message_end" ? `message_end:${event.message.role}` : name); });
			pi.on("before_agent_start", (event: any) => { log.push(`before_agent_start:${event.messageType}`); hooks.beforeStart?.(); });
			pi.on("context", (event: any) => { log.push("context"); contexts.push(event.messages); });
			pi.on("turn_end", async (event: any, ctx: any) => {
				log.push("turn_end"); await hooks.turnEnd?.(ctx); log.push("turn_end:done");
				// As recovery's turn_end does: the failed reply leaves the context.
				if (hooks.dropFailed && event.message.stopReason === "error") return { entries: [...event.entries, { type: "context_edit", targetId: event.messageEntryId, replacement: null }] };
				return undefined;
			});
			pi.on("agent_before_settle", () => { log.push("agent_before_settle"); return hooks.settle?.(); });
		} }],
	});
	await loader.reload();
	const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel("m"), settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd), noTools: "all" });
	await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, setWidget() {}, onTerminalInput: () => () => {} }, onError: (e: unknown) => console.error(e) });
	return { session, faux, log, contexts };
}
const fail = () => ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]);
const strip = (log: string[]) => log.filter((e) => !["message_end:user", "message_end:custom", "message_end:system"].includes(e));

{ // R1, R2
	const p = await probeSession({ turnEnd: () => sleep(100) });
	p.faux.setResponses([fail()]);
	await p.session.prompt("go");
	const order = strip(p.log).join(" ");
	check("R1", order === "before_agent_start:user context message_end:assistant turn_end turn_end:done agent_end agent_before_settle agent_settled", order);
	check("R2", p.log.indexOf("turn_end:done") < p.log.indexOf("agent_end"), order);
}
{ // R3
	let once = true;
	const p: any = await probeSession({ beforeStart: () => { if (once) { once = false; void p.session.prompt("steered", { streamingBehavior: "steer" }); } } });
	p.faux.setResponses([ai.fauxAssistantMessage("ok"), ai.fauxAssistantMessage("second")]);
	await p.session.prompt("go");
	const firstRequest = JSON.stringify(p.contexts[0] ?? []);
	check("R3", p.contexts.length === 1 && firstRequest.includes("steered"), `requests ${p.contexts.length}, the first has the steer: ${firstRequest.includes("steered")}`);
}
{ // R4
	const p = await probeSession();
	p.faux.setResponses([() => { void p.session.prompt("steered", { streamingBehavior: "steer" }); return fail(); }, ai.fauxAssistantMessage("ok")]);
	await p.session.prompt("go");
	const order = strip(p.log).join(" ");
	const between = p.log.slice(p.log.indexOf("agent_end"), p.log.lastIndexOf("context"));
	check("R4", p.contexts.length === 2 && !between.some((e) => e.startsWith("before_agent_start") || e === "agent_before_settle"), order);
}
{ // R5
	let signal: AbortSignal | undefined;
	const p = await probeSession({ turnEnd: async (ctx) => { signal = ctx.signal; void p.session.abort(); await sleep(50); } });
	p.faux.setResponses([fail(), ai.fauxAssistantMessage("never")]);
	await p.session.prompt("go");
	await sleep(100);
	const order = strip(p.log).join(" ");
	check("R5", signal?.aborted === true && !p.log.includes("agent_before_settle") && p.contexts.length === 1, `signal aborted ${signal?.aborted}; ${order}`);
}
{ // R6
	let once = true;
	const p = await probeSession({ dropFailed: true, settle: () => { if (once) { once = false; return { continue: true }; } return undefined; } });
	p.faux.setResponses([fail(), ai.fauxAssistantMessage("ok")]);
	// agent_before_settle may continue only with runnable context (agent-session.js:1583-1587),
	// so the probe drops the failed reply at turn_end, as recovery does.
	await p.session.prompt("go");
	const order = strip(p.log).join(" ");
	const starts = p.log.filter((e) => e.startsWith("before_agent_start")).length;
	check("R6", starts === 1 && p.contexts.length === 2, order);
}
{ // R7
	const p = await probeSession();
	p.faux.setResponses([() => { void p.session.sendCustomMessage({ customType: "x", content: "report", display: true }, { triggerTurn: true }); return ai.fauxAssistantMessage("one"); }, ai.fauxAssistantMessage("two"), ai.fauxAssistantMessage("three")]);
	await p.session.prompt("go");
	const startsInRun = p.log.filter((e) => e.startsWith("before_agent_start")).length;
	await p.session.sendCustomMessage({ customType: "x", content: "idle report", display: true }, { triggerTurn: true });
	await sleep(50);
	const starts = p.log.filter((e) => e.startsWith("before_agent_start"));
	check("R7", startsInRun === 1 && p.contexts.length === 3 && starts.at(-1) === "before_agent_start:custom", strip(p.log).join(" "));
}
for (const [name, ok, detail] of results) console.log(`${ok ? "ok   " : "WRONG"} ${name}: ${detail}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
