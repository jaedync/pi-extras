/**
 * pi-extras's full-screen views in Pi's real fullscreen TUI. Each one covers
 * the terminal and takes every click while it is up. However it goes away
 * (Esc, its close button, or Pi taking it off screen without closing it, as
 * /reload and session switches do), clicks and text selection in the
 * transcript must work afterwards, and its timer must stop. Text dragged
 * across it copies what it shows, and nothing of its frame.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { ShownOverlay } from "../lib/band/modal.ts";
import { openPopup, type PopupHost, type PopupSource } from "../lib/band/popup.ts";
import { openInspector, type InspectorHost } from "../lib/shell-jobs-inspector.ts";
import { openAgentInspector } from "../lib/subagents/inspector.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";
import { frameSubscribers, fullscreen } from "./support/fullscreen.ts";
import { cleanup, makeJob, tempDir } from "./support/shell-jobs-harness.mts";

afterEach(cleanup);

const OUTPUT = ["alpha one", "alpha two", "alpha three", "alpha four"];
const FRAME_MS = 100;

const running: PopupSource = {
	label: () => "bash",
	band: (_theme, width) => " $ npm test".padEnd(width),
	details: () => "in ~/proj",
	head: () => [],
	stepCount: () => 0,
	firstStep: () => 0,
	outputLabel: () => "output",
	output: () => OUTPUT,
	live: () => true,
};

const record: AgentRecord = { name: "surveyor", parent: "main", depth: 1, task: "Survey the files", model: "openai-codex/gpt-6-luna", readOnly: false,
	fork: false, blocking: false, state: "running", createdAt: 0, startedAt: Date.now(), activity: "thinking", toolCalls: 0, usage: NO_USAGE, runs: 1 };

const overlays: Record<string, (ui: unknown) => ShownOverlay> = {
	popup: (ui) => openPopup(ui as PopupHost, running),
	"job inspector": (ui) => {
		const logPath = join(tempDir(), "job.log");
		writeFileSync(logPath, `${OUTPUT.join("\n")}\n`);
		const job = makeJob({ logPath, title: "Run unit tests" });
		return openInspector(ui as InspectorHost, () => job);
	},
	"agent inspector": (ui) => openAgentInspector(ui as InspectorHost, {
		record: () => record,
		messages: () => [],
		send: async () => "sent",
		stop: async () => undefined,
	}),
};

// The counting line sits at x 2, y 2 (1-based); the close button is the title bar's last cell but one.
const COUNTER = [2, 2] as const;
const CLOSE = [99, 1] as const;

for (const [name, open] of Object.entries(overlays)) {
	test(`${name}: covers the whole terminal and takes every click while it is up`, async () => {
		const screen = fullscreen();
		try {
			const shown = open(screen.ui);
			await screen.settle();
			assert.equal(screen.tui.hasOverlay(), true);
			const rows = (screen.tui as unknown as { previousScreen: string[] }).previousScreen.map((line) => stripTerminalSequences(line));
			assert.equal(rows.length, 40);
			assert.ok(!rows.some((line) => line.includes("hello selectable world") || line.includes("click me")), "nothing of the transcript shows");
			await screen.click(...COUNTER);
			assert.equal(screen.counter.clicks, 0, "the transcript under it gets no clicks");
			assert.equal(shown.isOpen(), true, "a click on it doesn't close it");
		} finally {
			screen.stop();
		}
	});

	test(`${name}: closed with Esc, the transcript gets its clicks and selection back`, async () => {
		const screen = fullscreen();
		try {
			assert.equal(await screen.select(), true, "selection works before");
			const shown = open(screen.ui);
			await screen.settle();
			screen.key("\x1b");
			await shown.closed;
			await screen.settle();
			assert.equal(shown.isOpen(), false);
			assert.equal(await screen.select(), true, "selection works after");
			await screen.click(...COUNTER);
			assert.equal(screen.counter.clicks, 1);
			assert.equal(frameSubscribers(), 0, "its timer stopped");
		} finally {
			screen.stop();
		}
	});

	test(`${name}: its close button closes it, and the next click reaches the transcript`, async () => {
		const screen = fullscreen();
		try {
			const shown = open(screen.ui);
			await screen.settle();
			await screen.click(...CLOSE);
			await shown.closed;
			await screen.click(...COUNTER);
			assert.equal(screen.counter.clicks, 1);
			assert.equal(frameSubscribers(), 0);
		} finally {
			screen.stop();
		}
	});

	test(`${name}: taken off screen without being closed, it stops its timer and the transcript works`, async () => {
		const screen = fullscreen();
		try {
			const shown = open(screen.ui);
			await screen.settle();
			assert.ok(frameSubscribers() > 0, "it redraws while its call runs");
			// What Pi does to the top overlay on /reload and session switches: no done, no dispose.
			screen.tui.hideOverlay();
			await screen.settle(FRAME_MS * 3);
			assert.equal(frameSubscribers(), 0, "its timer stopped");
			assert.equal(shown.isOpen(), false, "one at a time no longer counts it");
			assert.equal(await screen.select(), true);
			await screen.click(...COUNTER);
			assert.equal(screen.counter.clicks, 1);
		} finally {
			screen.stop();
		}
	});
}

for (const name of ["popup", "job inspector"]) {
	test(`${name}: text dragged across its output copies what it shows, and nothing of its frame`, async () => {
		const screen = fullscreen();
		try {
			const shown = overlays[name]!(screen.ui);
			await screen.settle();
			const rows = (screen.tui as unknown as { previousScreen: string[] }).previousScreen.map((line) => stripTerminalSequences(line));
			const y = rows.findIndex((line) => line.includes("alpha one")) + 1;
			assert.ok(y > 0);
			// SGR reports are 1-based: from the "a" of "alpha one" to just past "alpha" two rows down.
			screen.mouse(0, 2, y, "M");
			screen.mouse(32, 4, y + 1, "M");
			screen.mouse(32, 7, y + 2, "M");
			screen.mouse(0, 7, y + 2, "m");
			await screen.settle();
			const selected = (screen.tui as unknown as { getActiveSelectionText(): string | undefined }).getActiveSelectionText();
			assert.equal(selected, "alpha one\n alpha two\n alpha");
			assert.equal(shown.isOpen(), true, "selecting doesn't close it");
		} finally {
			screen.stop();
		}
	});
}

test("a prompt that takes the keyboard while a view is up shows over the transcript, and the view comes back after", async () => {
	const screen = fullscreen();
	try {
		const shown = overlays.popup!(screen.ui);
		await screen.settle();
		const text = () => (screen.tui as unknown as { previousScreen: string[] }).previousScreen.map((line) => stripTerminalSequences(line)).join("\n");
		assert.match(text(), /alpha one/);
		// What Pi does for ui.select and ui.confirm: the prompt takes the editor's place and the keyboard.
		const prompt = new Text("Allow the agent to use Safari?", 0, 0);
		screen.tui.addChild(prompt);
		screen.tui.setFocus(prompt);
		await screen.settle();
		assert.match(text(), /Allow the agent to use Safari\?/, "the prompt is on screen");
		assert.doesNotMatch(text(), /alpha one/, "the view steps aside");
		assert.equal(shown.isOpen(), true, "it is still open");
		// The prompt is answered: Pi puts the editor back, and focus returns to the view.
		screen.tui.removeChild(prompt);
		screen.tui.setFocus(screen.counter as never);
		await screen.settle();
		assert.match(text(), /alpha one/, "the view is back");
		screen.key("\x1b");
		await shown.closed;
		assert.equal(shown.isOpen(), false, "and has the keyboard again: Esc closes it");
	} finally {
		screen.stop();
	}
});
