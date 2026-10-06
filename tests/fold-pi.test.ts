/** Folded mode against Pi's own reply, tool row and container, with the thinking patch installed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FoldView, installFold, type Box } from "../lib/fold/transcript.ts";
import { installThinkingTail } from "../lib/tool-display/thinking.ts";

initTheme("dark");

const ui = { requestRender() {} };
const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).replace(/ {2,}/g, "  ").trimEnd());

function transcript() {
	const call = { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } };
	const asking = new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: "Look at a.ts first." }, call], stopReason: "toolUse", usage: { output: 40, cost: { total: 0.01 } }, timestamp: 1_000 } as never, true);
	const row = new ToolExecutionComponent("read", "t1", { path: "a.ts" }, {}, undefined, ui as never, "/tmp");
	row.updateResult({ content: [{ type: "text", text: "export const a = 1;" }], isError: false });
	const answer = new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: "Answer now." }, { type: "text", text: "a is 1." }], stopReason: "stop", usage: { output: 9 }, timestamp: 5_000 } as never, true);
	const chat = new Container();
	chat.children = [new Spacer(1), asking, row, answer];
	return { chat, asking, row, answer };
}

test("Pi's rows fold into one line, its replies lose their thinking, and a real click opens the run", () => {
	let enabled = true;
	const view = new FoldView({
		enabled: () => enabled, theme: () => undefined, busy: () => false, now: () => 9_000, reduced: () => true,
		toolEndedAt: () => 3_000, thoughtMs: () => undefined, nestedOf: () => undefined, animate() {}, redraw() {},
	});
	const undoThinking = installThinkingTail({ mode: () => "tail", hiddenAtStart: () => true, theme: () => undefined, gutter: () => true, summary: () => "∴ Thought", folds: (reply) => view.foldsThinking(reply) });
	const { chat, answer } = transcript();
	const pi = plain(chat.render(80));
	const undo = installFold(chat as unknown as Box, view, () => enabled);
	try {
		const folded = plain(chat.render(80));
		assert.deepEqual(folded, ["", "", "● Read 1 file, ↓49 4.0s", "", "● a is 1."]);
		assert.ok(!folded.some((line) => line.includes("Thought")), "the answer's thinking is left out");
		const at = folded.indexOf(folded.find((line) => line.startsWith("●"))!);
		const result = chat.handleMouse({ type: "click", button: "left", x: 4, y: at, width: 80, height: folded.length } as never);
		assert.ok(result, "Pi's container sends the click to the folded line");
		const open = plain(chat.render(80));
		assert.equal(open[2], "● Read 1 file, ↓49 4.0s", "the answer thought after the read, so its thinking is in this run");
		assert.equal(open.filter((line) => line === "∴ Thought").length, 2, "the open run shows the thinking of both replies");
		assert.ok(open.some((line) => line.includes("export const a = 1;")), "and Pi's tool row");
		enabled = false;
		answer.invalidate();
		chat.children.forEach((child) => child.invalidate());
		assert.deepEqual(plain(chat.render(80)), pi, "off draws what Pi drew before");
	} finally {
		undo();
		undoThinking();
	}
});
