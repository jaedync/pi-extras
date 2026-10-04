import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { quiet, fgOf } from "./support/quiet-theme.ts";
import { colorOf } from "./support/tool-rows.ts";
import { Sheet } from "../lib/band/sheet.ts";
import { bgSgr } from "../lib/band/color.ts";
import { AgentView, type InspectorSource } from "../lib/subagents/inspector.ts";
import { noteText } from "../lib/subagents/format.ts";
import { agentGround, agentHue } from "../lib/band/agent-look.ts";
import { shareDrawnTools } from "../lib/tool-row.ts";
import { NO_USAGE, type AgentRecord, type AgentState } from "../lib/subagents/types.ts";

// Pi's chat components draw with Pi's own theme.
initTheme("dark");
const theme = quiet() as any;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };

function open(state: AgentState = "running", messages: unknown[] = [], extra: Partial<InspectorSource> = {}) {
	const record: AgentRecord = { name: "surveyor", parent: "main", depth: 1, task: "Survey the files", model: "openai-codex/gpt-6-luna", readOnly: false,
		fork: false, blocking: false, state, createdAt: 0, startedAt: Date.now(), activity: "bash sleep 20", toolCalls: 0, usage: NO_USAGE, runs: 1 };
	const log = { sent: [] as string[], stopped: 0, closed: 0 };
	const source = new AgentView(theme, {
		record: () => record,
		messages: () => messages,
		send: async (text) => { log.sent.push(text); return "delivered"; },
		stop: async () => { log.stopped++; },
		cwd: "/work",
		...extra,
	}, tui as never);
	const view = new Sheet(tui, theme, source, () => { log.closed++; });
	const lines = () => view.render(100).map(strip);
	const screen = () => lines().join("\n");
	const type = (text: string) => { for (const ch of text) view.handleInput(ch); };
	return { view, source, log, screen, lines, type, record };
}

test("it reads as a chat: its live row on top, the chat, a message box between rules, and keys", () => {
	const { view, lines } = open("running", [{ role: "user", content: "Survey the files" }]);
	const shown = lines();
	assert.equal(shown.length, 40);
	assert.match(shown[0]!, /^ ◆ surveyor  \S+  gpt-6-luna  \S{3} bash sleep 20 +✕ $/);
	assert.doesNotMatch(shown.join("\n"), /· subagent|copy task|copy report|─ transcript/);
	assert.ok(shown.slice(1, 5).some((line) => line.includes("Survey the files")), "the task is its first message, at the top");
	assert.match(shown.at(-4)!, /^─+ 0 tool calls ─$/);
	assert.match(shown.at(-3)!, /^ → surveyor ▏write to it/);
	assert.match(shown.at(-2)!, /^─+$/);
	assert.match(shown.at(-1)!, /^ enter send · esc close · ctrl\+x stop · ↑↓ PgUp\/PgDn scroll/);
	view.dispose();
});

test("the whole view sits on a wash of the agent's color, its bars a step above it", () => {
	const { view, source } = open("running", [{ role: "assistant", content: [{ type: "text", text: "Found 5." }], stopReason: "stop" }]);
	const raw = view.render(100);
	const ground = agentGround(theme, "openai-codex/gpt-6-luna")!;
	assert.deepEqual(source.ground(), ground);
	const sgr = bgSgr(ground, "truecolor");
	const body = raw.find((line) => strip(line).includes("Found 5."))!;
	assert.ok(body.startsWith(sgr), "the chat sits on the ground");
	assert.ok(raw.at(-3)!.startsWith(sgr), "so does the message box");
	assert.ok(!raw[0]!.startsWith(sgr) && /^\x1b\[48;/.test(raw[0]!), "the title bar sits a step above it");
	const claude = agentGround(theme, "anthropic/claude-opus-5-5")!;
	assert.notDeepEqual(claude, ground, "each provider washes its own color");
	view.dispose();
});

test("the inspector colors its name, rules and composer in the agent's provider color", () => {
	const { view } = open();
	const raw = view.render(100);
	const codex = agentHue("openai-codex/gpt-6-luna");
	assert.equal(colorOf(raw[0]!, "◆ surveyor"), fgOf(codex));
	assert.equal(colorOf(raw.at(-3)!, "→ surveyor"), fgOf(codex));
	assert.equal(colorOf(raw.at(-3)!, "▏"), fgOf(codex));
	assert.equal(colorOf(raw.at(-2)!, "─"), fgOf(codex));
	view.dispose();
});

test("the chat is Pi's own: user and assistant messages, thinking, and tool rows with their results", () => {
	const messages = [
		{ role: "user", content: "Count the files" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "Let me look" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls lib" } }], stopReason: "toolUse" },
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "alpha.ts\nbeta.ts" }], isError: false },
		{ role: "assistant", content: [{ type: "text", text: "There are **2** files." }], stopReason: "stop" },
	];
	const { view, screen } = open("idle", messages);
	const shown = screen();
	for (const said of ["Count the files", "Let me look", "ls lib", "alpha.ts", "There are 2 files."]) assert.ok(shown.includes(said), said);
	assert.ok(shown.indexOf("Count the files") < shown.indexOf("ls lib") && shown.indexOf("ls lib") < shown.indexOf("There are 2 files."));
	view.dispose();
});

test("the reply being written shows as it streams, and once it ends it is drawn once", () => {
	const messages: unknown[] = [{ role: "user", content: "Go" }];
	let streaming: unknown = { role: "assistant", content: [{ type: "text", text: "Half a tho" }] };
	const { view, screen } = open("running", messages, { streaming: () => streaming });
	assert.ok(screen().includes("Half a tho"));
	streaming = { role: "assistant", content: [{ type: "text", text: "Half a thought, now whole." }] };
	assert.ok(screen().includes("Half a thought, now whole."));
	const done = { role: "assistant", content: [{ type: "text", text: "Half a thought, now whole." }], stopReason: "stop" };
	messages.push(done);
	streaming = done;
	assert.equal(screen().split("Half a thought, now whole.").length, 2, "drawn once, not twice");
	view.dispose();
});

test("a call left without a result says so once the agent can't finish it", () => {
	const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 99" } }], stopReason: "toolUse" }];
	const running = open("running", messages);
	assert.doesNotMatch(running.screen(), /Stopped before this call returned/);
	running.view.dispose();
	const stopped = open("stopped", messages);
	assert.match(stopped.screen(), /Stopped before this call returned/);
	stopped.view.dispose();
});

test("tool rows are drawn as main draws them: Tool Display's own definition first, then the agent's", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }, { type: "toolCall", id: "c2", name: "lookup", arguments: {} }], stopReason: "toolUse" },
	];
	const drawn = (label: string) => ({ renderCall: () => new Text(label, 0, 0), renderResult: () => new Text("", 0, 0) });
	shareDrawnTools((name) => (name === "bash" ? drawn("MAIN'S BASH ROW") : undefined));
	try {
		const { view, screen } = open("running", messages, { tool: (name) => (name === "lookup" ? drawn("THE AGENT'S LOOKUP ROW") : undefined) });
		assert.match(screen(), /MAIN'S BASH ROW/);
		assert.match(screen(), /THE AGENT'S LOOKUP ROW/);
		view.dispose();
	} finally {
		shareDrawnTools(undefined);
	}
});

test("a click on the chat reaches the row under it, as in main's transcript", () => {
	let clicks: Array<{ x: number; y: number }> = [];
	const row = { render: () => ["CLICK ME", "SECOND LINE"], invalidate() {}, handleMouse: (event: { x: number; y: number }) => { clicks.push({ x: event.x, y: event.y }); return { handled: true }; } };
	shareDrawnTools((name) => (name === "bash" ? { renderCall: () => row, renderResult: () => new Text("", 0, 0) } : undefined));
	try {
		const messages = [{ role: "user", content: "Go" }, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" }];
		const { view, lines } = open("running", messages);
		const y = lines().findIndex((line) => line.includes("SECOND LINE"));
		const x = lines()[y]!.indexOf("SECOND LINE") + 3;
		const result = view.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 100, height: 40, shift: false, alt: false, ctrl: false });
		assert.deepEqual(result, { handled: true });
		assert.equal(clicks.length, 1);
		assert.equal(clicks[0]!.y, 1, "the row's own second line");
		clicks = [];
		view.handleMouse({ type: "click", button: "left", x: 5, y: 0, screenX: 5, screenY: 0, width: 100, height: 40, shift: false, alt: false, ctrl: false });
		assert.equal(clicks.length, 0, "the title bar is not the chat");
		view.dispose();
	} finally {
		shareDrawnTools(undefined);
	}
});

test("a queued agent shows its task until it starts", () => {
	const { view, screen } = open("queued");
	assert.match(screen(), /Queued; it hasn't started yet\. Its task:/);
	assert.match(screen(), /Survey the files/);
	view.dispose();
});

test("a failure from outside its replies shows under the chat, once (the row names it too)", () => {
	const failed = open("failed");
	failed.record.error = "Quota exceeded until 14:00.";
	const chat = failed.lines().slice(1).join("\n");
	assert.equal(chat.split("Quota exceeded until 14:00.").length, 2);
	failed.view.dispose();
});

test("the top rule carries the facts the row leaves out", () => {
	const { view, record, lines } = open();
	Object.assign(record, { contextTokens: 50_000, contextWindow: 200_000, toolCalls: 1, runs: 2, readOnly: true, parent: "lead" });
	assert.match(lines().at(-4)!, /─ ctx 25% · 1 tool call · 2 runs · read-only · under lead ─$/);
	view.dispose();
});

test("arrows scroll the transcript while letters type", () => {
	const messages = Array.from({ length: 60 }, (_, index) => ({ role: "user", content: `note ${index + 1}` }));
	const { view, screen, type } = open("running", messages);
	const before = screen();
	type("k");
	view.handleInput("\x1b[A");
	view.handleInput("\x1b[5~");
	assert.notEqual(screen().replace(/→ surveyor k▏/, ""), before.replace(/→ surveyor ▏write to it/, ""));
	assert.match(screen(), /→ surveyor k▏/);
	view.dispose();
});

test("typing goes straight to the message box, and Enter sends it", async () => {
	const { view, log, screen, type } = open();
	type("Also check ");
	view.handleInput("the tests"); // a paste arrives in one piece
	assert.match(screen(), /→ surveyor Also check the tests▏/);
	view.handleInput("\r");
	await Promise.resolve();
	assert.deepEqual(log.sent, ["Also check the tests"]);
	assert.doesNotMatch(screen(), /Also check the tests▏/);
	view.dispose();
});

test("letters are text, not shortcuts", () => {
	const { view, log, screen, type } = open();
	type("quick fix, go");
	assert.equal(log.closed, 0);
	assert.equal(log.stopped, 0);
	assert.match(screen(), /quick fix, go▏/);
	view.dispose();
});

test("Esc clears a draft first, then closes", () => {
	const { view, log, screen, type } = open();
	type("draft");
	view.handleInput("\x1b");
	assert.equal(log.closed, 0);
	assert.doesNotMatch(screen(), /draft▏/);
	view.handleInput("\x1b");
	assert.equal(log.closed, 1);
});

test("ctrl+x twice stops the agent", async () => {
	const { view, log, screen } = open();
	view.handleInput("\x18");
	assert.match(screen(), /ctrl\+x again to stop it/);
	view.handleInput("\x18");
	await Promise.resolve();
	assert.equal(log.stopped, 1);
	view.dispose();
});

test("letters a terminal sends in the kitty protocol are typed", () => {
	const { view, screen } = open();
	view.handleInput("\x1b[104u");
	view.handleInput("\x1b[105u");
	assert.match(screen(), /→ surveyor hi▏/);
	view.dispose();
});

test("an agent that ended says it can't take messages", () => {
	const { view, log, screen, type } = open("failed");
	assert.match(screen(), /It has ended; it can't take messages\./);
	type("hello");
	view.handleInput("\r");
	assert.deepEqual(log.sent, []);
	view.dispose();
});

test("a finished agent's inspector says it finished, not that its report waits", () => {
	// The rows above the editor keep a finished agent only while its report is queued; the inspector can't tell, so it says what is sure.
	const { view, lines } = open("idle");
	assert.match(lines()[0]!, /finished/);
	assert.doesNotMatch(lines()[0]!, /report queued/);
	view.dispose();
});

test("messages the agent received read as conversation rows, each sender in its own color", () => {
	const told = [{ role: "user", content: "Survey the files" }, { role: "user", content: [noteText("user", "Also the docs."), noteText("finder", "lib/x.ts")].join("\n\n") }];
	const sonnet = agentHue("anthropic/claude-sonnet-5-5");
	const row = (raw: string[], words: string) => raw.find((line) => strip(line).includes(words))!;
	const { view } = open("running", told, { hue: (name) => (name === "finder" ? sonnet : agentHue("openai-codex/gpt-6-luna")) });
	const raw = view.render(100);
	assert.ok(!strip(raw.join("\n")).includes("Message from"), "no envelope text");
	assert.equal(colorOf(row(raw, "you wrote"), "→ surveyor"), fgOf(agentHue("openai-codex/gpt-6-luna")));
	assert.equal(colorOf(row(raw, "◆ finder → surveyor"), "◆ finder"), fgOf(sonnet));
	view.dispose();
	// Without a way to look agents up, the agent itself keeps its color and others the purple.
	const bare = open("running", told);
	const plainRaw = bare.view.render(100);
	assert.equal(colorOf(row(plainRaw, "you wrote"), "→ surveyor"), fgOf(agentHue("openai-codex/gpt-6-luna")));
	assert.equal(colorOf(row(plainRaw, "◆ finder → surveyor"), "◆ finder"), fgOf("#b294b0"));
	bare.view.dispose();
});
