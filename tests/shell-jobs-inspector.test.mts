/**
 * shell-jobs inspector tests: the live job view, drawn by the shared sheet.
 *
 *   node --test pi/tests/shell-jobs-inspector.test.mts
 *
 * Not part of the `node --test pi/tests/*.test.ts` suite: the harness loads the
 * real modules through Pi's jiti aliases, so an installed Pi runtime is needed.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../lib/shell-jobs-process.ts";
import { cleanup, contains, doesNotContain, fakeTui, inspector, makeJob, sheet, sleep, tempDir, tui } from "./support/shell-jobs-harness.mts";
import { fgOf, quiet } from "./support/quiet-theme.ts";
import { factsOf, jobRow, liveRow } from "../lib/shell-jobs-band.ts";

const { INSPECTOR_TAIL_BYTES, JobView, openInspector } = inspector;
const { Sheet, SHEET_OVERLAY } = sheet;
const { stripTerminalSequences, visibleWidth } = tui;

afterEach(cleanup);

// A fixed clock: the elapsed time shown must not depend on how long the test took to get there.
const NOW = 1_800_000_000_000;
const FRAME_MS = 100;

/** A job whose log lives in a temp dir, plus a mutable lookup the inspector reads. */
function liveJob(overrides: Partial<Job> = {}, lines: string[] = ["one", "two", "three"]) {
	const logPath = join(tempDir(), "run-unit-tests.log");
	writeFileSync(logPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
	let job: Job | undefined = makeJob({ logPath, title: "Run unit tests", startedAt: NOW - 12_000, ...overrides });
	return {
		logPath,
		lookup: () => job,
		set(next: Job | undefined) {
			job = next;
		},
		get current() {
			return job;
		},
	};
}

function open(live: ReturnType<typeof liveJob>, rows = 40, columns = 80) {
	const host = fakeTui(rows, columns);
	const closes: number[] = [];
	const copied: string[] = [];
	const theme = quiet() as any;
	const view = new JobView(theme, live.lookup, () => NOW);
	const frame = new Sheet(host, theme, view, () => closes.push(Date.now()), { copy: async (text: string) => { copied.push(text); } });
	const lines = () => frame.render(columns).map((line: string) => stripTerminalSequences(line));
	return { host, closes, copied, view, frame, lines, text: () => lines().join("\n") };
}

describe("job inspector", () => {
	test("covers the terminal: named title, terminal row, facts, cwd, log, output and keys", () => {
		const live = liveJob({ id: "run-unit-tests", command: "npm test -- --watchAll=false", cwd: "/repo", pid: 4321 });
		const { lines, frame } = open(live);
		const shown = lines();
		assert.equal(shown.length, 40);
		assert.ok(shown.every((line) => visibleWidth(line) === 80), shown.join("\n"));
		assert.match(shown[0], /^ Run unit tests · shell job .*copy command {3}copy output {3}✕ $/);
		// The terminal row shows the command once, with title and live status at the right.
		contains(shown[1], "Run unit tests");
		contains(shown[1], "12.0s");
		contains(shown[2], "run-unit-tests");
		contains(shown[2], "pid 4321");
		contains(shown[1], "$ npm test -- --watchAll=false");
		doesNotContain(shown[1], "⇢ background");
		contains(shown[3], "cwd /repo");
		// A long temp path keeps its file name, so the start is what gets cut.
		contains(shown[4], "log ");
		contains(shown[4], "run-unit-tests.log");
		assert.match(shown[5], /^─ output ─+ 3 lines ─$/);
		assert.strictEqual(shown.filter((line) => line.includes("$ npm test")).length, 1);
		const text = shown.join("\n");
		contains(text, "one");
		contains(text, "three");
		assert.match(shown.at(-1)!, /^ esc close · ↑↓ scroll · c copy command · o copy output/);
		frame.dispose();
	});

	test("the inspector uses only a tool-colored title and a live band, not a darkened body", () => {
		const live = liveJob();
		const { view, frame } = open(live);
		assert.equal((view as { titleColor?: unknown }).titleColor, undefined, "the sheet's own tool-colored title");
		assert.equal(view.band(80), liveRow(quiet(), live.current!, { width: 80, now: NOW }));
		assert.match(frame.render(80)[1]!, /\x1b\[48;/, "the live row has a band background");
		frame.dispose();
	});

	test("a quiet job crawls in the inspector as it does above the editor", () => {
		const live = liveJob();
		const band = (lookup: () => { quiet?: boolean }) => new JobView(quiet() as never, live.lookup, () => NOW, () => "full", lookup).band(100);
		// The spinner in the margin is the line's first color: dim for the crawl, the accent while busy.
		const firstColor = (line: string) => /\x1b\[38;[\d;]*m/.exec(line)?.[0];
		assert.equal(firstColor(band(() => ({ quiet: true }))), fgOf("#5f5d58"));
		assert.equal(firstColor(band(() => ({}))), fgOf("#8fb4c8"));
	});

	test("the inspector band shares progress from the widget lookup and reverts to a still row when evicted", () => {
		const live = liveJob();
		const calls: Array<[Job, number]> = [];
		const view = new JobView(quiet() as never, live.lookup, () => NOW, () => "reduced", (job, now) => {
			calls.push([job, now]);
			return { progress: { share: .45, parts: ["31s left", "312M/690M"] } };
		});
		assert.match(stripTerminalSequences(view.band(100)), /45% · 31s left · 312M\/690M/);
		assert.deepEqual(calls, [[live.current, NOW]]);
		const last = live.current!;
		live.set(undefined);
		view.frame();
		assert.equal(view.band(100), jobRow(quiet(), factsOf(last), { width: 100, now: NOW }));
		assert.equal(calls.length, 1);
	});

	test("an untitled job's terminal row shows its command, final exit and elapsed time", () => {
		const live = liveJob({ title: null, state: "done", code: 2, endedAt: NOW - 1000, startedAt: NOW - 6000 });
		const { lines, frame } = open(live);
		const shown = lines();
		contains(shown[1], "$ npm test");
		doesNotContain(shown[1], "Run unit tests");
		contains(shown[1], "exit 2");
		contains(shown[1], "5.0s");
		contains(shown[2], "exit 2 after 5s");
		frame.dispose();
	});

	test("wraps long output and command lines instead of cutting them", () => {
		const long = `start ${"x".repeat(120)} end`;
		const live = liveJob({ command: `echo ${"y".repeat(90)} && true` }, [long]);
		const { text, lines, frame } = open(live, 40, 50);
		contains(text(), "end");
		assert.match(text(), /&&\s+true/);
		assert.ok(lines().every((line) => visibleWidth(line) === 50));
		frame.dispose();
	});

	test("caps a very long command block and says how much it hid", () => {
		const script = Array.from({ length: 30 }, (_, index) => `step_${index + 1}`).join("\n");
		const { text, frame } = open(liveJob({ command: script }));
		contains(text(), "step_1");
		doesNotContain(text(), "step_30");
		contains(text(), "more lines");
		frame.dispose();
	});

	test("on a short terminal the command gives way so the output keeps its rows", () => {
		const script = Array.from({ length: 30 }, (_, index) => `step_${index + 1}`).join("\n");
		const live = liveJob({ command: script }, Array.from({ length: 50 }, (_, index) => `line ${index + 1}`));
		const { lines, frame } = open(live, 14);
		const shown = lines();
		assert.equal(shown.length, 14);
		assert.ok(shown.filter((line) => /^ line \d+/.test(line)).length >= 3, shown.join("\n"));
		frame.dispose();
	});

	test("follows the end while output grows, stops after a manual scroll, and resumes on End", () => {
		const live = liveJob({}, Array.from({ length: 100 }, (_, index) => `line ${index + 1}`));
		const { text, frame } = open(live, 24);
		contains(text(), "line 100");
		doesNotContain(text(), "line 1 ");
		frame.handleInput("\u001b[A");
		doesNotContain(text(), "line 100");
		contains(text(), "line 99");
		appendFileSync(live.logPath, "line 101\n");
		doesNotContain(text(), "line 101");
		frame.handleInput("\u001b[F");
		contains(text(), "line 101");
		frame.dispose();
	});

	test("the timer picks up new output while the job runs and rests once it is done", async () => {
		const live = liveJob();
		const { host, text, frame } = open(live);
		text();
		appendFileSync(live.logPath, "fresh output\n");
		await sleep(FRAME_MS * 2 + 50);
		contains(text(), "fresh output");
		// A silent running job still repaints so the elapsed time ticks.
		const before = host.renders.length;
		await sleep(FRAME_MS * 2 + 50);
		assert.ok(host.renders.length > before);
		live.set({ ...live.current!, state: "done", code: 0, endedAt: NOW });
		appendFileSync(live.logPath, "last words\n");
		await sleep(FRAME_MS * 2 + 50);
		contains(text(), "exit 0");
		contains(text(), "last words");
		// One final frame settles the status, then a finished job stops repainting.
		await sleep(FRAME_MS * 2);
		const settled = host.renders.length;
		await sleep(FRAME_MS * 2 + 50);
		assert.strictEqual(host.renders.length, settled);
		frame.dispose();
	});

	test("a job the runtime no longer tracks is reported, and its last output stays", () => {
		const live = liveJob();
		const { text, frame } = open(live);
		text();
		live.set(undefined);
		contains(text(), "no longer tracked");
		contains(text(), "three");
		assert.equal(open(live).view.live(), false, "an untracked job does not keep the timer going");
		frame.dispose();
	});

	test("marks the top when the window cut earlier output", () => {
		const filler = Array.from({ length: 4000 }, (_, index) => `row ${index + 1} ${"z".repeat(20)}`);
		const live = liveJob({}, filler);
		assert.ok(filler.join("\n").length > INSPECTOR_TAIL_BYTES);
		const { text, lines, frame } = open(live, 30);
		contains(text(), "row 4000");
		assert.match(lines()[5], /output · last 64 KB/);
		frame.handleInput("g");
		contains(text(), "earlier output omitted");
		doesNotContain(text(), "row 1 ");
		frame.dispose();
	});

	test("an empty log says so", () => {
		const live = liveJob({}, []);
		const { text, frame } = open(live);
		contains(text(), "(no output yet)");
		live.set({ ...live.current!, state: "done", code: 0, endedAt: NOW });
		contains(text(), "(no output)");
		frame.dispose();
	});

	test("c copies the full command and o the whole log, past the window it shows", async () => {
		const filler = Array.from({ length: 4000 }, (_, index) => `row ${index + 1} ${"z".repeat(20)}`);
		const live = liveJob({ command: "make all\nmake test" }, filler);
		const { copied, frame } = open(live);
		frame.handleInput("c");
		frame.handleInput("o");
		await sleep(0);
		assert.equal(copied[0], "make all\nmake test");
		assert.ok(copied[1]!.startsWith("row 1 "), "the copy starts at the log's first line");
		assert.ok(copied[1]!.endsWith("row 4000 " + "z".repeat(20)));
		frame.dispose();
	});

	test("openInspector covers the terminal and resolves when it closes", async () => {
		const live = liveJob();
		const shown: Array<{ options: unknown }> = [];
		let component: any;
		const host = {
			custom(factory: any, options: unknown) {
				shown.push({ options });
				return new Promise<void>((resolve) => {
					component = factory(fakeTui(), quiet(), {}, resolve);
				});
			},
		};
		const opened = openInspector(host as any, live.lookup);
		const { onHandle, ...options } = shown[0].options as { onHandle: unknown };
		assert.deepStrictEqual(options, { overlay: true, overlayOptions: SHEET_OVERLAY });
		assert.strictEqual(typeof onHandle, "function", "Pi's overlay handle tells the view when it is off screen");
		assert.ok(component instanceof Sheet);
		assert.strictEqual(opened.isOpen(), true);
		component.handleInput("\u001b");
		await opened.closed;
		assert.strictEqual(opened.isOpen(), false);
	});
});
