import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { CHAIN_ENTRY, CHAIN_EVENT } from "../lib/chain/run.ts";
import { readToolCount, splitCount, TOOL_COUNT_EVENT, writeToolCount } from "../lib/tool-count.ts";
import { applyArgs, countArg, registerToolDisplay, toolDisplayEnabled, TOOL_NAMES, withDisplay, type ToolDisplayDeps } from "../lib/tool-display/index.ts";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type DisplaySettings } from "../lib/tool-display/settings.ts";
import { quiet } from "./support/quiet-theme.ts";

const host = { expandHint: () => "ctrl+o to expand", highlight: (code: string) => code.split("\n"), language: () => undefined, diff: (d: string) => d, fileUrl: () => undefined, now: () => Date.now() };

type Ops = { exec(command: string, cwd: string, options: { onData(data: Buffer): void }): Promise<{ exitCode: number | null }> };

/** The shell behind Pi's bash operations. */
const shell: Ops = {
	exec: (command, cwd, options) => new Promise((resolve) => {
		const child = spawn("/bin/bash", ["-c", command], { cwd });
		child.stdout.on("data", options.onData);
		child.stderr.on("data", options.onData);
		child.on("close", (code) => resolve({ exitCode: code }));
	}),
};

function harness(options: { sources?: Record<string, string>; settings?: DisplaySettings; failWrite?: boolean; entries?: unknown[] } = {}) {
	const registered: any[] = [];
	const notes: Array<[string, string | undefined]> = [];
	const appended: Array<[string, unknown]> = [];
	const emitted: Array<[string, unknown]> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const commands = new Map<string, any>();
	let settings = options.settings ?? DEFAULT_SETTINGS;
	const writes: DisplaySettings[] = [];
	const counts: string[] = [];
	const sources = options.sources ?? Object.fromEntries(TOOL_NAMES.map((name) => [name, "builtin"]));
	const deps: ToolDisplayDeps = {
		tools: (_ctx, wrap) => {
			const ops = wrap(shell as never) as unknown as Ops;
			const definitions = Object.fromEntries(TOOL_NAMES.map((name) => [name, { name, description: `${name} tool`, parameters: {}, promptSnippet: `use ${name}`, execute: async () => ({ content: [] }) }]));
			// Stands in for Pi's bash tool: runs through the operations and throws on a failed command.
			definitions.bash!.execute = (async (_id: string, params: { command: string }) => {
				let out = "";
				const { exitCode } = await ops.exec(params.command, "/", { onData: (data) => { out += data.toString(); } });
				if (exitCode !== 0) throw new Error(`${out}\n\nCommand exited with code ${exitCode}`);
				return { content: [{ type: "text", text: out }] };
			}) as never;
			return { definitions: definitions as never, fullscreen: true };
		},
		settings: {
			read: () => settings,
			write: (next) => {
				if (options.failWrite) throw new Error("read-only");
				writes.push(next);
				settings = next;
			},
		},
		host,
		nonce: () => "0123456789abcdef",
		writeToolCount: (count) => {
			if (options.failWrite) throw new Error("read-only");
			counts.push(count);
		},
	};
	registerToolDisplay({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: unknown) => registered.push(tool),
		getAllTools: () => Object.entries(sources).map(([name, source]) => ({ name, sourceInfo: { source } })),
		appendEntry: (type: string, data: unknown) => appended.push([type, data]),
		events: { emit: (channel: string, data: unknown) => emitted.push([channel, data]), on: () => () => {} },
	} as never, deps);
	const ctx = (mode: string) => ({
		mode,
		ui: { notify: (message: string, level?: string) => notes.push([message, level]), custom: async () => undefined },
		sessionManager: { getEntries: () => options.entries ?? [] },
	});
	return {
		registered, notes, writes, counts, commands, appended, emitted,
		start: (mode = "tui") => handlers.get("session_start")!({ type: "session_start" }, ctx(mode)),
		fire: (event: string) => handlers.get(event)!({ type: event }, ctx("tui")),
		run: (args: string) => commands.get("tool-display").handler(args, ctx("tui")),
		latest: (name: string) => registered.filter((tool) => tool.name === name).at(-1),
	};
}

test("PI_TOOL_DISPLAY turns the extension off", () => {
	assert.equal(toolDisplayEnabled({}), true);
	assert.equal(toolDisplayEnabled({ PI_TOOL_DISPLAY: "on" }), true);
	for (const value of ["off", "0", "false", "NO"]) assert.equal(toolDisplayEnabled({ PI_TOOL_DISPLAY: value }), false);
});

test("the override is the built-in definition with only its presentation replaced", () => {
	const execute = async () => ({ content: [] });
	const definition = { name: "bash", label: "bash", description: "d", parameters: { type: "object" }, promptSnippet: "s", promptGuidelines: ["g"], execute, renderCall: () => undefined };
	const renderCall = () => ({ render: () => [], invalidate() {} });
	const renderResult = () => ({ render: () => [], invalidate() {} });
	const shown = withDisplay(definition as never, { renderCall, renderResult } as never);
	assert.equal(shown.execute, execute);
	assert.deepEqual({ ...shown, renderCall: undefined, renderResult: undefined, renderShell: undefined }, { ...definition, renderCall: undefined, renderResult: undefined, renderShell: undefined });
	assert.equal(shown.renderShell, "self");
	assert.equal(shown.renderCall, renderCall);
	assert.equal(definition.renderCall.name, "renderCall", "the built-in definition is not modified");
});

test("session start replaces built-in tools only, and only in the terminal UI", () => {
	const h = harness({ sources: { read: "builtin", bash: "builtin", edit: "local", grep: "builtin" } });
	h.start("print");
	assert.equal(h.registered.length, 0);
	h.start("tui");
	assert.deepEqual(h.registered.map((tool) => tool.name), ["read", "bash", "grep"]);
	assert.equal(h.registered[0].promptSnippet, "use read");
	assert.equal(h.registered[1].description, "bash tool", "bash keeps its description while its execute gains steps");
	// A later session start (a /new or /resume) replaces its own tools again.
	h.start("tui");
	assert.equal(h.registered.length, 6);
});

test("a chained command runs as written for the model, and its steps are saved between turns", async () => {
	const h = harness();
	h.start();
	const result = await h.latest("bash").execute("call-1", { command: "echo one && echo two" });
	assert.equal(result.content[0].text, "one\ntwo\n");
	assert.deepEqual(h.emitted, [[CHAIN_EVENT, { toolCallId: "call-1", ran: 2 }]]);
	assert.equal(h.appended.length, 0, "nothing is written in the middle of a turn");
	h.fire("turn_end");
	assert.equal(h.appended.length, 1);
	const [type, data] = h.appended[0] as [string, any];
	assert.equal(type, CHAIN_ENTRY);
	assert.equal(data.toolCallId, "call-1");
	assert.deepEqual(data.steps.map((step: any) => step.code), [0, 0]);
	await assert.rejects(h.latest("bash").execute("call-2", { command: "echo a && false && echo b" }), /Command exited with code 1$/);
	h.fire("agent_end");
	assert.equal(h.appended.length, 2);
});

test("a resumed session shows the saved steps of a chained command", () => {
	const saved = { v: 1, toolCallId: "old-1", outcome: "fail", steps: [{ at: 0, ms: 1_200, code: 0, tail: "built\n" }, { at: 1_200, ms: 300, code: 2, tail: "FAIL x\n" }, {}] };
	const h = harness({ entries: [{ type: "custom", customType: CHAIN_ENTRY, data: saved }, { type: "custom", customType: "other", data: {} }] });
	h.start();
	const bash = h.latest("bash");
	const state = {};
	const context = { args: { command: "make && make test && make dist" }, toolCallId: "old-1", state, lastComponent: undefined, cwd: "/", executionStarted: false, argsComplete: false, isPartial: false, expanded: false, isError: true, invalidate() {} };
	const call = bash.renderCall(context.args, quiet(), context);
	bash.renderResult({ content: [{ type: "text", text: "FAIL x\n\nCommand exited with code 2" }] }, { expanded: false, isPartial: false }, quiet(), context);
	const lines = call.render(60).map((line: string) => stripTerminalSequences(line).trimEnd());
	assert.match(lines[0], /exit 2 at 2 of 3$/, "a resumed row has no total time");
	assert.match(lines[1], /^ {4}1 +make +1\.2s$/);
	assert.match(lines[2], /^ {4}2 +make test +exit 2 +300ms$/);
	assert.equal(lines[3], "        FAIL x");
	assert.match(lines[4], /^ {4}3 +make dist +skipped$/);
});

test("/tool-display reports, switches and saves its settings", async () => {
	const h = harness();
	h.start();
	await h.run("");
	assert.match(h.notes.at(-1)![0], /^Tool Display is on · chain steps on · motion full\./);
	await h.run("motion reduced");
	assert.deepEqual(h.writes.at(-1), { enabled: true, chains: true, motion: "reduced" });
	await h.run("chains off");
	assert.deepEqual(h.writes.at(-1), { enabled: true, chains: false, motion: "reduced" });
	await h.run("sideways");
	assert.equal(h.notes.at(-1)![1], "warning");
	assert.equal(h.writes.length, 2);
});

test("/tool-display off gives the tools back to Pi, and on takes them again", async () => {
	const h = harness();
	h.start();
	await h.run("off");
	const plain = h.latest("read");
	assert.equal(plain.renderShell, undefined);
	assert.equal(plain.promptSnippet, "use read");
	await h.run("on");
	assert.equal(h.latest("read").renderShell, "self");
	// Off from the start of a session leaves Pi's tools alone entirely.
	const off = harness({ settings: { ...DEFAULT_SETTINGS, enabled: false } });
	off.start();
	assert.equal(off.registered.length, 0);
});

test("/tool-display says when the setting could not be saved", async () => {
	const h = harness({ failWrite: true });
	h.start();
	await h.run("chains off");
	assert.equal(h.notes.at(-1)![1], "warning");
	assert.match(h.notes.at(-1)![0], /this session only/);
});

test("/tool-display count switches the Status Plus tool count and tells it", async () => {
	const h = harness();
	h.start();
	await h.run("count steps");
	assert.deepEqual(h.counts, ["steps"]);
	assert.deepEqual(h.emitted.at(-1), [TOOL_COUNT_EVENT, "steps"]);
	assert.match(h.notes.at(-1)![0], /each step a chained command ran/);
	await h.run("COUNT calls");
	assert.deepEqual(h.emitted.at(-1), [TOOL_COUNT_EVENT, "calls"]);
	// It is not a Tool Display setting.
	assert.equal(h.writes.length, 0);
	await h.run("count all");
	assert.equal(h.notes.at(-1)![1], "warning");
	const failing = harness({ failWrite: true });
	failing.start();
	await failing.run("count steps");
	assert.match(failing.notes.at(-1)![0], /this session only/);
	assert.deepEqual(failing.emitted.at(-1), [TOOL_COUNT_EVENT, "steps"]);
	assert.equal(countArg("count"), undefined);
});

test("the tool count persists under statusPlus, and a split count adds the steps each chain ran", () => {
	const dir = mkdtempSync(join(tmpdir(), "tool-count-"));
	try {
		const file = join(dir, "pi-extras.json");
		assert.equal(readToolCount(file), "calls");
		writeFileSync(file, JSON.stringify({ toolDisplay: { chains: false } }));
		writeToolCount("steps", file);
		assert.equal(readToolCount(file), "steps");
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).toolDisplay, { chains: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	// Three steps add two; a chain that ran none is still the one call it was.
	assert.equal(splitCount(5, new Map([["a", 3], ["b", 1], ["c", 0]])), 7);
});

test("/tool-display arguments", () => {
	assert.deepEqual(applyArgs(DEFAULT_SETTINGS, " Off "), { ...DEFAULT_SETTINGS, enabled: false });
	assert.deepEqual(applyArgs(DEFAULT_SETTINGS, "chains off"), { ...DEFAULT_SETTINGS, chains: false });
	assert.equal(applyArgs(DEFAULT_SETTINGS, "motion"), undefined);
	assert.equal(applyArgs(DEFAULT_SETTINGS, "compact"), undefined);
});

test("the settings persist under toolDisplay in pi-extras.json and keep other settings", () => {
	const dir = mkdtempSync(join(tmpdir(), "tool-display-"));
	try {
		const file = join(dir, "pi-extras.json");
		assert.deepEqual(readSettings(file), DEFAULT_SETTINGS, "a missing file reads as the defaults");
		writeFileSync(file, JSON.stringify({ computerUse: { apps: "all" }, toolDisplay: { density: "compact" } }));
		assert.deepEqual(readSettings(file), DEFAULT_SETTINGS, "the 0.5 density setting is ignored");
		writeSettings({ enabled: true, chains: false, motion: "reduced" }, file);
		assert.deepEqual(readSettings(file), { enabled: true, chains: false, motion: "reduced" });
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(saved.computerUse, { apps: "all" });
		writeFileSync(file, "{ not json");
		assert.deepEqual(readSettings(file), DEFAULT_SETTINGS);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
