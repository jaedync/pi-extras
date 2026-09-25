/**
 * shell-jobs unit tests: pure core and process layers, no Pi runtime needed.
 *
 *   node --test pi/tests/shell-jobs.test.ts
 *
 * The widget, renderer and live extension cases need Pi's TUI runtime and live
 * in shell-jobs-render.test.mts and shell-jobs-extension.test.mts.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOG_READ_BYTES,
	MAX_TITLE_BYTES,
	NOTIFY_TAIL_BYTES,
	PAYLOAD_CAP_BYTES,
	TAIL_WINDOW_BYTES,
	TEXT_BUDGET_BYTES,
	capPayload,
	commandPreview,
	countLogLines,
	formatJobId,
	isJobId,
	jobIdFor,
	MAX_JOB_ID,
	formatSize,
	jsonEscapedBytes,
	parseJobId,
	readLogPage,
	readLogTail,
	readLogWindow,
	resolveShellPath,
	sanitizeControl,
	tailText,
	validateManageParams,
	validateStartParams,
} from "../lib/shell-jobs-core.ts";
import {
	RESIDUAL_RECHECK_MS,
	discardLog,
	recordResidual,
	registry,
	scheduleResidualReaper,
	stopGroup,
} from "../lib/shell-jobs-process.ts";
import type { Runtime } from "../lib/shell-jobs-process.ts";

function contains(haystack: unknown, needle: unknown): void {
	assert.ok((haystack as { includes(value: unknown): boolean }).includes(needle),
		`expected ${JSON.stringify(haystack)} to contain ${JSON.stringify(needle)}`);
}

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "shell-jobs-test-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	// Tests that never fire session_shutdown would otherwise leave job log dirs behind.
	for (const runtime of registry().runtimes) {
		if (runtime.logDir !== null) rmSync(runtime.logDir, { recursive: true, force: true });
	}
	registry().runtimes.clear();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ids", () => {
	test("formats and parses monotonic short ids", () => {
		assert.strictEqual(formatJobId(1), "j1");
		assert.strictEqual(formatJobId(42), "j42");
		assert.strictEqual(parseJobId("j1"), 1);
		assert.strictEqual(parseJobId("j42"), 42);
		assert.strictEqual(parseJobId("j0"), null);
		assert.strictEqual(parseJobId("j01"), null);
		assert.strictEqual(parseJobId("j"), null);
		assert.strictEqual(parseJobId("x1"), null);
	});
	test("a job is named by its title, else by its program and what it runs", () => {
		const none = () => false;
		assert.strictEqual(jobIdFor("Run e2e tests!", "npx playwright test", none), "run-e2e-tests");
		assert.strictEqual(jobIdFor(null, "npm test", none), "npm-test");
		assert.strictEqual(jobIdFor(null, "npm run dev -- --port 3000", none), "npm-dev");
		assert.strictEqual(jobIdFor(null, "PORT=4000 node scripts/serve.mjs --watch", none), "node-serve");
		assert.strictEqual(jobIdFor(null, "sudo -E npx tsc -p . --watch", none), "tsc");
		assert.strictEqual(jobIdFor(null, "sleep 30 && echo done", none), "sleep-30");
		assert.strictEqual(jobIdFor("   ", "  ", none), "job");
		assert.strictEqual(jobIdFor("A very long title that keeps going and going", "x", none), "a-very-long-title-that");
		assert.ok(jobIdFor("x".repeat(80), "x", none).length <= MAX_JOB_ID);
	});
	test("a name already taken gets a number, and one that looks like an old id a prefix", () => {
		const taken = new Set(["npm-test", "npm-test-2"]);
		assert.strictEqual(jobIdFor(null, "npm test", (id) => taken.has(id)), "npm-test-3");
		assert.strictEqual(jobIdFor("J1", "x", () => false), "job-j1");
		for (const id of ["npm-test-3", "job-j1", "run-e2e-tests", "tsc"]) assert.ok(isJobId(id), id);
	});
});

describe("shell resolution", () => {
	test("prefers $SHELL and falls back to /bin/sh", () => {
		assert.strictEqual(resolveShellPath({ SHELL: "/bin/zsh" }), "/bin/zsh");
		assert.strictEqual(resolveShellPath({}), "/bin/sh");
		assert.strictEqual(resolveShellPath({ SHELL: "" }), "/bin/sh");
	});
});

describe("start validation", () => {
	test("rejects empty and oversized commands", () => {
		assert.strictEqual(validateStartParams({ command: "" }).ok, false);
		assert.strictEqual(validateStartParams({ command: "   " }).ok, false);
		assert.strictEqual(validateStartParams({ command: "x".repeat(65537) }).ok, false);
		assert.strictEqual(validateStartParams({ command: 42 }).ok, false);
	});
	test("accepts a command with optional cwd and preserves it verbatim", () => {
		const result = validateStartParams({ command: "  npm test  ", cwd: "/tmp" });
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.command, "  npm test  ");
			assert.strictEqual(result.cwd, "/tmp");
			assert.strictEqual("title" in result, false);
		}
	});
	test("flattens an optional title and rejects an empty or oversized one", () => {
		// A title is a one-line label, so whitespace runs collapse like a command preview.
		assert.deepStrictEqual(validateStartParams({ command: "make", title: "  Build\tthe\n  thing " }), {
			ok: true,
			command: "make",
			title: "Build the thing",
		});
		assert.deepStrictEqual(validateStartParams({ command: "make", title: "a\u001b[31mb" }), { ok: true, command: "make", title: "a[31mb" });
		assert.strictEqual(validateStartParams({ command: "make", title: "" }).ok, false);
		assert.strictEqual(validateStartParams({ command: "make", title: " \n " }).ok, false);
		assert.strictEqual(validateStartParams({ command: "make", title: 7 }).ok, false);
		assert.strictEqual(validateStartParams({ command: "make", title: "x\u0000y" }).ok, false);
		assert.strictEqual(validateStartParams({ command: "make", title: "x".repeat(MAX_TITLE_BYTES + 1) }).ok, false);
		assert.strictEqual(validateStartParams({ command: "make", title: "x".repeat(MAX_TITLE_BYTES) }).ok, true);
	});
});

describe("manage validation", () => {
	test("rejects unknown ops and missing ids", () => {
		assert.strictEqual(validateManageParams({ op: "nope" }).ok, false);
		assert.strictEqual(validateManageParams({ op: "logs" }).ok, false);
		assert.strictEqual(validateManageParams({ op: "kill" }).ok, false);
		for (const id of ["", "Run tests", "-x", "../etc/passwd", "a".repeat(33)]) assert.strictEqual(validateManageParams({ op: "logs", id }).ok, false, id);
		// Names from 0.6 on, and the numbered ids a resumed 0.5 session still mentions.
		for (const id of ["run-tests", "j1", "x"]) assert.strictEqual(validateManageParams({ op: "logs", id }).ok, true, id);
	});
	test("rejects offset together with tail", () => {
		assert.strictEqual(validateManageParams({ op: "logs", id: "j1", tail: true, offset: 5 }).ok, false);
	});
	test("applies log read defaults", () => {
		const result = validateManageParams({ op: "logs", id: "j1" });
		assert.strictEqual(result.ok, true);
		if (result.ok && result.params.op === "logs") {
			assert.strictEqual(result.params.bytes, LOG_READ_BYTES);
			assert.strictEqual(result.params.tail, true);
			assert.strictEqual(result.params.offset, 0);
		}
	});
	test("clamps list limit", () => {
		const result = validateManageParams({ op: "list" });
		assert.strictEqual(result.ok, true);
		if (result.ok && result.params.op === "list") assert.strictEqual(result.params.limit, 20);
	});
});

describe("tailText", () => {
	test("keeps the last N lines", () => {
		const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const result = tailText(text, NOTIFY_TAIL_BYTES, 30);
		assert.strictEqual((result.text.split("\n")).length, 30);
		assert.strictEqual(result.text.startsWith("line 10"), true);
		assert.strictEqual(result.truncated, true);
	});
	test("caps bytes without splitting a multibyte character", () => {
		const text = "é".repeat(4000);
		const result = tailText(text, 100, 30);
		assert.ok(Buffer.byteLength(result.text, "utf8") <= 100);
		assert.strictEqual(result.text.includes("\uFFFD"), false);
	});
	test("leaves short text untouched", () => {
		const result = tailText("hi", NOTIFY_TAIL_BYTES, 30);
		assert.strictEqual(result.text, "hi");
		assert.strictEqual(result.truncated, false);
	});
	test("drops a partial first line but keeps the final diagnostic", () => {
		const result = tailText(`${"x".repeat(5000)}\nFATAL: failed`, 4096, 30);
		contains(result.text, "FATAL: failed");
		assert.strictEqual(result.text, "FATAL: failed");
		assert.strictEqual(result.truncatedBy, "bytes");
	});
});

describe("capPayload", () => {
	test("caps oversized payloads and appends a notice", () => {
		const capped = capPayload("a".repeat(20000));
		assert.ok(Buffer.byteLength(capped, "utf8") <= PAYLOAD_CAP_BYTES);
		contains(capped, "truncated");
	});
	test("leaves small payloads untouched", () => {
		assert.strictEqual(capPayload("small"), "small");
	});
	test("holds the JSON-escaped size under the cap", () => {
		// Tabs double when serialized; a raw-byte check would let this exceed the cap.
		const capped = capPayload("\t".repeat(PAYLOAD_CAP_BYTES));
		contains(capped, "truncated");
		assert.ok(jsonEscapedBytes(capped) <= TEXT_BUDGET_BYTES);
	});
});

describe("sanitizeControl", () => {
	test("strips control bytes but keeps newlines and tabs", () => {
		assert.strictEqual(sanitizeControl("a\u0000b\u001bc\nd\te"), "abc\nd\te");
	});
});

describe("commandPreview", () => {
	test("flattens a script to one bounded line", () => {
		assert.strictEqual(commandPreview("  cd app &&\n\tmake \u001b[1mall\u001b[0m  \n", 200), "cd app && make [1mall[0m");
		assert.strictEqual(commandPreview("é".repeat(50), 9), "éééé");
	});
});

describe("readLogPage", () => {
	test("tails by default and reports offsets", () => {
		const dir = tempDir();
		const file = join(dir, "job.log");
		writeFileSync(file, "0123456789");
		const page = readLogPage(file, { offset: 0, bytes: 4, tail: true });
		assert.strictEqual(page.text, "6789");
		assert.strictEqual(page.nextOffset, 10);
		assert.strictEqual(page.eof, true);
	});
	test("reads forward from an offset", () => {
		const dir = tempDir();
		const file = join(dir, "job.log");
		writeFileSync(file, "0123456789");
		const first = readLogPage(file, { offset: 0, bytes: 4, tail: false });
		assert.strictEqual(first.text, "0123");
		assert.strictEqual(first.nextOffset, 4);
		assert.strictEqual(first.eof, false);
		const second = readLogPage(file, { offset: first.nextOffset, bytes: 4, tail: false });
		assert.strictEqual(second.text, "4567");
	});
});

describe("readLogWindow", () => {
	test("returns a short log whole and the tail of a long one from a line boundary", () => {
		const file = join(tempDir(), "w.log");
		writeFileSync(file, "alpha\nbeta\n");
		assert.deepStrictEqual(readLogWindow(file, 1024), { text: "alpha\nbeta\n", truncated: false, totalBytes: 11 });
		const rows = Array.from({ length: 50 }, (_, index) => `row ${index + 1}`).join("\n");
		writeFileSync(file, rows);
		const window = readLogWindow(file, 40);
		assert.strictEqual(window.truncated, true);
		assert.strictEqual(window.totalBytes, Buffer.byteLength(rows));
		// The leading partial line is dropped so every shown row is a real one.
		assert.match(window.text, /^row \d+\n/);
		assert.ok(window.text.endsWith("row 50"));
		assert.ok(Buffer.byteLength(window.text) <= 40);
		// A missing log reads as empty rather than throwing at render time.
		assert.deepStrictEqual(readLogWindow(join(tempDir(), "missing.log"), 40), { text: "", truncated: false, totalBytes: 0 });
	});
});

describe("readLogTail", () => {
	test("reports exact line numbers for a truncated tail", async () => {
		const file = join(tempDir(), "t.log");
		writeFileSync(file, `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
		const tail = await readLogTail(file, 4096, 30);
		assert.strictEqual(tail.text.startsWith("line 11"), true);
		assert.strictEqual(tail.truncated, true);
		assert.strictEqual(tail.totalLines, 40);
		assert.strictEqual(tail.notice, `[Showing lines 11-40 of 40. Full output: ${file}]`);
	});

	test("reports a byte limit when the budget, not the line count, cut the tail", async () => {
		const file = join(tempDir(), "t.log");
		writeFileSync(file, `${Array.from({ length: 60 }, () => "y".repeat(200)).join("\n")}\n`);
		const tail = await readLogTail(file, 512, 30);
		assert.strictEqual(tail.truncated, true);
		contains(tail.notice, "limit). Full output: ");
	});

	test("adds no notice when the whole log fits", async () => {
		const file = join(tempDir(), "t.log");
		writeFileSync(file, "a\nb\n");
		assert.deepStrictEqual(await readLogTail(file, 4096, 30), { text: "a\nb\n", truncated: false, notice: null, totalLines: 2 });
	});

	test("drops the partial first line of a mid-file window", async () => {
		const file = join(tempDir(), "t.log");
		writeFileSync(file, `${"z".repeat(TAIL_WINDOW_BYTES + 100)}\nlineA\nlineB\n`);
		const tail = await readLogTail(file, 4096, 30);
		assert.strictEqual(tail.text, "lineA\nlineB\n");
		assert.strictEqual(tail.totalLines, 3);
		assert.strictEqual(tail.notice, `[Showing lines 2-3 of 3. Full output: ${file}]`);
	});

	test("returns a partial last line rather than dropping the diagnostic", async () => {
		const file = join(tempDir(), "t.log");
		writeFileSync(file, `a\nb\n${"x".repeat(4000)}`);
		const tail = await readLogTail(file, 100, 30);
		assert.strictEqual(tail.text, "x".repeat(100));
		contains(tail.notice, "of line 3 (line is ");
	});

	test("counts lines and the final line size", async () => {
		const file = join(tempDir(), "t.log");
		writeFileSync(file, "a\nbb\nccc");
		assert.deepStrictEqual(await countLogLines(file), { totalLines: 3, lastLineBytes: 3 });
	});

	test("formats sizes like the built-in tools", () => {
		assert.strictEqual(formatSize(512), "512B");
		assert.strictEqual(formatSize(2048), "2.0KB");
		assert.strictEqual(formatSize(3 * 1024 * 1024), "3.0MB");
	});
});
describe("process layer", () => {
	test("discardLog closes the descriptor and removes the orphan file", () => {
		const dir = tempDir();
		const logPath = join(dir, "orphan.log");
		writeFileSync(logPath, "x");
		discardLog(logPath, null);
		assert.strictEqual(existsSync(logPath), false);
		assert.doesNotThrow(() => discardLog(logPath, null));
	});

	test("stopGroup reports an already-dead group as cleaned", async () => {
		const cleanup = await stopGroup(await deadPgid());
		assert.strictEqual(cleanup.cleaned, true);
	});

	test("recordResidual tracks and releases ownership", async () => {
		const runtime = makeRuntime(new Set());
		const pgid = await deadPgid();
		recordResidual(runtime, pgid, false);
		assert.strictEqual(runtime.residualPids.has(pgid), true);
		recordResidual(runtime, pgid, true);
		assert.strictEqual(runtime.residualPids.has(pgid), false);
	});

	test("the residual reaper releases a runtime once its groups are gone", async () => {
		const runtime = makeRuntime(new Set([await deadPgid()]));
		registry().runtimes.add(runtime);
		scheduleResidualReaper(runtime);
		assert.notStrictEqual(runtime.residualTimer, null);
		// A second call must not stack a second timer.
		scheduleResidualReaper(runtime);
		await sleep(RESIDUAL_RECHECK_MS + 400);
		assert.strictEqual(runtime.residualPids.size, 0);
		assert.strictEqual(runtime.residualTimer, null);
		assert.strictEqual(registry().runtimes.has(runtime), false);
	});
});

/** A detached group that has already exited, so its pgid no longer exists. */
async function deadPgid(): Promise<number> {
	const child = spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
	await once(child, "exit");
	return child.pid as number;
}
function makeRuntime(residualPids: Set<number>): Runtime {
	return {
		runtimeId: "test-runtime",
		jobs: new Map(),
		finals: new Map(),
		pendingPids: new Set(),
		residualPids,
		abandoned: 0,
		residualTimer: null,
		logDir: null,
		counter: 0,
		epoch: 0,
		pending: 0,
		closing: true,
		outbox: new Set(),
		delivery: null,
		// The reaper never touches the widget; a stub keeps this file free of pi-tui.
		widget: { attach() {}, update() {}, detach() {} },
	};
}
