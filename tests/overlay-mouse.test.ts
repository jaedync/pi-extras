/**
 * What pi-extras's overlays leave behind in Pi's real fullscreen TUI. However
 * a popup or the job inspector goes away (Esc, a click outside, or Pi taking
 * it off screen without closing it, as /reload and session switches do),
 * clicks and text selection in the transcript must work afterwards, and its
 * timer must stop.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { openPopup, POPUP_FRAME_MS, type PopupHost, type PopupSource } from "../lib/band/popup.ts";
import type { ShownOverlay } from "../lib/band/modal.ts";
import { openInspector, type InspectorHost } from "../lib/shell-jobs-inspector.ts";
import { frameSubscribers, fullscreen } from "./support/fullscreen.ts";
import { cleanup, makeJob, tempDir } from "./support/shell-jobs-harness.mts";

afterEach(cleanup);

const running: PopupSource = {
	label: () => "bash",
	band: (_theme, width) => " $ npm test".padEnd(width),
	details: () => "in ~/proj",
	head: () => [],
	stepCount: () => 0,
	firstStep: () => 0,
	outputLabel: () => "output",
	output: () => ["one", "two"],
	live: () => true,
};

const overlays: Record<string, (ui: unknown) => ShownOverlay> = {
	popup: (ui) => openPopup(ui as PopupHost, running),
	inspector: (ui) => {
		const logPath = join(tempDir(), "job.log");
		writeFileSync(logPath, "one\ntwo\n");
		const job = makeJob({ logPath, title: "Run unit tests" });
		return openInspector(ui as InspectorHost, () => job);
	},
};

// The counting line sits at x 2, y 2; the overlays are centred with a margin, so row 1 and row 2 stay outside them.
const COUNTER = [2, 2] as const;

for (const [name, open] of Object.entries(overlays)) {
	test(`${name}: closed with Esc, the transcript gets its clicks and selection back`, async () => {
		const screen = fullscreen();
		try {
			assert.equal(await screen.select(), true, "selection works before");
			const shown = open(screen.ui);
			await screen.settle();
			assert.equal(shown.isOpen(), true);
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

	test(`${name}: a click outside closes it without clicking the transcript, and the next click gets through`, async () => {
		const screen = fullscreen();
		try {
			const shown = open(screen.ui);
			await screen.settle();
			await screen.click(...COUNTER);
			await shown.closed;
			assert.equal(screen.counter.clicks, 0, "the dismissing click stops at the popup's edge");
			await screen.click(...COUNTER);
			assert.equal(screen.counter.clicks, 1);
			assert.equal(await screen.select(), true);
		} finally {
			screen.stop();
		}
	});

	test(`${name}: taken off screen without being closed, it lets go of the mouse and stops its timer`, async () => {
		const screen = fullscreen();
		try {
			const shown = open(screen.ui);
			await screen.settle();
			assert.ok(frameSubscribers() > 0, "it redraws while its call runs");
			// What Pi does to the top overlay on /reload and session switches: no done, no dispose.
			screen.tui.hideOverlay();
			await screen.settle(POPUP_FRAME_MS * 3);
			assert.equal(frameSubscribers(), 0, "its timer stopped");
			assert.equal(shown.isOpen(), false, "one at a time no longer counts it");
			assert.equal(await screen.select(), true);
			await screen.click(...COUNTER);
			assert.equal(screen.counter.clicks, 1);
		} finally {
			screen.stop();
		}
	});

	test(`${name}: taken off screen without being closed, it leaves another overlay's clicks alone`, async () => {
		const screen = fullscreen();
		try {
			open(screen.ui);
			await screen.settle();
			screen.tui.hideOverlay();
			screen.tui.showOverlay(new Text("other", 0, 0), { anchor: "bottom-right", width: 10 });
			await screen.click(...COUNTER);
			assert.equal(screen.counter.clicks, 1, "a click outside the other overlay reaches the transcript");
		} finally {
			screen.stop();
		}
	});
}
