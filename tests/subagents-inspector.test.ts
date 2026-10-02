import { test } from "node:test";
import assert from "node:assert/strict";
import { quiet, fgOf } from "./support/quiet-theme.ts";
import { colorOf } from "./support/tool-rows.ts";
import { Sheet } from "../lib/band/sheet.ts";
import { AgentView, type InspectorSource } from "../lib/subagents/inspector.ts";
import { noteText } from "../lib/subagents/format.ts";
import { agentHue } from "../lib/band/agent-look.ts";
import { NO_USAGE, type AgentRecord, type AgentState } from "../lib/subagents/types.ts";

const theme = quiet() as any;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");

function open(state: AgentState = "running", messages: unknown[] = [], extra: Partial<InspectorSource> = {}) {
	const record: AgentRecord = { name: "surveyor", parent: "main", depth: 1, task: "Survey the files", model: "openai-codex/gpt-6-luna", readOnly: false,
		fork: false, blocking: false, state, createdAt: 0, startedAt: Date.now(), activity: "bash sleep 20", toolCalls: 0, usage: NO_USAGE, runs: 1 };
	const log = { sent: [] as string[], stopped: 0, closed: 0, copied: [] as string[] };
	const source = new AgentView(theme, {
		record: () => record,
		messages: () => messages,
		send: async (text) => { log.sent.push(text); return "delivered"; },
		stop: async () => { log.stopped++; },
		describe: (tool) => tool,
		...extra,
	});
	const view = new Sheet({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, theme, source, () => { log.closed++; }, { copy: async (text) => { log.copied.push(text); } });
	const lines = () => view.render(100).map(strip);
	const screen = () => lines().join("\n");
	const type = (text: string) => { for (const ch of text) view.handleInput(ch); };
	return { view, source, log, screen, lines, type, record };
}

test("it covers the terminal: colleague title, presence, facts, task, transcript, composer and keys", () => {
	const { view, lines } = open();
	const shown = lines();
	assert.equal(shown.length, 40);
	assert.match(shown[0]!, /^ ◆ surveyor · subagent +copy task {3}copy report {3}✕ $/);
	assert.match(shown[1]!, /surveyor/);
	assert.match(shown[2]!, /^ running · openai-codex\/gpt-6-luna · 0 tool calls/);
	assert.match(shown[3]!, /^ Survey the files/);
	assert.match(shown[4]!, /^─ transcript ─+ 1 line ─$/);
	assert.match(shown.at(-2)!, /^ → surveyor ▏write to it/);
	assert.match(shown.at(-1)!, /^ enter send · esc close · ctrl\+x stop · ↑↓ PgUp\/PgDn scroll/);
	view.dispose();
});

test("the inspector colors only its title and composer, in the agent's provider color, over an unfilled presence", () => {
	const { view, source } = open();
	const raw = view.render(100);
	const codex = agentHue("openai-codex/gpt-6-luna");
	assert.equal(source.titleColor(), codex);
	assert.equal(colorOf(raw[0]!, "◆ surveyor"), fgOf(codex));
	assert.equal(colorOf(raw.at(-2)!, "→ surveyor"), fgOf(codex));
	assert.match(strip(raw[1]!), /^ {2}◆ surveyor  .*gpt-6-luna/);
	assert.doesNotMatch(raw[1]!, /\x1b\[48;|▍/);
	assert.equal(colorOf(raw.at(-2)!, "▏"), fgOf(codex));
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

test("its buttons copy the task, and the report once there is one", async () => {
	const { view, log, lines, record } = open("idle");
	const title = lines()[0]!;
	const click = (x: number) => view.handleMouse({ type: "click", button: "left", x, y: 0, screenX: x, screenY: 0, width: 100, height: 40, shift: false, alt: false, ctrl: false });
	click(title.indexOf("copy task") + 1);
	click(title.indexOf("copy report") + 1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(log.copied, ["Survey the files"]);
	assert.match(lines().at(-1)!, /Nothing to copy yet/);
	record.report = "All done.";
	click(title.indexOf("copy report") + 1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(log.copied, ["Survey the files", "All done."]);
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
	assert.match(lines()[1]!, /finished/);
	assert.doesNotMatch(lines()[1]!, /report queued/);
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
