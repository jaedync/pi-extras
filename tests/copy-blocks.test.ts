import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import copyBlocks, { copyBlocksEnabled, latestReply, pickBlock } from "../lib/copy-blocks/index.ts";
import { DONE, LABEL } from "../lib/copy-blocks/draw.ts";
import { newRecorder, scan, taggedTheme } from "../lib/copy-blocks/scan.ts";
import { sourceBlocks, sourceCode } from "../lib/copy-blocks/source.ts";
import { COPIED_MS, installCopyBlocks, type CopyHost } from "../lib/copy-blocks/view.ts";
import { installThinkingTail } from "../lib/tool-display/thinking.ts";
import { forgetLate } from "../lib/late-rows.ts";
import { quiet } from "./support/quiet-theme.ts";

initTheme("dark");

const WIDTH = 50;
const said = (text: string) => ({ type: "text", text });
const message = (...content: object[]) => ({ role: "assistant", content, stopReason: "stop" }) as never;
const plain = (line: string) => stripTerminalSequences(line);
const REPLY = "Here:\n\n```ts\nconst a = 1;\n\tindented\n```\n\n> quote one\n> a second line long enough that it wraps at this width\n>\n> para2\n\n> short\n\nDone.";

function host(over: Partial<CopyHost> = {}): CopyHost & { copies: string[]; clock: { now: number } } {
	const copies: string[] = [];
	const clock = { now: 1_000 };
	return { enabled: () => true, clickable: () => true, theme: () => quiet() as never, copy: async (text) => { copies.push(text); }, failed: () => undefined, now: () => clock.now, copies, clock, ...over };
}

function click(component: { handleMouse?: (event: never) => unknown }, y: number, x: number) {
	return component.handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: WIDTH, height: 40 } as never);
}

const rowOf = (lines: readonly string[], text: string) => lines.findIndex((line) => plain(line).includes(text));

test("the tagged theme marks fences and quote lines, and scan strips the tags", () => {
	const recorder = newRecorder();
	const markdown = new Markdown("a\n\n```py\nx = 1\n```\n\n> q\n> r", 1, 0, taggedTheme(getMarkdownTheme(), recorder));
	recorder.pending = undefined;
	const raw = markdown.render(40);
	assert.deepEqual(recorder.pending, [{ code: "x = 1", lang: "py" }]);
	const { lines, blocks } = scan(raw);
	assert.ok(lines.every((line) => !line.includes("\x1b]7717;")));
	assert.deepEqual(blocks.map(({ kind, index, closed }) => ({ kind, index, closed })), [
		{ kind: "code", index: 0, closed: true },
		{ kind: "quote", index: 0, closed: true },
	]);
	const code = blocks[0]!;
	assert.equal(plain(lines[code.start]!).trim(), "```py");
	assert.equal(plain(lines[code.end]!).trim(), "```");
	assert.equal(lines.every((line) => visibleWidth(line) === 40), true);
});

test("a code block still streaming runs to the last row", () => {
	const { blocks } = scan(["x", "\x1b]7717;o0\x07```", "  code"]);
	assert.deepEqual(blocks, [{ kind: "code", start: 1, end: 2, index: 0, closed: false }]);
});

test("source blocks keep tabs, fence indentation rules and quote paragraphs", () => {
	const blocks = sourceBlocks("text\n\n```go\n\tfmt.Println()\n```\n\n> one\n> two\n>\n> three\n\n- item\n\n  ~~~\n  nested\n  ~~~\n\n```\nopen");
	assert.deepEqual(blocks, [
		{ kind: "code", text: "\tfmt.Println()" },
		{ kind: "quote", text: "one\ntwo\n\nthree" },
		{ kind: "code", text: "nested" },
		{ kind: "code", text: "open" },
	]);
	assert.equal(sourceCode("   fmt.Println()", blocks), "\tfmt.Println()");
	assert.equal(sourceCode("unmatched", blocks), "unmatched");
	assert.deepEqual(sourceBlocks("```\n> not a quote\n```"), [{ kind: "code", text: "> not a quote" }]);
});

test("a reply's code blocks and quotes draw as cards with copy labels a click copies exactly", async () => {
	const copy = host();
	const undo = installCopyBlocks(copy);
	try {
		const component = new AssistantMessageComponent(message(said(REPLY)), false);
		const lines = component.render(WIDTH);
		assert.ok(lines.every((line) => plain(line) === "" || visibleWidth(line) === WIDTH), "every line fills the width");
		const header = rowOf(lines, "ts");
		assert.ok(plain(lines[header]!).trimEnd().endsWith(LABEL), plain(lines[header]!));
		assert.ok(!lines.some((line) => plain(line).includes("```")), "fences become the card's header and foot");
		assert.ok(lines[header]!.includes("\x1b[48;2;"), "the card has a background");

		click(component, header, 5);
		await Promise.resolve();
		assert.deepEqual(copy.copies, ["const a = 1;\n\tindented"]);
		assert.ok(plain(component.render(WIDTH)[header]!).includes(DONE));
		copy.clock.now += COPIED_MS;
		assert.ok(!plain(component.render(WIDTH)[header]!).includes(DONE), "the label goes back");

		const quote = rowOf(lines, "quote one");
		assert.ok(plain(lines[quote]!).trimEnd().endsWith(LABEL));
		assert.equal(click(component, quote, 5), undefined, "only the label copies a quote, so text there can still be selected");
		click(component, quote, WIDTH - 3);
		const short = rowOf(lines, "short");
		click(component, short, WIDTH - 3);
		await Promise.resolve();
		assert.deepEqual(copy.copies.slice(1), ["quote one\na second line long enough that it wraps at this width\n\npara2", "short"]);
		assert.equal(click(component, rowOf(lines, "Done."), 3), undefined);
	} finally {
		undo();
	}
});

const labelRows = (lines: readonly string[]) => lines.flatMap((line, row) => (plain(line).trimEnd().endsWith(LABEL) ? [row] : []));

test("a tall code block has a copy label at each end, so one is in view from either end", async () => {
	const copy = host();
	const undo = installCopyBlocks(copy);
	try {
		const code = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
		const component = new AssistantMessageComponent(message(said(`Tall:\n\n\`\`\`sh\n${code}\n\`\`\`\n\nShort:\n\n\`\`\`sh\nls\n\`\`\``)), false);
		const lines = component.render(WIDTH);
		const header = rowOf(lines, "sh");
		const foot = rowOf(lines, "line 10") + 1;
		assert.deepEqual(labelRows(lines).slice(0, 2), [header, foot], "the header and the foot of the tall block");
		assert.equal(labelRows(lines).length, 3, "the one-line block keeps its header label only");
		click(component, foot, 5);
		await Promise.resolve();
		assert.deepEqual(copy.copies, [code], "the whole foot row copies, like the header");
		assert.ok(plain(component.render(WIDTH)[foot]!).includes(DONE));
		assert.ok(plain(component.render(WIDTH)[header]!).includes(DONE), "both ends say it was copied");
	} finally {
		undo();
	}
});

test("a tall quote has a copy label at each end, a row of its own when the last line has no room", async () => {
	const copy = host();
	const undo = installCopyBlocks(copy);
	try {
		const quoted = (last: string) => [...Array.from({ length: 9 }, (_, index) => `said ${index + 1}`), last];
		const roomy = new AssistantMessageComponent(message(said(quoted("the end").map((line) => `> ${line}`).join("\n"))), false);
		const lines = roomy.render(WIDTH);
		assert.deepEqual(labelRows(lines), [rowOf(lines, "said 1"), rowOf(lines, "the end")]);
		click(roomy, rowOf(lines, "the end"), WIDTH - 3);
		await Promise.resolve();
		assert.deepEqual(copy.copies, [quoted("the end").join("\n")]);

		const long = "y".repeat(WIDTH - 5);
		const cramped = new AssistantMessageComponent(message(said(quoted(long).map((line) => `> ${line}`).join("\n"))), false).render(WIDTH);
		assert.deepEqual(labelRows(cramped), [rowOf(cramped, "said 1"), rowOf(cramped, long) + 1]);
	} finally {
		undo();
	}
});

test("a code card inside a quote takes the clicks on its own rows", async () => {
	const copy = host();
	const undo = installCopyBlocks(copy);
	try {
		const code = Array.from({ length: 10 }, (_, index) => `step ${index + 1}`).join("\n");
		const quoted = ["As noted:", "```sh", ...code.split("\n"), "```"].map((line) => `> ${line}`).join("\n");
		const component = new AssistantMessageComponent(message(said(quoted)), false);
		const lines = component.render(WIDTH);
		const foot = rowOf(lines, "step 10") + 1;
		assert.ok(plain(lines[foot]!).trimEnd().endsWith(LABEL));
		click(component, foot, WIDTH - 3);
		await Promise.resolve();
		assert.deepEqual(copy.copies, [code], "the code card is drawn over the quote, so its label copies the code");
	} finally {
		undo();
	}
});

test("a tall quote whose first line is full takes its top label on a later line near the top", () => {
	const undo = installCopyBlocks(host());
	try {
		const full = "z".repeat(WIDTH - 5);
		const lines = new AssistantMessageComponent(message(said([full, ...Array.from({ length: 9 }, (_, index) => `said ${index + 1}`)].map((line) => `> ${line}`).join("\n"))), false).render(WIDTH);
		assert.deepEqual(labelRows(lines), [rowOf(lines, "said 1"), rowOf(lines, "said 9")]);
	} finally {
		undo();
	}
});

test("a tall quote full to the edge near its top gets a label row above it", async () => {
	const copy = host();
	const undo = installCopyBlocks(copy);
	try {
		const quoted = Array.from({ length: 10 }, (_, index) => `${"w".repeat(WIDTH - 8)} ${String(index).padStart(2, "0")}`);
		const component = new AssistantMessageComponent(message(said(quoted.map((line) => `> ${line}`).join("\n"))), false);
		const lines = component.render(WIDTH);
		const top = rowOf(lines, quoted[0]!) - 1;
		assert.deepEqual(labelRows(lines), [top, rowOf(lines, quoted[9]!) + 1]);
		assert.ok(plain(lines[top]!).trimStart().startsWith("│"), "the added row is part of the quote");
		click(component, top, WIDTH - 3);
		await Promise.resolve();
		assert.deepEqual(copy.copies, [quoted.join("\n")]);
	} finally {
		undo();
	}
});

test("a quote with no room for the label gets a row for it", async () => {
	const copy = host();
	const undo = installCopyBlocks(copy);
	try {
		const long = "x".repeat(WIDTH - 5);
		const component = new AssistantMessageComponent(message(said(`> ${long}`)), false);
		const lines = component.render(WIDTH);
		const row = rowOf(lines, LABEL);
		assert.equal(row, rowOf(lines, long) + 1);
		assert.ok(plain(lines[row]!).trimStart().startsWith("│"));
		click(component, row, WIDTH - 3);
		await Promise.resolve();
		assert.deepEqual(copy.copies, [long]);
	} finally {
		undo();
	}
});

test("without clicks the cards keep their background and drop the labels", () => {
	const undo = installCopyBlocks(host({ clickable: () => false }));
	try {
		const lines = new AssistantMessageComponent(message(said(REPLY)), false).render(WIDTH);
		assert.ok(!lines.some((line) => plain(line).includes(LABEL)));
		assert.ok(lines[rowOf(lines, "const a")]!.includes("\x1b[48;2;"));
	} finally {
		undo();
	}
});

test("undone, or with nothing to copy, replies stay exactly as Pi draws them", () => {
	const pi = new AssistantMessageComponent(message(said(REPLY)), false).render(WIDTH);
	const undo = installCopyBlocks(host());
	undo();
	assert.deepEqual(new AssistantMessageComponent(message(said(REPLY)), false).render(WIDTH), pi);
	const again = installCopyBlocks(host());
	try {
		const flat = message(said("no blocks here"));
		const before = new AssistantMessageComponent(flat, false);
		assert.equal(before.render(WIDTH).some((line) => line.includes("\x1b[48;")), false);
	} finally {
		again();
	}
});

test("a copy that fails reports it and takes the copied mark back", async () => {
	const errors: unknown[] = [];
	const copy = host({ copy: async () => { throw new Error("no clipboard"); }, failed: (error) => errors.push(error) });
	const undo = installCopyBlocks(copy);
	try {
		const component = new AssistantMessageComponent(message(said(REPLY)), false);
		const header = rowOf(component.render(WIDTH), "ts");
		click(component, header, 5);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal((errors[0] as Error).message, "no clipboard");
		assert.ok(!plain(component.render(WIDTH)[header]!).includes(DONE));
	} finally {
		undo();
	}
});

test("thinking tails and copy cards share the assistant message", async () => {
	const undoThinking = installThinkingTail({ mode: () => "tail", hiddenAtStart: () => false, theme: () => undefined });
	const copy = host();
	const undo = installCopyBlocks(copy);
	try {
		const component = new AssistantMessageComponent(message({ type: "thinking", thinking: "a\n\nb\n\nc\n\nd\n\ne" }, said("```\nx\n```")), false);
		const lines = component.render(WIDTH);
		assert.ok(lines.some((line) => plain(line).replace(/\u00a0/g, " ").trim() === "a · b · c · d · e"), "thinking is still drawn as a tail");
		click(component, rowOf(lines, LABEL), 5);
		await Promise.resolve();
		assert.deepEqual(copy.copies, ["x"]);
	} finally {
		undo();
		undoThinking();
	}
});

test("/copy-block copies the last block of the latest reply, or the nth", async () => {
	assert.equal(copyBlocksEnabled({ PI_COPY_BLOCKS: "off" }), false);
	assert.equal(copyBlocksEnabled({}), true);
	const entries = [
		{ type: "message", message: { role: "assistant", content: [said("```\nold\n```")] } },
		{ type: "message", message: { role: "assistant", content: [said("first\n\n```\none\n```"), said("> two")] } },
		{ type: "message", message: { role: "user", content: [said("```\nmine\n```")] } },
	];
	assert.equal(latestReply(entries), "first\n\n```\none\n```\n\n> two");
	const blocks = sourceBlocks(latestReply(entries)!);
	assert.deepEqual(pickBlock(blocks, ""), { block: { kind: "quote", text: "two" }, number: 2 });
	assert.deepEqual(pickBlock(blocks, "1"), { block: { kind: "code", text: "one" }, number: 1 });
	assert.match(pickBlock(blocks, "3") as string, /Usage/);
	assert.match(pickBlock([], "") as string, /no code blocks/);

	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const copies: string[] = [];
	const notes: string[] = [];
	copyBlocks({ on: () => undefined, registerCommand: (name: string, command: never) => commands.set(name, command) } as never, {
		env: {}, copy: async (text) => { copies.push(text); }, fullscreen: () => true,
	});
	await commands.get("copy-block")!.handler("1", { sessionManager: { getBranch: () => entries }, ui: { notify: (text: string) => notes.push(text) } });
	assert.deepEqual(copies, ["one"]);
	assert.deepEqual(notes, ["Copied code block 1."]);
});

test("a click in Pi's fullscreen transcript reaches the label", async () => {
	const { TuiAltScreen } = await import("@earendil-works/pi-tui");
	let input: (data: string) => void = () => undefined;
	const terminal = {
		columns: WIDTH, rows: 20, kittyProtocolActive: false,
		start(onInput: (data: string) => void) { input = onInput; },
		stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	} as never;
	const copy = host();
	const undo = installCopyBlocks(copy);
	const tui = new TuiAltScreen(terminal, false, undefined, {});
	try {
		const component = new AssistantMessageComponent(message(said("```sh\necho hi\n```")), false);
		tui.addChild(component);
		tui.start();
		tui.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 40));
		const header = rowOf(component.render(WIDTH), "sh");
		// SGR mouse reports are 1-based: a left press and release on the header.
		input(`\x1b[<0;6;${header + 1}M`);
		input(`\x1b[<0;6;${header + 1}m`);
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.deepEqual(copy.copies, ["echo hi"]);
	} finally {
		tui.stop();
		undo();
	}
});

test("Pi is asked to draw again once the copied mark is due to go", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let redraws = 0;
	const copy = host({ redraw: () => { redraws++; } });
	const undo = installCopyBlocks(copy);
	try {
		const component = new AssistantMessageComponent(message(said("```\nx\n```")), false);
		click(component, rowOf(component.render(WIDTH), LABEL), 5);
		assert.equal(redraws, 0);
		t.mock.timers.tick(COPIED_MS + 50);
		assert.equal(redraws, 1);
	} finally {
		undo();
	}
});

test("replies a reload builds before session start get their cards once it runs", async () => {
	forgetLate();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	copyBlocks({ on: (event: string, handler: never) => handlers.set(event, handler), registerCommand: () => undefined } as never, {
		env: {}, copy: async () => undefined, fullscreen: () => true,
	});
	const ctx = { mode: "tui", ui: { theme: quiet(), notify: () => undefined, setStatus: () => undefined } };
	const reply = new AssistantMessageComponent(message(said(REPLY)), false);
	assert.equal(rowOf(reply.render(WIDTH), LABEL), -1, "Pi's own drawing, before session start");
	try {
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		assert.ok(rowOf(reply.render(WIDTH), LABEL) >= 0, "cards once it runs");
	} finally {
		handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
	}
});
