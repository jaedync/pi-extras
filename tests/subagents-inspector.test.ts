import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentInspector } from "../lib/subagents/inspector.ts";
import { NO_USAGE, type AgentRecord, type AgentState } from "../lib/subagents/types.ts";

const theme = { fg: (_k: string, t: string) => t, bg: (_k: string, t: string) => t, bold: (t: string) => t, getFgAnsi: () => "", getBgAnsi: () => "" } as any;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");

function open(state: AgentState = "running") {
	const record: AgentRecord = { name: "surveyor", parent: "main", depth: 1, task: "Survey the files", model: "openai-codex/gpt-6-luna", readOnly: false,
		fork: false, blocking: false, state, createdAt: 0, startedAt: Date.now(), activity: "bash sleep 20", toolCalls: 0, usage: NO_USAGE, runs: 1 };
	const log = { sent: [] as string[], stopped: 0, closed: 0 };
	const view = new AgentInspector({ requestRender() {}, terminal: { rows: 40, columns: 120 } }, theme, {
		record: () => record,
		messages: () => [],
		send: async (text) => { log.sent.push(text); return "delivered"; },
		stop: async () => { log.stopped++; },
		describe: (tool) => tool,
	}, () => { log.closed++; });
	const screen = () => view.render(100).map(strip).join("\n");
	const type = (text: string) => { for (const ch of text) view.handleInput(ch); };
	return { view, log, screen, type };
}

test("typing goes straight to the message box, and Enter sends it", async () => {
	const { view, log, screen, type } = open();
	type("Also check ");
	view.handleInput("the tests"); // a paste arrives in one piece
	assert.match(screen(), /surveyor ▸ Also check the tests▏/);
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
	assert.match(screen(), /▸ hi▏/);
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
