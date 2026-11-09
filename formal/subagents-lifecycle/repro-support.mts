/**
 * Shared setup for the live repros of formal/subagents-lifecycle: the real
 * Team (lib/subagents/team.ts) with the real launcher (lib/subagents/child.ts
 * createLauncher), which opens a real Pi AgentSession for each launch, on Pi's
 * faux model.
 *
 * Real: Team, Slots, Routing, OpenSessions, ResumePrompts, the child handle
 * with its prompt gate (child-prompt.ts) and disposer, and Pi's AgentSession
 * (prompt, abort, steer, dispose, its extension runner, the agent loop and its
 * tools). Not real: the model (Pi's faux provider) and the child's extensions:
 * one test extension holds a hook open until a gate file exists, as an
 * extension that awaits I/O does.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { agentRoot, piAiRoot } from "../../tests/support/pi-runtime.mjs";

export const scratch = mkdtempSync(join(tmpdir(), "fv-lifecycle-repro-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.env.HOME = scratch;
const agentDir = join(scratch, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");
const ai = await import(pathToFileURL(join(piAiRoot, "dist/index.js")).href) as any;
const { Team } = await import("../../lib/subagents/team.ts");
const { createLauncher } = await import("../../lib/subagents/child.ts");

export const gate = (name: string) => join(scratch, `gate-${name}`);
export const open = (name: string) => writeFileSync(gate(name), "");
export const entered = (name: string) => existsSync(join(scratch, `entered-${name}`));

/** Holds the `hold` event of the session `id` (AgentSession.sessionId) until release(id). */
export const hold = (id: string) => writeFileSync(join(scratch, `hold-${id}`), "");
export const release = (id: string) => rmSync(join(scratch, `hold-${id}`), { force: true });

const toolName = (event: string) => `repro_${event}`;

/** A child extension whose `event` handler waits while its session's hold file exists. */
function holdExtension(event: string): string {
	const file = join(scratch, `hold-${event}.ts`);
	writeFileSync(file, `
import { existsSync } from "node:fs";
export default function (pi: any) {
	// child.ts loads only extensions that own one of the child's tools.
	pi.registerTool({ name: ${JSON.stringify(toolName(event))}, label: "repro", description: "Unused.", parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: "" }], details: {} }; } });
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
	// child.ts loads only extensions that own one of the child's tools.
	pi.registerTool({ name: ${JSON.stringify(toolName(event))}, label: "repro", description: "Unused.", parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: "" }], details: {} }; } });
	pi.on(${JSON.stringify(event)}, async () => {
		writeFileSync(${JSON.stringify(join(scratch, `entered-${event}`))}, "");
		while (!existsSync(${JSON.stringify(gate(event))})) await new Promise((r) => setTimeout(r, 10));
		return undefined;
	});
}
`);
	return file;
}

export interface Launch { n: number; name: string; modelCalls: number; toolRuns: number; disposed: boolean; session: any }

/**
 * A Team whose launches open real AgentSessions through child.ts. Each launch
 * has its own faux model, so the repro can count the model calls of each
 * session. The model first calls bash, which writes a line to a file, then
 * replies.
 */
export async function liveTeam(options: { slow?: string; bashWaits?: string; holdEvent?: string; bashGate?: (launch: number, call: number) => string | undefined } = {}) {
	const launches: Launch[] = [];
	const reports: Array<{ name: string; state: string }> = [];
	const extensions = [...(options.slow ? [slowExtension(options.slow)] : []), ...(options.holdEvent ? [holdExtension(options.holdEvent)] : [])];
	const modelFor = async (launch: Launch, name: string) => {
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
			return ai.fauxAssistantMessage(`${name} done`);
		}));
		Object.defineProperty(launch, "toolRuns", { get: () => (existsSync(mark) ? readFileSync(mark, "utf8").split("\n").filter(Boolean).length : 0) });
		return runtime;
	};
	// The SDK as child.ts uses it, with a look at each session it makes.
	const watched = { ...sdk, createAgentSession: async (input: any) => {
		const made = await sdk.createAgentSession(input);
		const launch = launches.at(-1)!;
		launch.session = made.session;
		const dispose = made.session.dispose.bind(made.session);
		made.session.dispose = () => { launch.disposed = true; dispose(); };
		return made;
	} };
	const real = createLauncher({
		sdk: watched as never, agentDir, cwd: scratch, sessionDir: null,
		modelRuntime: () => modelFor(launches.at(-1)!, launches.at(-1)!.name),
		toolsFor: () => ({ tools: ["bash", ...[options.slow, options.holdEvent].filter((event) => event !== undefined).map(toolName)], customTools: [], extensionPaths: extensions }),
		instructions: () => "",
	});
	const team = new Team({
		maxConcurrent: 1, maxDepth: 2, replyTimeoutMs: 60_000, idleReleaseMs: 1e9, warn: () => undefined,
		deliverToMain: (delivery: any) => { if (delivery.kind === "report") reports.push({ name: delivery.record.name, state: delivery.record.state }); },
		launcher: {
			launch(record: any, hooks: any) {
				launches.push({ n: launches.length + 1, name: record.name, modelCalls: 0, toolRuns: 0, disposed: false, session: undefined });
				return real.launch(record, hooks);
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
