/** Offline real Pi pipeline, native codemode sandbox and exclusive nested-call queue. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatTime } from "../lib/band/band.ts";
import { agentRoot } from "./support/pi-runtime.mjs";

const scratch = mkdtempSync(join(tmpdir(), "codemode-sdk-"));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TOOL_DISPLAY = "on";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const sdk = await import(pathToFileURL(join(agentRoot, "dist/bundle/index.js")).href) as any;
const require = createRequire(join(agentRoot, "package.json"));
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as any;
const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href) as any;
const { Type } = await import(pathToFileURL(require.resolve("typebox")).href) as any;
sdk.initTheme("dark");
const modern = typeof sdk.createCodemodeExtension === "function";
const SCRIPT = "return await Promise.all([tools.fixture_write({cell: 1}), tools.fixture_write({cell: 2})]);";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const plain = (row: any): string[] => row.render(140).map((line: string) => tui.stripTerminalSequences(line).trimEnd());
const expansion = new WeakMap<object, boolean>();
const owners = new WeakMap<object, object>();
const unfolded = (row: any): string[] => {
 const session = owners.get(row);
 assert.ok(session, "fixture row belongs to a session");
 expansion.set(session, true);
 row.setExpanded(true);
 return plain(row);
};
const resultOf = (session: any) => session.sessionManager.getBranch().findLast((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "codemode")?.message;

function rowFor(session: any, id: string, args: object) {
	const row = new sdk.ToolExecutionComponent("codemode", id, args, {}, session.getToolDefinition("codemode"), { requestRender() {} }, scratch);
	row.setArgsComplete();
	owners.set(row, session);
	return row;
}

function probe(output?: string) {
	let active = 0;
	let peak = 0;
	let starts = 0;
	let bothStarted!: () => void;
	const requested = new Promise<void>((resolve) => { bothStarted = resolve; });
	const executions: Array<{ cell: number; start: number; end: number }> = [];
	const events: any[] = [];
	const hookCalls: string[] = [];
	const hookResults: string[] = [];
	let row: any;
	const snapshots: string[][] = [];
	return {
		events, executions, hookCalls, hookResults, snapshots,
		peak: () => peak,
		setRow: (value: any) => { row = value; },
		observe(event: any) {
			events.push({ ...event, observedAt: Date.now() });
			if (event.parentToolCallId && event.type === "tool_execution_start" && ++starts === 2) bothStarted();
		},
		async execute(cell: number) {
			active++;
			peak = Math.max(peak, active);
			const execution = { cell, start: Date.now(), end: 0 };
			try {
				if (cell === 1) { await requested; snapshots.push(plain(row)); }
				await pause(cell === 1 ? 110 : 20);
				return { content: [{ type: "text", text: output ?? `cell ${cell} written` }], details: { cell } };
			} finally { execution.end = Date.now(); executions.push(execution); active--; }
		},
	};
}

async function setup(options: { legacy?: boolean; manager?: any; measurements?: ReturnType<typeof probe> } = {}) {
	const agentDir = mkdtempSync(join(scratch, "case-"));
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
	const faux = ai.fauxProvider({ provider: "codemode-fixture", models: [{ id: "offline" }] });
	runtime.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ["codemode", "fixture_write"], compaction: { enabled: false }, retry: { enabled: false } });
	const factories: any[] = [];
	if (!options.legacy) factories.push(sdk.createCodemodeExtension({ models: false }));
	factories.push({ name: "codemode-test-tools", factory: (pi: any) => {
		if (options.legacy) pi.registerTool({ name: "codemode", label: "Foreign JavaScript", description: "Synthetic foreign script executor", parameters: Type.Object({ code: Type.String() }),
			renderCall: () => new tui.Text("native foreign codemode", 0, 0),
			renderResult: () => new tui.Text("foreign result vocabulary", 0, 0),
			execute: async () => ({ content: [{ type: "text", text: "foreign result vocabulary" }], details: undefined }) });
		else pi.registerTool({ name: "fixture_write", label: "Fixture Write", description: "Offline exclusive write fixture, no filesystem or network", parameters: Type.Object({ cell: Type.Integer(), padding: Type.Optional(Type.String()) }),
			executionMode: "sequential", execute: async (_id: string, args: { cell: number }) => options.measurements!.execute(args.cell) });
		pi.on("tool_call", (event: any) => { if (event.parentToolCallId) options.measurements?.hookCalls.push(event.toolCallId); });
		pi.on("tool_result", (event: any) => { if (event.parentToolCallId) options.measurements?.hookResults.push(event.toolCallId); });
	} });
	const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: factories, additionalExtensionPaths: [fileURLToPath(new URL("../extensions/tool-display.ts", import.meta.url))] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = options.manager ?? sdk.SessionManager.create(scratch, join(agentDir, "sessions"));
	const { session } = await sdk.createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model: faux.getModel("offline"), settingsManager, resourceLoader: loader, sessionManager: manager });
	const errors: unknown[] = [];
	const ui = { notify() {}, setWidget() {}, getToolsExpanded: () => expansion.get(session) ?? false, custom: async () => undefined };
	await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error: unknown) => errors.push(error) });
	assert.deepEqual(errors, []);
	session.subscribe((event: any) => options.measurements?.observe(event));
	return { session, faux, errors, async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } };
}

function elapsedMs(line: string): number {
	const match = /\bdone\s+(\d+(?:\.\d+)?)(ms|s)$/.exec(line);
	assert.ok(match, `missing call elapsed: ${line}`);
	return Number(match[1]) * (match[2] === "s" ? 1_000 : 1);
}

function assertExclusiveRun(f: any, measurements: ReturnType<typeof probe>, live: any): any {
	assert.deepEqual(f.errors, []);
	assert.equal(measurements.peak(), 1, "actual exclusive executions never overlap");
	assert.deepEqual(measurements.executions.map((execution) => execution.cell), [1, 2]);
	assert.ok(measurements.executions[1]!.start >= measurements.executions[0]!.end);
	assert.equal(measurements.hookCalls.length, 2, "real nested calls cross extension validation/permission hooks");
	assert.equal(measurements.hookResults.length, 2, "real nested results cross extension result hooks");
	assert.ok(measurements.snapshots.some((lines) => lines.filter((line) => /ƒ[12].*overlap.*running/.test(line)).length === 2));
	assert.match(plain(live).join("\n"), /Called 1 codemode/, "finished root call folds by default");
	const lines = unfolded(live);
	assert.match(lines.join("\n"), /ƒ1.*fixture_write.*overlap.*done/);
	assert.match(lines.join("\n"), /ƒ2.*fixture_write.*overlap.*done/);
	assert.doesNotMatch(lines.join("\n"), /parallel/i);
	const saved = resultOf(f.session);
	assert.equal(saved.isError, false, JSON.stringify(saved.content));
	assert.equal(saved.nestedCalls.complete, true);
	assert.equal(saved.nestedCalls.calls.length, 2);
	const call = saved.nestedCalls.calls[1];
	const actual = measurements.executions[1]!;
	assert.ok(call.durationMs > actual.end - actual.start + 70, "saved duration includes the exclusive queue wait");
	const displayed = elapsedMs(lines.find((line) => /ƒ2/.test(line))!);
	assert.ok(displayed > actual.end - actual.start + 70, "display time is call lifetime, not execution duration");
	assert.ok(Math.abs(displayed - call.durationMs) < 60, "live display and durable record share call-lifetime semantics");
	return saved;
}

test("native codemode executes exclusive requests serially while cells truthfully show overlapping call lifetimes, then restores persisted nestedCalls", { skip: !modern, timeout: 20_000 }, async () => {
	const measurements = probe();
	const f = await setup({ measurements });
	let saved: any;
	let file: string;
	try {
		f.faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: SCRIPT })), ai.fauxAssistantMessage("Wrote both fixture cells.")]);
		let live: any;
		f.session.subscribe((event: any) => {
			if (event.type === "tool_execution_start" && event.toolName === "codemode" && !event.parentToolCallId) {
				live = rowFor(f.session, event.toolCallId, event.args);
				live.markExecutionStarted();
				measurements.setRow(live);
			}
			if (event.type === "tool_execution_end" && event.toolName === "codemode" && !event.parentToolCallId) live.updateResult({ ...event.result, isError: event.isError }, false);
		});
		await f.session.prompt("Write both synthetic cells through codemode.");
		saved = assertExclusiveRun(f, measurements, live);
		file = f.session.sessionFile;
		assert.ok(file.startsWith(scratch));
	} finally { await f.close(); }
	const restored = await setup({ manager: sdk.SessionManager.open(file!) });
	try {
		const persisted = resultOf(restored.session);
		assert.deepEqual(persisted.nestedCalls, saved.nestedCalls, "real session storage restores the canonical bounded nestedCalls record");
		const row = rowFor(restored.session, persisted.toolCallId, { code: SCRIPT });
		row.updateResult({ content: persisted.content, details: persisted.details, isError: persisted.isError }, false);
		const lines = unfolded(row);
		assert.match(lines.join("\n"), /ƒ1.*fixture_write.*done/);
		assert.match(lines.join("\n"), /ƒ2.*fixture_write.*done/);
		assert.ok(lines.find((line) => /ƒ2/.test(line))!.endsWith(formatTime(persisted.nestedCalls.calls[1].durationMs)));
		assert.doesNotMatch(lines.join("\n"), /parallel|overlap|running/);
		assert.doesNotMatch(lines[0]!, /\d+(?:\.\d+)?(?:ms|s)$/, "restoration does not guess a root start/finish time");
		assert.deepEqual(restored.errors, []);
		assert.equal(restored.faux.state.callCount, 0, "restoration performs no provider request");
	} finally { await restored.close(); }
});

test("native codemode huge nested results truncate UI previews without marking durable or live call history incomplete", { skip: !modern, timeout: 20_000 }, async () => {
	const measurements = probe("x".repeat(20_000));
	const f = await setup({ measurements });
	try {
		let live: any;
		f.session.subscribe((event: any) => {
			if (event.type === "tool_execution_start" && event.toolName === "codemode" && !event.parentToolCallId) {
				live = rowFor(f.session, event.toolCallId, event.args);
				live.markExecutionStarted(); measurements.setRow(live);
			}
			if (event.type === "tool_execution_end" && event.toolName === "codemode" && !event.parentToolCallId) live.updateResult({ ...event.result, isError: event.isError }, false);
		});
		f.faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: SCRIPT })), ai.fauxAssistantMessage("Read both synthetic results.")]);
		await f.session.prompt("Run the synthetic large-result fixture.");
		const saved = resultOf(f.session);
		assert.equal(saved.isError, false);
		assert.equal(saved.nestedCalls.complete, true);
		assert.equal(saved.nestedCalls.calls.length, 2);
		assert.ok(saved.nestedCalls.calls.every((call: any) => call.status === "ok"));
		assert.match(unfolded(live).join("\n"), /ƒ2.*fixture_write.*done/);
		assert.doesNotMatch(plain(live).join("\n"), /nested call record incomplete/);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("native oversized nested arguments reconcile durable incomplete history into the live row through message_end", { skip: !modern, timeout: 20_000 }, async () => {
	const measurements = probe();
	const f = await setup({ measurements });
	try {
		let live: any;
		let durableMessageSeen = false;
		f.session.subscribe((event: any) => {
			if (event.type === "tool_execution_start" && event.toolName === "codemode" && !event.parentToolCallId) {
				live = rowFor(f.session, event.toolCallId, event.args);
				live.markExecutionStarted(); measurements.setRow(live);
			}
			if (event.type === "tool_execution_end" && event.toolName === "codemode" && !event.parentToolCallId) live.updateResult({ ...event.result, isError: event.isError }, false);
			if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "codemode") durableMessageSeen = true;
		});
		const code = `return await Promise.all([tools.fixture_write(${JSON.stringify({ cell: 1, padding: "x".repeat(9_000) })}), tools.fixture_write({cell: 2})]);`;
		f.faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code })), ai.fauxAssistantMessage("Completed the synthetic argument-cap fixture.")]);
		await f.session.prompt("Run the synthetic oversized-argument fixture.");
		const saved = resultOf(f.session);
		assert.equal(saved.isError, false);
		assert.equal(saved.nestedCalls.complete, false, "Pi omits durable arguments above 8 KiB");
		assert.ok(saved.nestedCalls.calls.every((call: any) => call.status === "ok"));
		assert.equal(durableMessageSeen, true);
		assert.match(unfolded(live).join("\n"), /nested call record incomplete/);
		assert.match(plain(live).join("\n"), /ƒ2.*fixture_write.*done/);
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test("legacy foreign codemode keeps its result vocabulary and original execute without inventing nested calls", { timeout: 10_000 }, async () => {
	const f = await setup({ legacy: true });
	try {
		const definition = f.session.getToolDefinition("codemode");
		const execute = definition.execute;
		let row: any;
		f.session.subscribe((event: any) => {
			if (event.type === "tool_execution_start" && event.toolName === "codemode") { row = rowFor(f.session, event.toolCallId, event.args); row.markExecutionStarted(); }
			if (event.type === "tool_execution_end" && event.toolName === "codemode") row.updateResult({ ...event.result, isError: event.isError }, false);
		});
		f.faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: "return 'legacy';" })), ai.fauxAssistantMessage("Finished legacy execution.")]);
		await f.session.prompt("Run the foreign script.");
		const lines = unfolded(row).join("\n");
		assert.match(lines, /codemode · JavaScript/);
		assert.match(lines, /foreign result vocabulary/);
		assert.doesNotMatch(lines, /ƒ\d|overlap|parallel/);
		assert.equal(f.session.getToolDefinition("codemode").execute, execute);
		assert.equal(resultOf(f.session).nestedCalls, undefined);
		for (const command of ["/tool-display others off", "/tool-display off"]) {
			await f.session.prompt(command);
			const untouched = rowFor(f.session, `plain-${command}`, { code: "return 'legacy';" });
			assert.equal(untouched.getCallRenderer(), definition.renderCall);
			assert.match(plain(untouched).join("\n"), /native foreign codemode/);
			assert.equal(f.session.getToolDefinition("codemode").execute, execute);
		}
		assert.equal(f.faux.state.callCount, 2, "display commands do not invoke the provider");
		assert.deepEqual(f.errors, []);
	} finally { await f.close(); }
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
