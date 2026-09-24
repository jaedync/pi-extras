import assert from "node:assert/strict";
import test from "node:test";
import type { ListedApp, ApprovalState } from "../lib/computer-use/approvals.ts";
import type { CodeResult, RunOptions } from "../lib/computer-use/executor.ts";
import { computerUseEnabled, registerComputerUse, type ComputerUseDeps } from "../lib/computer-use/index.ts";
import type { ApprovalRequest } from "../lib/computer-use/session.ts";

test("computer use is off unless opted in, and only on macOS", () => {
	assert.equal(computerUseEnabled("darwin", {}), false);
	assert.equal(computerUseEnabled("darwin", { PI_COMPUTER_USE: "off" }), false);
	assert.equal(computerUseEnabled("linux", { PI_COMPUTER_USE: "on" }), false);
	for (const value of ["on", "1", "true", "YES"]) assert.equal(computerUseEnabled("darwin", { PI_COMPUTER_USE: value }), true);
});

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	app: "Safari", message: "Allow ChatGPT to use Safari?", highRisk: true, canRemember: true,
	warning: "Allowing the agent to use this app introduces new risks.", signal: new AbortController().signal, ...overrides,
});

function harness(options: { run?: (options: RunOptions) => Promise<CodeResult>; state?: ApprovalState; apps?: ListedApp[] } = {}) {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const handlers = new Map<string, () => unknown>();
	const writes: string[] = [];
	let closed = 0;
	let state: ApprovalState = options.state ?? { writable: true, ids: ["com.apple.finder"] };
	const deps: ComputerUseDeps = {
		executor: { execute: async (_code, runOptions) => (options.run ?? (async (o) => ({ content: [{ type: "text", text: `answer ${await o.approve(request())}` }], calls: [], durationMs: 1 })))(runOptions) },
		close: async () => { closed++; },
		status: () => ["Computer Use client: signed by OpenAI"],
		approvals: {
			read: () => state,
			allow: (id) => { writes.push(`allow ${id}`); state = { writable: true, ids: [...state.ids, id] }; },
			revoke: (id) => { writes.push(`revoke ${id}`); state = { writable: true, ids: state.ids.filter((x) => x !== id) }; },
		},
		appName: (id) => ({ "com.apple.finder": "Finder", "com.apple.Safari": "Safari" } as Record<string, string>)[id] ?? id,
		listApps: async () => options.apps ?? [
			{ name: "Finder", path: "/System/Library/CoreServices/Finder.app/", bundleId: "com.apple.finder", running: true },
			{ name: "Notes", path: "/System/Applications/Notes.app/", bundleId: "com.apple.Notes", running: true },
		],
	};
	registerComputerUse({
		registerTool: (tool: unknown) => tools.push(tool),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (event: string, handler: () => unknown) => handlers.set(event, handler),
	} as never, deps);
	return { tools, commands, handlers, writes, closed: () => closed };
}

function scriptedUi(answers: Array<string | boolean | undefined>) {
	const shown: Array<{ kind: string; title: string; options?: string[]; message?: string; signal?: AbortSignal }> = [];
	const notes: string[] = [];
	return {
		shown, notes,
		ui: {
			select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => { shown.push({ kind: "select", title, options, signal: opts?.signal }); return answers.shift() as string | undefined; },
			confirm: async (title: string, message: string) => { shown.push({ kind: "confirm", title, message }); return answers.shift() === true; },
			notify: (message: string) => notes.push(message),
		},
	};
}

test("registers one computer_use tool with its own rendering, a menu command, and shutdown cleanup", async () => {
	const { tools, commands, handlers, closed } = harness();
	assert.deepEqual(tools.map((tool) => tool.name), ["computer_use"]);
	assert.match(tools[0].description, /sky\.get_app_state/);
	assert.equal(typeof tools[0].renderCall, "function");
	assert.equal(typeof tools[0].renderResult, "function");
	assert.ok(commands.has("computer-use"));
	await handlers.get("session_shutdown")!();
	assert.equal(closed(), 1);
});

test("the approval dialog defaults to not allowing, shows the risk, and closes with the call", async () => {
	const { tools } = harness();
	const { ui, shown } = scriptedUi(["Always allow"]);
	const result = await tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: true, ui });
	assert.deepEqual(result.content, [{ type: "text", text: "answer always" }]);
	const dialog = shown[0];
	assert.deepEqual(dialog.options, ["Don't allow", "Allow for this session", "Always allow"]);
	assert.match(dialog.title, /^Allow the agent to use Safari\?/);
	assert.match(dialog.title, /High risk: Allowing the agent to use this app introduces new risks\./);
	assert.match(dialog.title, /Always allow also applies to ChatGPT and Codex/);
	assert.ok(dialog.signal, "the dialog must close when the call is cancelled");
});

test("dismissing the dialog, or an answer that cannot be remembered, never becomes always", async () => {
	for (const [answer, expected] of [[undefined, "deny"], ["Don't allow", "deny"], ["Allow for this session", "once"]] as const) {
		const { tools } = harness();
		const { ui } = scriptedUi([answer]);
		const result = await tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: true, ui });
		assert.equal(result.content[0].text, `answer ${expected}`);
	}
	const { tools } = harness({ run: async (o) => ({ content: [{ type: "text", text: `answer ${await o.approve(request({ canRemember: false, warning: undefined, highRisk: false }))}` }], calls: [], durationMs: 1 }) });
	const { ui, shown } = scriptedUi(["Allow for this session"]);
	await tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: true, ui });
	assert.deepEqual(shown[0].options, ["Don't allow", "Allow for this session"]);
});

test("without a UI every app is denied, and the result says how to allow it", async () => {
	const { tools } = harness();
	const result = await tools[0].execute("id", { code: "x" }, undefined, undefined, { hasUI: false });
	assert.equal(result.content[0].text, "answer deny");
	assert.match(result.content[1].text, /Safari is not allowed for computer use, and this Pi session has no UI to ask in\. Allow it with \/computer-use/);
});

test("progress streams to the tool row, and a failed run is a tool error", async () => {
	const updates: unknown[] = [];
	const call = { method: "click", app: "X", detail: "#1", ms: 5, ok: false, error: "boom" };
	const { tools } = harness({ run: async (o) => {
		o.onProgress?.({ calls: [], running: { method: "click", app: "X", detail: "#1" } });
		return { content: [{ type: "text", text: "Computer Use code stopped: boom" }], calls: [call], durationMs: 5, error: "boom" };
	} });
	await assert.rejects(tools[0].execute("id", { code: "x" }, undefined, (update: unknown) => updates.push(update), { hasUI: false }), /boom/);
	assert.deepEqual(updates, [{ content: [], details: { calls: [], running: { method: "click", app: "X", detail: "#1" } } }]);
});

test("the menu revokes an always-allowed app after confirmation", async () => {
	const { commands, writes } = harness();
	const { ui, shown, notes } = scriptedUi(["Stop always allowing an app…", "Finder (com.apple.finder)", true]);
	await commands.get("computer-use").handler("", { hasUI: true, ui });
	assert.match(shown[0].title, /Always allowed: Finder/);
	assert.deepEqual(shown[0].options, ["Always allow an app…", "Stop always allowing an app…"]);
	assert.match(shown[2].message ?? "", /ask again/);
	assert.deepEqual(writes, ["revoke com.apple.finder"]);
	assert.match(notes[0], /Finder/);
});

test("the menu always-allows an app it lists, skipping ones already allowed, and warns first", async () => {
	const { commands, writes } = harness();
	const { ui, shown } = scriptedUi(["Always allow an app…", "Notes (com.apple.Notes)", true]);
	await commands.get("computer-use").handler("", { hasUI: true, ui });
	assert.deepEqual(shown[1].options, ["Notes (com.apple.Notes)"]);
	assert.match(shown[2].message ?? "", /without asking/);
	assert.match(shown[2].message ?? "", /prompt injection/);
	assert.deepEqual(writes, ["allow com.apple.Notes"]);
});

test("declining the confirmation changes nothing", async () => {
	const { commands, writes } = harness();
	const { ui } = scriptedUi(["Always allow an app…", "Notes (com.apple.Notes)", false]);
	await commands.get("computer-use").handler("", { hasUI: true, ui });
	assert.deepEqual(writes, []);
});

test("an approvals file in an unknown format is shown but cannot be changed", async () => {
	const { commands, writes } = harness({ state: { writable: false, ids: ["com.apple.finder"], problem: "manage apps in the ChatGPT app instead" } });
	const { ui, shown, notes } = scriptedUi([]);
	await commands.get("computer-use").handler("", { hasUI: true, ui });
	assert.equal(shown.length, 0);
	assert.match(notes[0], /Always allowed: Finder/);
	assert.match(notes[0], /manage apps in the ChatGPT app instead/);
	assert.deepEqual(writes, []);
});
