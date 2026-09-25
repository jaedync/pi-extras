import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerToolDisplay, toolDisplayEnabled, TOOL_NAMES, withDisplay, type ToolDisplayDeps } from "../lib/tool-display/index.ts";
import { readDensity, writeDensity } from "../lib/tool-display/settings.ts";
import type { Density } from "../lib/tool-display/slot.ts";

const kit = { hint: () => "", highlight: (code: string) => code.split("\n"), language: () => undefined, diff: (d: string) => d, link: (s: string) => s, now: () => 0 };

function harness(options: { sources?: Record<string, string>; density?: Density; failWrite?: boolean } = {}) {
	const registered: any[] = [];
	const notes: Array<[string, string | undefined]> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const commands = new Map<string, any>();
	let density: Density = options.density ?? "boxed";
	const writes: Density[] = [];
	const sources = options.sources ?? Object.fromEntries(TOOL_NAMES.map((name) => [name, "builtin"]));
	const definitions = Object.fromEntries(TOOL_NAMES.map((name) => [name, { name, description: `${name} tool`, parameters: {}, promptSnippet: `use ${name}`, execute: async () => ({ content: [] }) }]));
	const deps: ToolDisplayDeps = {
		definitions: () => definitions as never,
		density: {
			read: () => density,
			write: (next) => {
				if (options.failWrite) throw new Error("read-only");
				writes.push(next);
				density = next;
			},
		},
		kit,
	};
	registerToolDisplay({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: unknown) => registered.push(tool),
		getAllTools: () => Object.entries(sources).map(([name, source]) => ({ name, sourceInfo: { source } })),
	} as never, deps);
	const ctx = (mode: string) => ({ mode, ui: { notify: (message: string, level?: string) => notes.push([message, level]) } });
	return {
		registered, notes, writes, commands,
		start: (mode = "tui") => handlers.get("session_start")!({ type: "session_start" }, ctx(mode)),
		run: (args: string) => commands.get("tool-display").handler(args, ctx("tui")),
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
	// A later session start (a /new or /resume) replaces its own tools again.
	h.start("tui");
	assert.equal(h.registered.length, 6);
});

test("/tool-display toggles, sets and saves the density", async () => {
	const h = harness();
	h.start();
	await h.run("");
	assert.deepEqual(h.writes, ["compact"]);
	assert.match(h.notes.at(-1)![0], /Tool rows are compact\. \/tool-display boxed switches back\./);
	await h.run("compact");
	await h.run(" BOXED ");
	assert.deepEqual(h.writes, ["compact", "compact", "boxed"]);
	await h.run("tiny");
	assert.deepEqual(h.notes.at(-1), ['Unknown option "tiny". Use /tool-display, /tool-display boxed or /tool-display compact.', "warning"]);
	assert.equal(h.writes.length, 3);
	assert.deepEqual(h.commands.get("tool-display").getArgumentCompletions("c").map((item: { value: string }) => item.value), ["compact"]);
	assert.equal(h.commands.get("tool-display").getArgumentCompletions("x"), null);
});

test("/tool-display says when the setting could not be saved", async () => {
	const h = harness({ failWrite: true });
	h.start();
	await h.run("compact");
	assert.equal(h.notes.at(-1)![1], "warning");
	assert.match(h.notes.at(-1)![0], /applies to this session only/);
});

test("the density persists under toolDisplay in pi-extras.json and keeps other settings", () => {
	const dir = mkdtempSync(join(tmpdir(), "tool-display-settings-"));
	try {
		const file = join(dir, "pi-extras.json");
		assert.equal(readDensity(file), "boxed");
		writeFileSync(file, JSON.stringify({ usageGuard: { enabled: true }, toolDisplay: { density: "huge" } }));
		assert.equal(readDensity(file), "boxed");
		writeDensity("compact", file);
		assert.equal(readDensity(file), "compact");
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { usageGuard: { enabled: true }, toolDisplay: { density: "compact" } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
