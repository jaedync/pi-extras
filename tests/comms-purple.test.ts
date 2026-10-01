import assert from "node:assert/strict";
import { BULLET_GLYPH } from "../lib/band/glyph.ts";
import test from "node:test";
import { CustomMessageComponent, ExtensionRunner, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createMessageRenderer, createReportRenderer, messageCallRow } from "../lib/subagents/render.ts";
import { foreignRenderers } from "../lib/tool-display/foreign.ts";
import { registerToolDisplay } from "../lib/tool-display/index.ts";
import type { RenderContext } from "../lib/tool-display/kit.ts";
import { bgOf, fgOf, quiet } from "./support/quiet-theme.ts";
import { harness, text } from "./support/tool-rows.ts";

initTheme("dark");
const base = quiet();
const purpleBg = bgOf("#30233e");
const purpleFg = fgOf("#bc9ce8");
const purpleBand = bgOf("#4f3e63");
const theme = {
	...base,
	getBgAnsi: (key: string) => key === "customMessageBg" ? purpleBg : base.getBgAnsi(key),
	getFgAnsi: (key: string) => key === "customMessageLabel" ? purpleFg : base.getFgAnsi(key),
	bg: (key: string, value: string) => key === "customMessageBg" ? `${purpleBg}${value}\x1b[49m` : base.bg(key, value),
	fg: (key: string, value: string) => key === "customMessageLabel" ? `${purpleFg}${value}\x1b[39m` : base.fg(key, value),
};
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const envelope = (body = "Found **three** files.", re?: string) => `[agent-network] message from "/workspace/demo@scout" (id=msg-1${re ? `, re=${re}` : ""}):\n${body}\n\n${re ? "(This is a reply to a previous message of yours.)" : '(If a reply is expected, call agent_send with to="/workspace/demo@scout" and re="msg-1".)'}`;
const mesh = () => import("../lib/tool-display/mesh.ts");

function foreign(name: string, isError = false, partial = false) {
	const h = harness();
	const renderers = foreignRenderers(h.kit, { name });
	const context: RenderContext = { args: { to: "scout", message: "hello" }, toolCallId: "comms-1", state: {}, lastComponent: undefined,
		cwd: "/workspace", executionStarted: partial, argsComplete: true, isPartial: partial, expanded: false, isError, invalidate() {} };
	const call = renderers.renderCall(context.args, theme, context);
	if (!partial) renderers.renderResult(text(isError ? "Delivery failed" : "Delivered"), { expanded: false, isPartial: false }, theme, context);
	return { h, call };
}

test("agent_send and agent_request stay purple on success, failure and while running", () => {
	for (const name of ["agent_send", "agent_request"]) for (const [error, partial] of [[false, false], [true, false], [false, true]]) {
		const { h, call } = foreign(name, error, partial);
		try {
			const line = call.render(84)[0]!;
			assert.ok(line.includes(purpleBand), `${name} error=${error} partial=${partial} has the shared purple band`);
			if (error) { assert.match(stripTerminalSequences(line), /failed/); assert.ok(line.includes(base.getFgAnsi("error"))); }
		} finally { h.kit.clock.stop(); }
	}
});

test("the foreign comms wrapper preserves time, result styling and the popup click", () => {
	const h = harness();
	const renderers = foreignRenderers(h.kit, { name: "agent_send" });
	const context: RenderContext = { args: { to: "scout", message: "hello" }, toolCallId: "comms-2", state: {}, lastComponent: undefined,
		cwd: "/workspace", executionStarted: true, argsComplete: true, isPartial: true, expanded: false, isError: false, invalidate() {} };
	try {
		const running = renderers.renderCall(context.args, theme, context);
		running.render(84);
		h.advance(1_200);
		const done = { ...context, isPartial: false, isError: true, lastComponent: running };
		const call = renderers.renderCall(done.args, theme, done);
		const result = renderers.renderResult(text("Peer unavailable"), { expanded: false, isPartial: false }, theme, { ...done, lastComponent: undefined });
		assert.match(plain(call.render(84))[0]!, /failed\s+1\.2s/);
		assert.ok(result.render(84)[0]!.includes(base.getFgAnsi("error")));
		assert.deepEqual(call.handleMouse?.({ type: "click", button: "left" } as never), { handled: true });
		assert.equal(h.popups[0]!.label(), "agent_send");
		assert.match(plain(h.popups[0]!.head(theme, 84, 0)).join("\n"), /to\s+scout/);
		assert.match(plain(h.popups[0]!.output(theme, 84, 0)).join("\n"), /Peer unavailable/);
	} finally { h.kit.clock.stop(); }
});

test("communication rows keep the shared bullet gutter and text under the title", async () => {
	const title = (line: string) => assert.ok(line.startsWith(`${BULLET_GLYPH} `));
	const { createMeshMessageRenderer } = await mesh();
	const mail = plain(createMeshMessageRenderer(() => getMarkdownTheme())({ content: envelope() } as never, { expanded: false } as never, theme as never)!.render(84));
	title(mail[0]!);
	assert.match(mail[1]!, /^ {4}Found three files\./, "its text under the title");
	const note = plain(createMessageRenderer()({ details: { id: "mail-1", kind: "note", from: "scout", to: "reader", text: "hello" } } as never, { expanded: false } as never, theme as never)!.render(84));
	title(note[0]!);
	assert.match(note[1]!, /^ {4}hello/);
	title(plain(messageCallRow({ to: "scout", text: "hi" }, theme as never, { state: {} }).render(84))[0]!);
	// Written now: a dim bullet in the margin, while the band keeps its identity purple.
	title(plain(messageCallRow({ to: "scout", text: "hi" }, theme as never, { state: {}, isPartial: true, executionStarted: false }).render(84))[0]!);
	const h = harness();
	const renderers = foreignRenderers({ ...h.kit, streaming: () => true }, { name: "agent_send" });
	const context: RenderContext = { args: { to: "scout", message: "hello" }, toolCallId: "comms-3", state: {}, lastComponent: undefined,
		cwd: "/workspace", executionStarted: false, argsComplete: false, isPartial: true, expanded: false, isError: false, invalidate() {} };
	try {
		const line = renderers.renderCall(context.args, theme, context).render(84)[0]!;
		assert.ok(line.includes(purpleBand));
		title(plain([line])[0]!);
	} finally { h.kit.clock.stop(); }
});

test("list_peers remains an operational tool, not a purple communication row", () => {
	const { call } = foreign("list_peers");
	assert.ok(!call.render(84)[0]!.includes(purpleBand));
});

test("message call rows use purple, including failed deliveries", () => {
	for (const isError of [false, true]) {
		const line = messageCallRow({ to: "scout", text: "hello" }, theme as never, { state: {}, isError }).render(84)[0]!;
		assert.ok(line.includes(purpleBand));
		if (isError) assert.match(stripTerminalSequences(line), /not delivered/);
	}
});

test("subagent notes and questions share a purple band; asks keeps its amber word", () => {
	for (const kind of ["note", "question", "reply", "relay"]) {
		const row = createMessageRenderer()({ details: { id: "mail-1", kind, from: "scout", to: "reader", text: "hello" } } as never, { expanded: false } as never, theme as never)!;
		assert.ok(row.render(84)[0]!.includes(purpleBand), kind);
		assert.ok(row.render(84)[1]!.startsWith(purpleBg), "mail body uses the same purple surface as mesh mail");
		if (kind === "question") assert.ok(row.render(84)[0]!.includes(base.getFgAnsi("warning")));
	}
});

test("reports retain outcome colors instead of turning purple", () => {
	for (const state of ["idle", "failed"]) {
		const report = createReportRenderer()({ details: { kind: "report", reports: [{ name: "scout", model: "model", state, cost: 0, report: "Done" }] } } as never, { expanded: false } as never, theme as never)!;
		assert.ok(!report.render(84)[0]!.includes(purpleBand));
	}
});

test("mesh envelopes parse sender, id, optional reply and hide only the final footer", async () => {
	const { parseMeshMessage } = await mesh();
	assert.deepEqual(parseMeshMessage(envelope()), { from: "/workspace/demo@scout", id: "msg-1", text: "Found **three** files." });
	assert.deepEqual(parseMeshMessage(envelope("Reply", "prior-2")), { from: "/workspace/demo@scout", id: "msg-1", re: "prior-2", text: "Reply" });
	assert.equal(parseMeshMessage(envelope("A\n\n(This is a reply to a previous message of yours.)\n\nB"))?.text, "A\n\n(This is a reply to a previous message of yours.)\n\nB");
	assert.equal(parseMeshMessage(envelope().replace(/\n\n\(If[\s\S]*$/, ""))?.text, "Found **three** files.");
	assert.equal(parseMeshMessage(envelope().replaceAll("\n", "\r\n"))?.id, "msg-1");
	for (const bad of ["", "raw text", '[agent-network] message from "x" (id=):\ntext', null, {}, []]) assert.equal(parseMeshMessage(bad), undefined);
});

test("mesh messages and replies show a purple Markdown band without their envelope", async () => {
	const { createMeshMessageRenderer } = await mesh();
	for (const re of [undefined, "prior-2"]) {
		const message = { content: envelope(undefined, re) };
		const row = createMeshMessageRenderer(() => getMarkdownTheme())(message as never, { expanded: false } as never, theme as never)!;
		const raw = row.render(100);
		assert.ok(raw[0]!.includes(purpleBand));
		assert.match(plain(raw)[0]!, /scout.*demo.*→ me/);
		assert.match(plain(raw)[0]!, re ? /replies/ : /message/);
		assert.match(plain(raw).slice(1).join("\n"), /Found three files\./);
		assert.doesNotMatch(plain(raw).join("\n"), /agent-network|agent_send|msg-1|previous message|\*\*/);
		assert.ok(raw[1]!.startsWith(purpleBg));
		assert.equal(message.content, envelope(undefined, re), "rendering does not change model-facing content");
	}
});

test("Pi finds the mesh renderer in a different extension and uses it without a default label", async () => {
	const { createMeshMessageRenderer, MESH_MESSAGE_TYPE } = await mesh();
	const renderer = createMeshMessageRenderer(() => getMarkdownTheme());
	const selected = ExtensionRunner.prototype.getMessageRenderer.call({ extensions: [
		{ messageRenderers: new Map() }, { messageRenderers: new Map([[MESH_MESSAGE_TYPE, renderer]]) },
	] } as never, MESH_MESSAGE_TYPE);
	assert.equal(selected, renderer);
	const message = { role: "custom", customType: MESH_MESSAGE_TYPE, content: envelope(), display: true, timestamp: 0 };
	const component = new CustomMessageComponent(message as never, selected);
	assert.match(plain(component.render(100)).join("\n"), /scout.*→ me/);
	assert.doesNotMatch(plain(component.render(100)).join("\n"), /\[remote-pi:mesh-message\]|agent-network|agent_send/);
	assert.doesNotThrow(() => component.setExpanded(true));
});

test("mesh mail click overrides persist and ctrl+o resets them; narrow widths fit", async () => {
	const { createMeshMessageRenderer } = await mesh();
	const render = createMeshMessageRenderer();
	const message = { content: envelope(Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n")) };
	const row = render(message as never, { expanded: false } as never, theme as never)!;
	assert.match(plain(row.render(84)).at(-1)!, /more lines/);
	(row as Component & { handleMouse(event: unknown): unknown }).handleMouse({ type: "click", button: "left" });
	assert.ok(plain(render(message as never, { expanded: false } as never, theme as never)!.render(84)).some((line) => line.includes("line 13")));
	render(message as never, { expanded: true } as never, theme as never);
	const collapsed = render(message as never, { expanded: false } as never, theme as never)!;
	assert.match(plain(collapsed.render(84)).at(-1)!, /more lines/);
	for (const width of [1, 2, 3, 8, 20, 40]) assert.ok(collapsed.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
});

test("unparseable mesh content falls back to a purple band and sanitized raw text", async () => {
	const { createMeshMessageRenderer } = await mesh();
	const render = createMeshMessageRenderer();
	for (const content of ["raw **unparsed** text\x1b]0;bad\x07\x1b[2J", [{ type: "text", text: "raw block" }], null]) {
		const row = render({ content } as never, { expanded: false } as never, theme as never)!;
		assert.ok(row.render(84)[0]!.includes(purpleBand));
		assert.doesNotMatch(row.render(84).join("\n"), /\x1b\]0;|\x1b\[2J/);
		if (typeof content === "string") assert.match(plain(row.render(84)).join("\n"), /raw \*\*unparsed\*\* text/);
	}
});

test("Tool Display registers mesh rendering before session_start", () => {
	const renderers = new Map<string, unknown>();
	registerToolDisplay({ on() {}, registerMessageRenderer: (type: string, render: unknown) => renderers.set(type, render), registerCommand() {} } as never,
		{ host: {}, settings: {} } as never);
	assert.equal(typeof renderers.get("remote-pi:mesh-message"), "function");
});
