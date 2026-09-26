import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalState, ListedApp } from "../lib/computer-use/approvals.ts";
import type { CodeResult, RunOptions } from "../lib/computer-use/executor.ts";
import { computerUseEnabled, registerComputerUse, type ComputerUseDeps } from "../lib/computer-use/index.ts";
import type { ApprovalRequest } from "../lib/computer-use/session.ts";
import type { AppsMode } from "../lib/computer-use/settings.ts";
import { rowKind } from "../lib/tool-row.ts";

const KEY = { down: "\x1b[B", right: "\x1b[C", enter: "\r", esc: "\x1b", space: " " };
const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
const settle = () => new Promise((resolve) => setImmediate(resolve));

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

const asks = (overrides: Partial<ApprovalRequest> = {}) => async (o: RunOptions): Promise<CodeResult> =>
	({ content: [{ type: "text", text: `answer ${await o.approve(request(overrides))}` }], calls: [], durationMs: 1 });

function harness(options: { run?: (options: RunOptions) => Promise<CodeResult>; state?: ApprovalState; apps?: ListedApp[]; mode?: AppsMode } = {}) {
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const handlers = new Map<string, () => unknown>();
	const writes: string[] = [];
	let runs = 0;
	let closed = 0;
	let state: ApprovalState = options.state ?? { writable: true, ids: ["com.apple.finder"] };
	let mode: AppsMode = options.mode ?? "ask";
	const deps: ComputerUseDeps = {
		executor: { execute: async (_code, runOptions) => { runs++; return (options.run ?? asks())(runOptions); } },
		close: async () => { closed++; },
		restart: async () => { writes.push("restart"); },
		status: () => [{ level: "ok", text: "Signed OpenAI client" }],
		mode: { read: () => mode, write: (next) => { writes.push(`mode ${next}`); mode = next; } },
		approvals: {
			read: () => state,
			allow: (id) => { writes.push(`allow ${id}`); state = { writable: true, ids: [...state.ids, id] }; },
			revoke: (id) => { writes.push(`revoke ${id}`); state = { writable: true, ids: state.ids.filter((x) => x !== id) }; },
		},
		appName: (id) => ({ "com.apple.finder": "Finder", "com.apple.Safari": "Safari", "com.apple.Notes": "Notes" } as Record<string, string>)[id] ?? id,
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
	return { tools, commands, handlers, writes, runs: () => runs, closed: () => closed, setMode: (next: AppsMode) => { mode = next; } };
}

/** A UI that draws custom components and presses `keys` in them; `custom: false` behaves like RPC mode. */
function fakeUi(options: { keys?: string[]; answers?: Array<string | boolean | undefined>; custom?: boolean } = {}) {
	const screens: string[] = [];
	const selects: Array<{ title: string; options: string[]; signal?: AbortSignal }> = [];
	const notes: string[] = [];
	const answers = [...(options.answers ?? [])];
	return {
		screens, selects, notes,
		ui: {
			custom: async (factory: any) => {
				if (options.custom === false) return undefined;
				return new Promise((resolve) => {
					const component = factory({ requestRender() {} }, theme, undefined, resolve);
					void settle().then(() => {
						screens.push(component.render(100).join("\n"));
						for (const key of options.keys ?? []) component.handleInput(key);
						screens.push(component.render(100).join("\n"));
					});
				});
			},
			select: async (title: string, choices: string[], opts?: { signal?: AbortSignal }) => { selects.push({ title, options: choices, signal: opts?.signal }); return answers.shift() as string | undefined; },
			confirm: async () => answers.shift() === true,
			notify: (message: string) => notes.push(message),
		},
	};
}

const run = (tools: any[], ui: unknown, hasUI = true, onUpdate?: (update: unknown) => void) => tools[0].execute("id", { code: "x" }, undefined, onUpdate, { hasUI, ui });

test("registers one computer_use tool with its own rendering, a menu command, and shutdown cleanup", async () => {
	const { tools, commands, handlers, closed } = harness();
	assert.deepEqual(tools.map((tool) => tool.name), ["computer_use"]);
	assert.match(tools[0].description, /sky\.get_app_state/);
	assert.equal(typeof tools[0].renderCall, "function");
	assert.equal(typeof tools[0].renderResult, "function");
	assert.equal(rowKind(tools[0]), "computer-use", "Tool Display draws its rows with a layout of its own");
	assert.ok(commands.has("computer-use"));
	await handlers.get("session_shutdown")!();
	assert.equal(closed(), 1);
});

test("the approval prompt shows the app and risk, and its answer is used", async () => {
	const { tools } = harness();
	const { ui, screens } = fakeUi({ keys: [KEY.down, KEY.down, KEY.enter] });
	const result = await run(tools, ui);
	assert.deepEqual(result.content, [{ type: "text", text: "answer always" }]);
	assert.match(screens[0], /Allow the agent to use Safari\?/);
	assert.match(screens[0], /High risk\s+Allowing the agent/);
	assert.match(screens[0], /→ Don't allow/);
});

test("a call cancelled before the prompt appears is refused at once", async () => {
	const controller = new AbortController();
	controller.abort();
	const { tools } = harness({ run: asks({ signal: controller.signal }) });
	const { ui, screens } = fakeUi({ keys: [] });
	assert.equal((await run(tools, ui)).content[0].text, "answer deny");
	assert.equal(screens.length, 0);
});

test("cancelling the call closes the prompt with a refusal", async () => {
	const controller = new AbortController();
	const { tools } = harness({ run: asks({ signal: controller.signal }) });
	const { ui } = fakeUi({ keys: [] });
	const pending = run(tools, ui);
	await settle();
	controller.abort();
	assert.equal((await pending).content[0].text, "answer deny");
});

test("without custom components (RPC mode) the prompt falls back to a select dialog", async () => {
	for (const [answer, expected] of [[undefined, "deny"], ["Don't allow", "deny"], ["Allow for this session", "once"], ["Always allow", "always"]] as const) {
		const { tools } = harness();
		const { ui, selects } = fakeUi({ custom: false, answers: [answer] });
		assert.equal((await run(tools, ui)).content[0].text, `answer ${expected}`);
		assert.deepEqual(selects[0].options, ["Don't allow", "Allow for this session", "Always allow"]);
		assert.match(selects[0].title, /High risk: Allowing the agent/);
		assert.ok(selects[0].signal, "the dialog must close when the call is cancelled");
	}
	const { tools } = harness({ run: asks({ canRemember: false }) });
	const { ui, selects } = fakeUi({ custom: false, answers: ["Allow for this session"] });
	await run(tools, ui);
	assert.deepEqual(selects[0].options, ["Don't allow", "Allow for this session"]);
});

test("without a UI every app is denied, and the result says how to allow it", async () => {
	const { tools } = harness();
	const result = await run(tools, undefined, false);
	assert.equal(result.content[0].text, "answer deny");
	assert.match(result.content[1].text, /Safari is not allowed for computer use, and this Pi session has no UI to ask in\. Allow it, or turn on Allow all, with \/computer-use/);
});

test("Allow all answers for the user without a UI; Allow none refuses before anything runs", async () => {
	const all = harness({ mode: "all" });
	assert.equal((await run(all.tools, undefined, false)).content[0].text, "answer auto");
	const none = harness({ mode: "none" });
	await assert.rejects(run(none.tools, undefined, false), /Allow none/);
	assert.equal(none.runs(), 0);
});

test("leaving Allow all in another session restarts this session's client before its next call", async () => {
	const { tools, writes, setMode } = harness({ mode: "all" });
	await run(tools, undefined, false);
	await run(tools, undefined, false);
	assert.deepEqual(writes, []);
	setMode("ask");
	await run(tools, undefined, false);
	assert.deepEqual(writes, ["restart"]);
	await run(tools, undefined, false);
	assert.deepEqual(writes, ["restart"]);
});

test("progress streams to the tool row, and a failed run is a tool error", async () => {
	const updates: unknown[] = [];
	const call = { method: "click", app: "X", detail: "#1", ms: 5, ok: false, error: "boom" };
	const { tools } = harness({ run: async (o) => {
		o.onProgress?.({ calls: [], running: { method: "click", app: "X", detail: "#1" } });
		return { content: [{ type: "text", text: "Computer Use code stopped: boom" }], calls: [call], durationMs: 5, error: "boom" };
	} });
	await assert.rejects(run(tools, undefined, false, (update) => updates.push(update)), /boom/);
	assert.deepEqual(updates, [{ content: [], details: { calls: [], running: { method: "click", app: "X", detail: "#1" } } }]);
});

test("the panel saves checked and unchecked apps together, and restarts the client when access shrinks", async () => {
	const { commands, writes } = harness();
	const { ui, screens, notes } = fakeUi({ keys: [KEY.space, KEY.down, KEY.space, KEY.enter, KEY.enter] });
	await commands.get("computer-use").handler("", { hasUI: true, ui });
	assert.match(screens[0], /Signed OpenAI client/);
	assert.match(screens[1], /Always allow Notes\?/);
	assert.deepEqual(writes, ["revoke com.apple.finder", "allow com.apple.Notes", "restart"]);
	assert.match(notes[0], /always allowing Notes; no longer always allowing Finder/);
});

test("the panel's mode is saved, and leaving Allow all restarts the client", async () => {
	const on = harness();
	const onUi = fakeUi({ keys: [KEY.right, KEY.enter] });
	void on.commands.get("computer-use").handler("", { hasUI: true, ui: onUi.ui });
	await settle(); await settle();
	assert.match(onUi.screens[1], /Turn on Allow all\?[\s\S]*still refuses some apps, such as terminals/);
	await on.commands.get("computer-use").handler("", { hasUI: true, ui: fakeUi({ keys: [KEY.right, KEY.enter, KEY.enter] }).ui });
	assert.deepEqual(on.writes, ["mode all"]);
	const off = harness({ mode: "all" });
	await off.commands.get("computer-use").handler("", { hasUI: true, ui: fakeUi({ keys: [KEY.right, KEY.enter] }).ui });
	assert.deepEqual(off.writes, ["mode none", "restart"]);
});

test("cancelling the panel, or saving nothing, changes nothing", async () => {
	for (const keys of [[KEY.space, KEY.esc], [KEY.enter], [KEY.down, KEY.space, KEY.enter, KEY.esc, KEY.esc]]) {
		const { commands, writes } = harness();
		await commands.get("computer-use").handler("", { hasUI: true, ui: fakeUi({ keys }).ui });
		assert.deepEqual(writes, [], keys.join(","));
	}
});

test("without custom components the menu offers the same changes as select dialogs", async () => {
	const revoke = harness();
	await revoke.commands.get("computer-use").handler("", { hasUI: true, ui: fakeUi({ custom: false, answers: ["Stop always allowing an app…", "Finder (com.apple.finder)", true] }).ui });
	assert.deepEqual(revoke.writes, ["revoke com.apple.finder", "restart"]);

	const allow = harness();
	const allowUi = fakeUi({ custom: false, answers: ["Always allow an app…", "Notes (com.apple.Notes)", true] });
	await allow.commands.get("computer-use").handler("", { hasUI: true, ui: allowUi.ui });
	assert.deepEqual(allowUi.selects[1].options, ["Notes (com.apple.Notes)"]);
	assert.deepEqual(allow.writes, ["allow com.apple.Notes"]);

	const declined = harness();
	await declined.commands.get("computer-use").handler("", { hasUI: true, ui: fakeUi({ custom: false, answers: ["Change apps mode (now Ask per app)…", "Allow all", false] }).ui });
	assert.deepEqual(declined.writes, []);
	const mode = harness();
	await mode.commands.get("computer-use").handler("", { hasUI: true, ui: fakeUi({ custom: false, answers: ["Change apps mode (now Ask per app)…", "Allow all", true] }).ui });
	assert.deepEqual(mode.writes, ["mode all"]);
});

test("an approvals file in an unknown format is shown locked, and the mode can still change", async () => {
	const state: ApprovalState = { writable: false, ids: ["com.apple.finder"], problem: "manage apps in the ChatGPT app instead" };
	const { commands, writes } = harness({ state });
	const { ui, screens } = fakeUi({ keys: [KEY.space, KEY.down, KEY.space, KEY.enter] });
	await commands.get("computer-use").handler("", { hasUI: true, ui });
	assert.match(screens[0], /\[✓\] Finder/);
	assert.match(screens[0], /manage apps in the ChatGPT app instead/);
	assert.deepEqual(writes, []);

	const none = harness({ state });
	await none.commands.get("computer-use").handler("", { hasUI: true, ui: fakeUi({ keys: [KEY.space, "\x1b[D", KEY.enter] }).ui });
	assert.deepEqual(none.writes, ["mode none"]);

	const fallback = harness({ state });
	const fallbackUi = fakeUi({ custom: false, answers: ["Change apps mode (now Ask per app)…", "Allow none"] });
	await fallback.commands.get("computer-use").handler("", { hasUI: true, ui: fallbackUi.ui });
	assert.deepEqual(fallbackUi.selects[0].options, ["Change apps mode (now Ask per app)…"]);
	assert.match(fallbackUi.selects[0].title, /manage apps in the ChatGPT app instead/);
	assert.deepEqual(fallback.writes, ["mode none"]);
});
