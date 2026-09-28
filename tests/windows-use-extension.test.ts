import assert from "node:assert/strict";
import test from "node:test";
import type { CodeResult, RunOptions } from "../lib/computer-use/executor.ts";
import { isWsl, registerWindowsUse, windowsUseEnabled, type WindowsUseDeps } from "../lib/windows-use/index.ts";
import { rowKind } from "../lib/tool-row.ts";

test("windows use is off unless opted in, and only under WSL", () => {
	assert.equal(windowsUseEnabled("linux", {}, true), false);
	assert.equal(windowsUseEnabled("linux", { PI_WINDOWS_USE: "off" }, true), false);
	assert.equal(windowsUseEnabled("linux", { PI_WINDOWS_USE: "on" }, false), false);
	assert.equal(windowsUseEnabled("darwin", { PI_WINDOWS_USE: "on" }, true), false);
	for (const value of ["on", "1", "true", "YES"]) assert.equal(windowsUseEnabled("linux", { PI_WINDOWS_USE: value }, true), true);
});

test("WSL is recognized by its environment or kernel", () => {
	assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, () => { throw new Error("unread"); }), true);
	assert.equal(isWsl({}, () => "6.18.33.2-microsoft-standard-WSL2"), true);
	assert.equal(isWsl({}, () => "6.8.0-45-generic"), false);
	assert.equal(isWsl({}, () => { throw new Error("no /proc"); }), false);
});

function harness(run: (options: RunOptions) => Promise<CodeResult>, notes: string[][] = []) {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const handlers = new Map<string, () => unknown>();
	let closed = 0;
	const deps: WindowsUseDeps = {
		executor: { execute: async (_code, options) => run(options) },
		notes: () => notes.shift() ?? [],
		status: async () => ["host: closed", "Win11: running, set up"],
		close: () => { closed++; },
	};
	registerWindowsUse({
		registerTool: (tool: unknown) => tools.push(tool),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (event: string, handler: () => unknown) => handlers.set(event, handler),
	} as never, deps);
	return { tools, commands, handlers, closed: () => closed };
}

const ok = (text: string): CodeResult => ({ content: [{ type: "text", text }], calls: [{ method: "snapshot", app: "Win11", detail: "", ms: 5, ok: true }], durationMs: 9 });

test("registers one windows_use tool with the shared row layout, a status command and shutdown cleanup", async () => {
	const { tools, commands, handlers, closed } = harness(async () => ok("x"));
	assert.deepEqual(tools.map((tool) => tool.name), ["windows_use"]);
	assert.match(tools[0].description, /win\.snapshot/);
	assert.match(tools[0].description, /win\.console\.screenshot/);
	assert.equal(rowKind(tools[0]), "windows-use");
	const notes: string[] = [];
	await commands.get("windows-use").handler("", { ui: { notify: (text: string) => notes.push(text) } });
	assert.deepEqual(notes, ["host: closed\nWin11: running, set up"]);
	await handlers.get("session_shutdown")!();
	assert.equal(closed(), 1);
});

test("recovery notes from the run follow what the script emitted; stale ones are dropped first", async () => {
	const { tools } = harness(async () => ok("tree"), [["stale"], ["Win11: signed in at the console"]]);
	const result = await tools[0].execute("id", { code: "x" }, undefined, undefined, {});
	assert.deepEqual(result.content, [{ type: "text", text: "tree" }, { type: "text", text: "Win11: signed in at the console" }]);
	assert.deepEqual(result.details, { calls: ok("").calls, durationMs: 9 });
});

test("a failed run throws with its output and notes, and approvals are never granted", async () => {
	let answer: string | undefined;
	const { tools } = harness(async (options) => {
		answer = await options.approve({ app: "", message: "", highRisk: false, canRemember: false, signal: new AbortController().signal });
		return { content: [{ type: "text", text: "Windows code stopped: nope" }], calls: [], durationMs: 1, error: "nope" };
	}, [[], ["Win11: installing Windows-MCP"]]);
	await assert.rejects(tools[0].execute("id", { code: "x" }, undefined, undefined, {}), /Windows code stopped: nope\nWin11: installing Windows-MCP/);
	assert.equal(answer, "deny");
});
