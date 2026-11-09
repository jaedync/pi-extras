/**
 * Shared setup for the live repros of formal/subagents-lifecycle: the real
 * Team (lib/subagents/team.ts) with a launcher that opens a real Pi
 * AgentSession for each launch, on Pi's faux model.
 *
 * Real: Team, Slots, Routing, OpenSessions, ResumePrompts, and Pi's
 * AgentSession (prompt, abort, dispose, its extension runner, the agent loop
 * and its tools). Copied: the ChildHandle of child.ts handleFor (child.ts:689-731)
 * and its disposer (child.ts:654-672), in a few lines each, since they are not
 * exported. Not real: the model (Pi's faux provider) and the child's
 * extensions: one test extension holds a hook open until a gate file exists,
 * as an extension that awaits I/O does.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

export const scratch = mkdtempSync(join(tmpdir(), "fv-lifecycle-repro-"));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;
const { Team } = await import("../../lib/subagents/team.ts");

export const gate = (name: string) => join(scratch, `gate-${name}`);
export const open = (name: string) => writeFileSync(gate(name), "");
export const entered = (name: string) => existsSync(join(scratch, `entered-${name}`));

/** Holds the `hold` event of the session `id` (AgentSession.sessionId) until release(id). */
export const hold = (id: string) => writeFileSync(join(scratch, `hold-${id}`), "");
export const release = (id: string) => rmSync(join(scratch, `hold-${id}`), { force: true });

/** A child extension whose `event` handler waits while its session's hold file exists. */
function holdExtension(event: string): string {
	const file = join(scratch, `hold-${event}.ts`);
	writeFileSync(file, `
import { existsSync } from "node:fs";
export default function (pi: any) {
	pi.on(${JSON.stringify(event)}, async (_event: unknown, ctx: any) => {
		const id = ctx.sessionManager.getSessionId();
		while (existsSync(${JSON.stringify(scratch)} + "/hold-" + id)) await new Promise((r) => setTimeout(r, 10));
		return undefined;
	});
}
`);
	return file;
}

/** A child extension whose `event` handler waits until the gate `event` exists. */
function slowExtension(event: string): string {
	const file = join(scratch, `slow-${event}.ts`);
	writeFileSync(file, `
import { existsSync, writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on(${JSON.stringify(event)}, async () => {
		writeFileSync(${JSON.stringify(join(scratch, `entered-${event}`))}, "");
		while (!existsSync(${JSON.stringify(gate(event))})) await new Promise((r) => setTimeout(r, 10));
		return undefined;
	});
}
`);
	return file;
}

export interface Launch { n: number; modelCalls: number; toolRuns: number; disposed: boolean; session: any }

/**
 * A Team whose launches open real AgentSessions. Each launch has its own faux
 * model, so the repro can count the model calls of each session. The model
 * first calls bash, which writes a line to a file, then replies.
 */
export async function liveTeam(options: { slow?: string; bashWaits?: string; holdEvent?: string; bashGate?: (launch: number, call: number) => string | undefined } = {}) {
	const launches: Launch[] = [];
	const reports: Array<{ name: string; state: string }> = [];
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	const extensions = [...(options.slow ? [slowExtension(options.slow)] : []), ...(options.holdEvent ? [holdExtension(options.holdEvent)] : [])];
	const team = new Team({
		maxConcurrent: 1, maxDepth: 2, replyTimeoutMs: 60_000, idleReleaseMs: 1e9, warn: () => undefined,
		deliverToMain: (delivery: any) => { if (delivery.kind === "report") reports.push({ name: delivery.record.name, state: delivery.record.state }); },
		launcher: {
			async launch(record: any) {
				const launch: Launch = { n: launches.length + 1, modelCalls: 0, toolRuns: 0, disposed: false, session: undefined };
				launches.push(launch);
				const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false } as never);
				const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "cheap", contextWindow: 100_000 }] });
				runtime.registerNativeProvider(faux.provider);
				const mark = join(scratch, `tool-launch-${launch.n}`);
				let calls = 0;
				faux.setResponses(Array.from({ length: 12 }, () => (context: any) => {
					launch.modelCalls += 1;
					if (context.messages.at(-1)?.role !== "toolResult") {
						calls += 1;
						const named = options.bashGate?.(launch.n, calls) ?? options.bashWaits;
						const wait = named ? `until [ -f '${gate(named)}' ]; do sleep 0.02; done; ` : "";
						return ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: `${wait}echo ran >> '${mark}'` }));
					}
					return ai.fauxAssistantMessage(`${record.name} done`);
				}));
				const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true,
					noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: extensions });
				await loader.reload();
				const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: faux.getModel("cheap"),
					settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(scratch) });
				await session.bindExtensions({ mode: "print" } as never);
				launch.session = session;
				Object.defineProperty(launch, "toolRuns", { get: () => (existsSync(mark) ? readFileSync(mark, "utf8").split("\n").filter(Boolean).length : 0) });
				let disposed: Promise<void> | null = null;
				return {
					// child.ts:697-709
					async prompt(text: string) {
						await session.prompt(text);
						const last = [...session.messages].reverse().find((m: any) => m.role === "assistant") as any;
						if (last?.stopReason === "error") throw new Error(last.errorMessage || "The model returned an error.");
					},
					steer(text: string) { void session.steer(text).catch(() => undefined); },
					abort: () => session.abort(),
					lastText: () => session.getLastAssistantText(),
					messages: () => session.messages,
					takeQueued() {
						const agent = session.agent as { hasQueuedMessages?: () => boolean };
						if (agent.hasQueuedMessages?.() !== true) return [];
						const { steering, followUp } = session.clearQueue();
						return [...steering, ...followUp];
					},
					// child.ts:654-672: session_shutdown, then AgentSession.dispose.
					dispose: () => disposed ??= (async () => {
						await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
						session.dispose();
						launch.disposed = true;
					})(),
				};
			},
		},
	});
	return { team, launches, reports };
}

export async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await sleep(10);
	if (!check()) throw new Error(`timed out: ${what}`);
}

export const spawn = (team: any, name: string) => {
	const result = team.spawn({ name, task: `Task of ${name}.`, parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false });
	if (!result.ok) throw new Error(result.error);
};
export { sleep };
