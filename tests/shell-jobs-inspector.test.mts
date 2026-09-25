/**
 * shell-jobs inspector tests: the live job overlay.
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
import { cleanup, contains, doesNotContain, fakeTui, inspector, makeJob, sleep, tempDir, tui } from "./support/shell-jobs-harness.mts";

const { INSPECTOR_HEIGHT_SHARE, INSPECTOR_MIN_ROWS, INSPECTOR_REFRESH_MS, INSPECTOR_TAIL_BYTES, INSPECTOR_WIDTH, JobInspector, openInspector } = inspector;
const { stripTerminalSequences, visibleWidth } = tui;

afterEach(cleanup);

const plainTheme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
// A fixed clock: the elapsed time shown must not depend on how long the test took to get there.
const NOW = 1_800_000_000_000;

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

function open(live: ReturnType<typeof liveJob>, rows = 40) {
	const host = fakeTui(rows);
	const closes: number[] = [];
	const view = new JobInspector(host as any, plainTheme as any, live.lookup, () => closes.push(Date.now()), () => NOW);
	return { host, closes, view };
}

const bare = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

describe("job inspector", () => {
	test("frames the job: a band with the title, then id and pid, full command, cwd, log, output, footer", () => {
		const live = liveJob({ id: "run-unit-tests", command: "npm test -- --watchAll=false", cwd: "/repo", pid: 4321 });
		const { view } = open(live);
		const lines = bare(view.render(60));
		assert.ok(lines.every((line) => visibleWidth(line) <= 60), lines.join("\n"));
		// The band names the job by title and shows the elapsed time in its rail.
		contains(lines[1], "Run unit tests");
		contains(lines[1], "12.0s");
		// The id the model uses, dimmed beneath it.
		contains(lines[2], "run-unit-tests");
		contains(lines[2], "pid 4321");
		contains(lines[3], "$ npm test -- --watchAll=false");
		contains(lines[4], "cwd /repo");
		// A long temp path keeps its file name, so the start is what gets cut.
		contains(lines[5], "log ");
		contains(lines[5], "run-unit-tests.log");
		const text = lines.join("\n");
		contains(text, "one");
		contains(text, "three");
		for (const glyph of ["\u2713", "\u2717", "\u25cf"]) doesNotContain(text, glyph);
		contains(lines.at(-2), "esc close");
		// A rounded frame like pi's own overlays.
		assert.strictEqual(lines[0].startsWith("\u256d"), true);
		assert.strictEqual(lines.at(-1)!.startsWith("\u2570"), true);
		view.dispose();
	});

	test("an untitled job's band shows its command, and a finished one its exit in words", () => {
		const live = liveJob({ title: null, state: "done", code: 2, endedAt: NOW - 1000, startedAt: NOW - 6000 });
		const { view } = open(live);
		const lines = bare(view.render(60));
		contains(lines[1], "$ npm test");
		doesNotContain(lines[1], "Run unit tests");
		contains(lines[1], "exit 2");
		contains(lines[1], "5.0s");
		contains(lines[2], "exit 2 after 5s");
		view.dispose();
	});

	test("wraps long output and command lines instead of cutting them", () => {
		const long = `start ${"x".repeat(120)} end`;
		const live = liveJob({ command: `echo ${"y".repeat(90)} && true` }, [long]);
		const { view } = open(live);
		const text = bare(view.render(50)).join("\n");
		contains(text, "end");
		contains(text, "&& true");
		assert.ok(view.render(50).every((line) => visibleWidth(line) <= 50));
		view.dispose();
	});

	test("caps a very long command block and says how much it hid", () => {
		const script = Array.from({ length: 30 }, (_, index) => `step_${index + 1}`).join("\n");
		const live = liveJob({ command: script });
		const { view } = open(live);
		const text = bare(view.render(80)).join("\n");
		contains(text, "step_1");
		doesNotContain(text, "step_30");
		contains(text, "more lines");
		view.dispose();
	});

	test("sizes itself to a share of the terminal, never below the minimum", () => {
		const live = liveJob({}, Array.from({ length: 200 }, (_, index) => `line ${index + 1}`));
		const tall = open(live, 50).view;
		assert.strictEqual(tall.render(80).length, Math.floor(50 * INSPECTOR_HEIGHT_SHARE));
		const tiny = open(live, 6).view;
		assert.strictEqual(tiny.render(80).length, INSPECTOR_MIN_ROWS);
		tall.dispose();
		tiny.dispose();
	});

	test("follows the end while output grows, stops after a manual scroll, and resumes on End", () => {
		const live = liveJob({}, Array.from({ length: 100 }, (_, index) => `line ${index + 1}`));
		const { view, host } = open(live, 24);
		let text = bare(view.render(80)).join("\n");
		contains(text, "line 100");
		// Rows are padded, so the label is followed by a space rather than a newline.
		doesNotContain(text, "line 1 ");
		assert.strictEqual(view.following, true);
		view.handleInput("\u001b[A"); // up
		assert.strictEqual(view.following, false);
		text = bare(view.render(80)).join("\n");
		doesNotContain(text, "line 100");
		contains(text, "line 99");
		appendFileSync(live.logPath, "line 101\n");
		view.refresh();
		doesNotContain(bare(view.render(80)).join("\n"), "line 101");
		view.handleInput("\u001b[F"); // end
		assert.strictEqual(view.following, true);
		contains(bare(view.render(80)).join("\n"), "line 101");
		// Every key that moved the view asked for a repaint.
		assert.ok(host.renders.length >= 2);
		view.dispose();
	});

	test("page, home and vi keys move the viewport", () => {
		const live = liveJob({}, Array.from({ length: 100 }, (_, index) => `line ${index + 1}`));
		const { view } = open(live, 24);
		view.render(80);
		const atEnd = view.scrollTop;
		view.handleInput("\u001b[5~"); // page up
		assert.ok(view.scrollTop < atEnd);
		view.handleInput("\u001b[H"); // home
		assert.strictEqual(view.scrollTop, 0);
		contains(bare(view.render(80)).join("\n"), "line 1 ");
		view.handleInput("\u001b[6~"); // page down
		assert.ok(view.scrollTop > 0);
		view.handleInput("g");
		assert.strictEqual(view.scrollTop, 0);
		view.handleInput("G");
		assert.strictEqual(view.scrollTop, atEnd);
		view.handleInput("\u001b[B"); // down at the end stays put
		assert.strictEqual(view.scrollTop, atEnd);
		view.dispose();
	});

	test("the wheel scrolls and a click inside is swallowed", () => {
		const live = liveJob({}, Array.from({ length: 100 }, (_, index) => `line ${index + 1}`));
		const { view } = open(live, 24);
		view.render(80);
		const atEnd = view.scrollTop;
		const base = { button: "none" as const, x: 1, y: 1, screenX: 1, screenY: 1, width: 80, height: 24, shift: false, alt: false, ctrl: false };
		assert.deepStrictEqual(view.handleMouse({ ...base, type: "wheel", wheelDelta: -3 }), { handled: true });
		assert.strictEqual(view.scrollTop, atEnd - 3);
		assert.strictEqual(view.following, false);
		view.handleMouse({ ...base, type: "wheel", wheelDelta: 50 });
		assert.strictEqual(view.scrollTop, atEnd);
		assert.deepStrictEqual(view.handleMouse({ ...base, type: "click", button: "left" }), { handled: true });
		assert.strictEqual(view.handleMouse({ ...base, type: "move" }), undefined);
		view.dispose();
	});

	test("escape, q and ctrl+c close it once; dispose stops the timer", async () => {
		const live = liveJob();
		const { view, closes, host } = open(live);
		view.handleInput("q");
		view.handleInput("\u001b");
		view.handleInput("\u0003");
		assert.strictEqual(closes.length, 1);
		view.dispose();
		const seen = host.renders.length;
		appendFileSync(live.logPath, "late\n");
		await sleep(INSPECTOR_REFRESH_MS * 2 + 50);
		assert.strictEqual(host.renders.length, seen);
		// Refresh after dispose is a harmless no-op.
		view.refresh();
	});

	test("a left press outside closes it, and the transcript gets its clicks back once closed", () => {
		const live = liveJob();
		const reached: string[] = [];
		const host = { ...fakeTui(), dispatchMouseToLayout: (event: { type: string }) => { reached.push(event.type); return undefined; } };
		const closes: number[] = [];
		const view = new JobInspector(host as any, plainTheme as any, live.lookup, () => closes.push(1), () => NOW);
		const press = { type: "press", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 24 };
		const taken = host.dispatchMouseToLayout(press) as { handled?: boolean } | undefined;
		assert.strictEqual(taken?.handled, true);
		assert.strictEqual(closes.length, 1);
		host.dispatchMouseToLayout(press);
		assert.deepStrictEqual(reached, ["press"]);
		view.dispose();
	});

	test("the timer picks up new output while the job runs and rests once it is done", async () => {
		const live = liveJob();
		const { view, host } = open(live);
		appendFileSync(live.logPath, "fresh output\n");
		await sleep(INSPECTOR_REFRESH_MS * 2 + 50);
		contains(bare(view.render(80)).join("\n"), "fresh output");
		// A silent running job still repaints so the elapsed time ticks.
		const before = host.renders.length;
		await sleep(INSPECTOR_REFRESH_MS * 2 + 50);
		assert.ok(host.renders.length > before);
		live.set({ ...live.current!, state: "done", code: 0, endedAt: NOW });
		appendFileSync(live.logPath, "last words\n");
		await sleep(INSPECTOR_REFRESH_MS * 2 + 50);
		const text = bare(view.render(80)).join("\n");
		contains(text, "exit 0");
		contains(text, "last words");
		// Finished: the timer has stopped, so nothing repaints on its own.
		const settled = host.renders.length;
		await sleep(INSPECTOR_REFRESH_MS * 2 + 50);
		assert.strictEqual(host.renders.length, settled);
		view.dispose();
	});

	test("a job the runtime no longer tracks is reported, and its last output stays", () => {
		const live = liveJob();
		const { view } = open(live);
		view.render(80);
		live.set(undefined);
		view.refresh();
		const text = bare(view.render(80)).join("\n");
		contains(text, "no longer tracked");
		contains(text, "three");
		view.dispose();
	});

	test("marks the top when the window cut earlier output", () => {
		const filler = Array.from({ length: 4000 }, (_, index) => `row ${index + 1} ${"z".repeat(20)}`);
		const live = liveJob({}, filler);
		assert.ok(filler.join("\n").length > INSPECTOR_TAIL_BYTES);
		const { view } = open(live, 30);
		contains(bare(view.render(80)).join("\n"), "row 4000");
		view.handleInput("g");
		const text = bare(view.render(80)).join("\n");
		contains(text, "earlier output omitted");
		doesNotContain(text, "row 1 ");
		view.dispose();
	});

	test("an empty log says so", () => {
		const live = liveJob({}, []);
		const { view } = open(live);
		contains(bare(view.render(80)).join("\n"), "(no output yet)");
		live.set({ ...live.current!, state: "done", code: 0, endedAt: NOW });
		view.refresh();
		contains(bare(view.render(80)).join("\n"), "(no output)");
		view.dispose();
	});

	test("openInspector shows a centred overlay and resolves when it closes", async () => {
		const live = liveJob();
		const shown: Array<{ options: unknown }> = [];
		let component: any;
		const host = {
			custom(factory: any, options: unknown) {
				shown.push({ options });
				return new Promise<void>((resolve) => {
					component = factory(fakeTui(), plainTheme, {}, resolve);
				});
			},
			notify() {},
		};
		const opened = openInspector(host as any, live.lookup);
		assert.deepStrictEqual(shown[0].options, { overlay: true, overlayOptions: { anchor: "center", width: INSPECTOR_WIDTH, margin: 1 } });
		assert.ok(component instanceof JobInspector);
		component.handleInput("\u001b");
		await opened;
		component.dispose();
	});
});
