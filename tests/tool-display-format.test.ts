import assert from "node:assert/strict";
import test from "node:test";
import { commandLines, diffStats, grepSummary, listSummary, parseShellOutput, readSummary } from "../lib/tool-display/format.ts";

test("a successful shell result keeps its output and drops the empty-output placeholder", () => {
	assert.deepEqual(parseShellOutput("hello\nworld", false), { body: "hello\nworld", outcome: { kind: "ok" } });
	assert.deepEqual(parseShellOutput("(no output)", false), { body: "", outcome: { kind: "ok" } });
	// Only a failed call carries a status line; on success the same words are output.
	assert.equal(parseShellOutput("x\n\nCommand exited with code 3", false).body, "x\n\nCommand exited with code 3");
});

test("a failed shell result moves its status and truncation notice out of the body", () => {
	assert.deepEqual(parseShellOutput("boom\n\nCommand exited with code 2", true), { body: "boom", outcome: { kind: "exit", code: 2 } });
	assert.deepEqual(parseShellOutput("Command exited with code 1", true), { body: "", outcome: { kind: "exit", code: 1 } });
	assert.deepEqual(parseShellOutput("partial\n\nCommand timed out after 120 seconds", true), { body: "partial", outcome: { kind: "timeout", seconds: 120 } });
	assert.deepEqual(parseShellOutput("Command aborted", true), { body: "", outcome: { kind: "aborted" } });
	assert.deepEqual(parseShellOutput("Command terminated without an exit code", true), { body: "", outcome: { kind: "killed" } });
	assert.deepEqual(parseShellOutput("tail\n\n[Showing lines 3-4 of 4. Full output: /tmp/pi-bash-1.log]\n\nCommand exited with code 1", true), {
		body: "tail",
		outcome: { kind: "exit", code: 1 },
		notice: "Showing lines 3-4 of 4. Full output: /tmp/pi-bash-1.log",
	});
	assert.deepEqual(parseShellOutput("tail\n\n[Showing lines 1-9 of 9 (50.0KB limit). Full output: /tmp/a b.log]", false), {
		body: "tail",
		outcome: { kind: "ok" },
		notice: "Showing lines 1-9 of 9 (50.0KB limit). Full output: /tmp/a b.log",
	});
	// An error that is not a shell status (a spawn failure) stays in the body.
	assert.deepEqual(parseShellOutput("spawn /bin/zsh ENOENT", true), { body: "spawn /bin/zsh ENOENT", outcome: { kind: "failed" } });
});

test("command lines are split, stripped of control bytes and have tabs expanded", () => {
	assert.deepEqual(commandLines("a\tb\r\nc\x1b[31m\n"), ["a  b", "c[31m"]);
	assert.deepEqual(commandLines(""), []);
	assert.deepEqual(commandLines("  \n  "), []);
});

test("diff stats count added and removed lines, not context", () => {
	const diff = [" 1 keep", "-2 old", "+2 new", "+3 more", "   ...", " 9 keep", "-10 gone"].join("\n");
	assert.deepEqual(diffStats(diff), { added: 2, removed: 2 });
	assert.deepEqual(diffStats("+ 9 padded\n- 9 padded"), { added: 1, removed: 1 });
	assert.deepEqual(diffStats(""), { added: 0, removed: 0 });
});

test("grep summaries count matches and distinct files, ignoring context lines and notices", () => {
	const out = ["src/a.ts:3: foo", "src/a.ts-4- ctx", "src/a.ts:9: foo", "lib/b:c.ts:1: foo", "", "[100 matches limit reached. Use limit=200 for more, or refine pattern]"].join("\n");
	assert.deepEqual(grepSummary(out), { matches: 3, files: 2, notice: "100 matches limit reached. Use limit=200 for more, or refine pattern" });
	assert.deepEqual(grepSummary("No matches found"), { matches: 0, files: 0 });
});

test("find and ls summaries count entries and directories", () => {
	assert.deepEqual(listSummary("a.ts\nb/\nc/\n"), { entries: 3, dirs: 2 });
	assert.deepEqual(listSummary("No files found matching pattern"), { entries: 0, dirs: 0 });
	assert.deepEqual(listSummary("(empty directory)"), { entries: 0, dirs: 0 });
	assert.deepEqual(listSummary("x\n\n[500 entries limit reached. Use limit=1000 for more]"), { entries: 1, dirs: 0, notice: "500 entries limit reached. Use limit=1000 for more" });
});

test("read summaries report lines shown and the file total when only part was read", () => {
	assert.deepEqual(readSummary("a\nb\nc\n"), { lines: 3 });
	assert.deepEqual(readSummary("a"), { lines: 1 });
	assert.deepEqual(readSummary("l1\nl2\n\n[Showing lines 1-2 of 5321. Use offset=3 to continue.]"), { lines: 2, total: 5321 });
	assert.deepEqual(readSummary("l\n\n[Showing lines 40-40 of 90 (50.0KB limit). Use offset=41 to continue.]"), { lines: 1, total: 90 });
	assert.deepEqual(readSummary("x\ny\n\n[88 more lines in file. Use offset=13 to continue.]"), { lines: 2, total: 100 });
	assert.deepEqual(readSummary("[Line 1 is 2.0MB, exceeds 50.0KB limit. Use bash: sed -n '1p' f | head -c 51200]"), { lines: 0, longLine: true });
});
