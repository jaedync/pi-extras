import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CANCEL_SHOW_MS, cancelLive, liveCompactionLines, liveShown, noteProgress, startLive } from "../lib/compaction-live.ts";
import { quiet } from "./support/quiet-theme.ts";

const theme = quiet();
const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

test("a compaction that runs shows a purple band with why, the size before and the time", () => {
	const live = startLive("threshold", 182_000, 1_000);
	const lines = plain(liveCompactionLines(live, 60, theme, 7_200, "full"));
	assert.equal(lines.length, 1, "Pi's own compaction sends no text, so there is nothing to preview");
	assert.match(lines[0]!, /^. compaction auto +182k   6\.2s$/);
});

test("a cache compaction shows the tokens so far and the newest 2 summary lines", () => {
	const summary = "## Goal\nShip the live rows.\n## Progress\nParts 2 and 3 are done and the review runs.";
	let live = startLive("manual", 182_000, 0);
	live = noteProgress(live, summary, summary.length, 3_000);
	const lines = plain(liveCompactionLines(live, 40, theme, 3_000, "full"));
	assert.match(plain(liveCompactionLines(live, 60, theme, 3_000, "full"))[0]!, new RegExp(`^. compaction manual +182k   ↓ ${Math.round(summary.length / 4)} tokens   3\\.0s$`));
	assert.deepEqual(lines.slice(1), ["    Parts 2 and 3 are done and the", "    review runs.▍"]);
	assert.ok(liveCompactionLines(live, 40, theme, 3_000, "full").every((line) => visibleWidth(line) <= 40));
	const hostile = noteProgress(startLive("manual", 1, 0), "a\x1b[2Jb", 7, 10);
	assert.ok(!liveCompactionLines(hostile, 40, theme, 10, "full").slice(1).join("").includes("\x1b[2J"), "model text cannot move the cursor");
});

test("a cancelled compaction turns gray, says so, and goes after a moment", () => {
	const live = cancelLive(noteProgress(startLive("threshold", 182_000, 0), "partial", 7, 1_000), 7_400);
	const lines = plain(liveCompactionLines(live, 60, theme, 8_000, "full"));
	assert.deepEqual(lines.length, 1, "no preview once cancelled");
	assert.match(lines[0]!, /^. compaction auto +cancelled   7\.4s$/);
	assert.equal(liveShown(live, 7_400 + CANCEL_SHOW_MS - 1), true);
	assert.equal(liveShown(live, 7_400 + CANCEL_SHOW_MS), false);
	assert.equal(liveShown(startLive("manual", 1, 0), 1e9), true, "a running one shows until it ends");
});
