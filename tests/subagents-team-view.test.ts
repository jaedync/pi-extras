import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Sheet } from "../lib/band/sheet.ts";
import { TeamView } from "../lib/subagents/team-view.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";
import { bgOf, quiet } from "./support/quiet-theme.ts";

const theme = quiet() as never;
const SELECTED = bgOf("#2d2d31");

function record(name: string, extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		name, parent: "main", depth: 1, task: `Task for ${name}`, model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false,
		state: "running", createdAt: 0, startedAt: Date.now() - 5_000, activity: "bash npm test", toolCalls: 0, usage: NO_USAGE, runs: 1, ...extra,
	};
}

function open(records: AgentRecord[], options: { rows?: number; selected?: string } = {}) {
	const opened: string[] = [];
	let closed = 0;
	let sheet: Sheet | undefined;
	const view = new TeamView(theme, {
		records: () => records,
		pending: () => [],
		open: (name) => opened.push(name),
		motion: () => "reduced",
		...(options.selected ? { selected: options.selected } : {}),
	}, () => sheet?.requestClose());
	const tui = { requestRender() {}, terminal: { rows: options.rows ?? 30, columns: 100 } };
	sheet = new Sheet(tui, theme, view, () => { closed++; });
	const raw = () => sheet!.render(100);
	const lines = () => raw().map((line) => stripTerminalSequences(line));
	const mouse = (y: number): TuiMouseEvent => ({ type: "click", button: "left", x: 6, y, screenX: 6, screenY: y, width: 100, height: 30, shift: false, alt: false, ctrl: false });
	return { sheet, view, raw, lines, opened, closed: () => closed, mouse };
}

const family = () => [
	record("lead"),
	record("helper", { parent: "lead", depth: 2, task: "Help\n  the lead" }),
	record("done", { state: "idle", endedAt: Date.now(), usage: { ...NO_USAGE, cost: 0.25 } }),
	record("broke", { state: "failed", error: "rate limited", endedAt: Date.now() }),
];

test("an orphan says so before its task, as the old picker did", () => {
	const lines = open([record("lost", { state: "interrupted", orphaned: true })]).lines();
	assert.ok(lines.some((line) => line.trim() === "orphan · Task for lost"), lines.join("\n"));
});

test("every agent shows as its live row with its task under it, children under their parents, and a summary on top", () => {
	const { lines, sheet } = open(family());
	const shown = lines();
	assert.equal(shown.length, 30);
	for (const line of shown) assert.equal(visibleWidth(line), 100);
	assert.match(shown[0]!, /^ Subagents · 4 /);
	assert.match(shown[1]!, /^ {2}1 failed · 2 working · 1 finished · \$0\.25/);
	const body = shown.map((line) => line.trimEnd()).filter((line) => /◆|Task|Help/.test(line));
	assert.match(body[0]!, /^ {3}◆ lead +\S+ +\S+ +bash npm test/);
	assert.equal(body[1], "     Task for lead");
	assert.match(body[2]!, /^ {3}└ ◆ helper/);
	assert.equal(body[3], "       Help the lead", "the task is one line, set in under the name");
	assert.match(body[4]!, /^ {3}◆ done +\S+ +✓ +finished/);
	assert.match(body[6]!, /^ {3}◆ broke .*failed: rate limited/);
	assert.match(shown.at(-1)!, /↑↓ select · enter open · esc close/);
	sheet.dispose();
});

test("arrows move the selection, which is highlighted; enter closes the view and opens that agent", () => {
	const view = open(family());
	const highlighted = () => view.raw().filter((line) => line.includes(SELECTED)).map((line) => stripTerminalSequences(line).trim());
	assert.match(highlighted()[0]!, /^◆ lead/);
	view.sheet.handleInput("\x1b[B");
	view.sheet.handleInput("\x1b[B");
	assert.match(highlighted()[0]!, /^◆ done/);
	assert.equal(highlighted()[1], "Task for done", "both of its lines");
	view.sheet.handleInput("\x1b[A");
	view.sheet.handleInput("\r");
	assert.deepEqual(view.opened, ["helper"]);
	assert.equal(view.closed(), 1);
});

test("a click on either line of an agent opens it", () => {
	const view = open(family());
	const at = view.lines().findIndex((line) => line.includes("Task for done"));
	assert.deepEqual(view.sheet.handleMouse(view.mouse(at)), { handled: true });
	assert.deepEqual(view.opened, ["done"]);
	assert.equal(view.closed(), 1);
});

test("it starts on the agent it was asked to, and stays on it by name as agents come and go", () => {
	const records = family();
	const view = open(records, { selected: "broke" });
	const highlighted = () => view.raw().filter((line) => line.includes(SELECTED)).map((line) => stripTerminalSequences(line).trim())[0];
	assert.match(highlighted()!, /^◆ broke/);
	records.unshift(record("newcomer"));
	assert.match(highlighted()!, /^◆ broke/);
});

test("a long list scrolls to keep the selection in view", () => {
	const records = Array.from({ length: 30 }, (_, i) => record(`agent-${String(i).padStart(2, "0")}`));
	const view = open(records, { rows: 20 });
	assert.ok(view.lines().some((line) => line.includes("agent-00")));
	for (let i = 0; i < 25; i++) view.sheet.handleInput("\x1b[B");
	const shown = view.lines().join("\n");
	assert.match(shown, /agent-25/);
	assert.doesNotMatch(shown, /agent-00/);
});

test("it redraws while any agent works, and says so when there are none", () => {
	assert.equal(open(family()).view.live(), true);
	assert.equal(open([record("done", { state: "idle" })]).view.live(), false);
	const empty = open([]);
	assert.ok(empty.lines().some((line) => line.includes("No subagents in this session.")));
	empty.sheet.handleInput("\r");
	assert.deepEqual(empty.opened, []);
});

test("a frame reads the team once, however many parts draw it", () => {
	let reads = 0;
	const records = family();
	const view = new TeamView(theme, { records: () => { reads++; return records; }, pending: () => [], open: () => undefined, motion: () => "reduced" }, () => undefined);
	const sheet = new Sheet({ requestRender() {}, terminal: { rows: 30, columns: 100 } }, theme, view, () => undefined);
	sheet.render(100);
	reads = 0;
	sheet.render(100);
	assert.equal(reads, 1);
});
