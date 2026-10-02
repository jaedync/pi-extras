/**
 * shell-jobs widget and renderer tests.
 *
 *   node --test pi/tests/shell-jobs-render.test.mts
 *
 * Not part of the `node --test pi/tests/*.test.ts` suite: the harness loads the
 * real modules through Pi's jiti aliases, so an installed Pi runtime is needed.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { JOB_ANIMATION, JOB_STOPPING_ANIMATION, animationCycle } from "../lib/band/glyph.ts";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatDuration } from "../lib/shell-jobs-core.ts";
import { quiet, fgOf } from "./support/quiet-theme.ts";
import { colorOf } from "./support/tool-rows.ts";
import { liveRow } from "../lib/shell-jobs-band.ts";
import { METER_HOLD_MS } from "../lib/shell-jobs-progress.ts";
import {
	band,
	cleanup,
	contains,
	createFakePi,
	doesNotContain,
	fire,
	makeJob,
	render,
	shellJobs,
	tempDir,
	tui,
	widget,
} from "./support/shell-jobs-harness.mts";

const {
	QUIET_AFTER_MS,
	QUIET_FRAME_MS,
	SPINNER_FRAMES,
	STOPPING_FRAMES,
	WIDGET_MAX_ROWS,
	createJobsWidget,
	formatElapsed,
	frameAt,
	plainPaint,
	renderJobLines,
	selectRows,
} = widget;
const { completionView, renderStartResult, splitCompletionText } = render;
const { stripTerminalSequences, visibleWidth } = tui;
const bare = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

afterEach(cleanup);

describe("job widget", () => {
	test("renders nothing when there is no visible job", () => {
		assert.deepStrictEqual(renderJobLines([], 1000, plainPaint), []);
		assert.deepStrictEqual(renderJobLines([makeJob({ state: "done", code: 0, attempts: 1, delivered: true, endedAt: 2000 })], 1000, plainPaint), []);
	});

	test("renders a running job with spinner, id, elapsed and command", () => {
		const lines = renderJobLines([makeJob()], 13000, plainPaint);
		assert.deepStrictEqual(lines, [`${frameAt(SPINNER_FRAMES, 13000)}  j1  12s    npm test -- --watchAll=false`]);
	});

	test("spinners honor the shared glyph duration table and share a phase", () => {
		assert.strictEqual(frameAt(SPINNER_FRAMES, 0), SPINNER_FRAMES[0]);
		assert.strictEqual(frameAt(SPINNER_FRAMES, JOB_ANIMATION.durationsMs[0]! - 1), SPINNER_FRAMES[0]);
		assert.strictEqual(frameAt(SPINNER_FRAMES, JOB_ANIMATION.durationsMs[0]!), SPINNER_FRAMES[1]);
		assert.strictEqual(frameAt(SPINNER_FRAMES, animationCycle(JOB_ANIMATION)), SPINNER_FRAMES[0]);
		assert.strictEqual(frameAt(STOPPING_FRAMES, JOB_STOPPING_ANIMATION.durationsMs[0]!), STOPPING_FRAMES[1]);
		// The quiet crawl advances once per QUIET_FRAME_MS instead of once per tick.
		assert.strictEqual(frameAt(SPINNER_FRAMES, QUIET_FRAME_MS - 1, QUIET_FRAME_MS), SPINNER_FRAMES[0]);
		assert.strictEqual(frameAt(SPINNER_FRAMES, QUIET_FRAME_MS, QUIET_FRAME_MS), SPINNER_FRAMES[1]);
		// Two running rows painted in the same tick show the same frame.
		const lines = renderJobLines([makeJob({ id: "j1" }), makeJob({ id: "j2" })], 7250, plainPaint);
		assert.strictEqual(lines[0][0], lines[1][0]);
	});

	test("the spinner alone carries activity: accent at full speed while output flows, a dim crawl once quiet", () => {
		// Picked so the full-speed and crawl frames differ at this instant.
		const now = 100_750;
		const job = makeJob({ startedAt: 1000 });
		const keys: string[] = [];
		const paint = (key: string, text: string) => {
			keys.push(key);
			return text;
		};
		const fresh = renderJobLines([job], now, paint, () => ({ bytes: 4300, changedAt: now - 2000 }));
		assert.deepStrictEqual(fresh, [`${frameAt(SPINNER_FRAMES, now)}  j1  1m39s  npm test -- --watchAll=false`]);
		assert.strictEqual(keys[0], "accent");
		keys.length = 0;
		const stalled = renderJobLines([job], now, paint, () => ({ bytes: 4300, changedAt: now - QUIET_AFTER_MS }));
		assert.deepStrictEqual(stalled, [`${frameAt(SPINNER_FRAMES, now, QUIET_FRAME_MS)}  j1  1m39s  npm test -- --watchAll=false`]);
		assert.strictEqual(keys[0], "dim");
		assert.notStrictEqual(fresh[0][0], stalled[0][0]);
		// Only the glyph and its colour change; no size, no label, so columns never move.
		assert.strictEqual(fresh[0].slice(1), stalled[0].slice(1));
		// A job that never printed is quiet from its start.
		keys.length = 0;
		renderJobLines([job], now, paint, () => ({ bytes: 0, changedAt: 1000 }));
		assert.strictEqual(keys[0], "dim");
		// No sample yet reads the same as fresh output, never as quiet.
		assert.deepStrictEqual(renderJobLines([job], now, plainPaint), fresh);
	});

	test("a titled job shows its title first and the command after it, muted", () => {
		const keys: string[] = [];
		const paint = (key: string, text: string) => {
			keys.push(key);
			return text;
		};
		const titled = makeJob({ title: "Run unit tests" });
		assert.deepStrictEqual(renderJobLines([titled], 13000, paint), [`${frameAt(SPINNER_FRAMES, 13000)}  j1  12s    Run unit tests  npm test -- --watchAll=false`]);
		// icon, id, elapsed, then the command demoted behind the title.
		assert.deepStrictEqual(keys, ["accent", "accent", "muted", "muted"]);
		// A job parked by an older version has no title field at all.
		const legacy = makeJob();
		delete (legacy as { title?: unknown }).title;
		assert.deepStrictEqual(renderJobLines([legacy], 13000, plainPaint), [`${frameAt(SPINNER_FRAMES, 13000)}  j1  12s    npm test -- --watchAll=false`]);
		assert.deepStrictEqual(renderJobLines([makeJob({ title: "Say one" })], null, plainPaint), ["●  j1  Say one  npm test -- --watchAll=false"]);
	});

	test("RPC rows are static: no elapsed, no spinner, no activity", () => {
		const lines = renderJobLines([makeJob()], null, plainPaint, () => ({ bytes: 4300, changedAt: 0 }));
		assert.deepStrictEqual(lines, ["●  j1  npm test -- --watchAll=false"]);
		assert.deepStrictEqual(renderJobLines([makeJob({ state: "stopping" })], null, plainPaint), [`${JOB_STOPPING_ANIMATION.frames[0]}  j1  stopping  npm test -- --watchAll=false`]);
	});

	test("shows group teardown and death-by-signal with their own markers", () => {
		const stopping = makeJob({ state: "stopping", endedAt: null });
		const killed = makeJob({ id: "j2", state: "done", signal: "SIGKILL", endedAt: 9000, attempts: 1 });
		assert.deepStrictEqual(renderJobLines([stopping], 6000, plainPaint), [`${frameAt(STOPPING_FRAMES, 6000)}  j1  5s     stopping  npm test -- --watchAll=false`]);
		// A finished row settles: no frame, the outcome glyph, and nothing animates.
		assert.deepStrictEqual(renderJobLines([killed], 6000, plainPaint), ["✗  j2  8s     signal SIGKILL · pending  npm test -- --watchAll=false"]);
		assert.deepStrictEqual(renderJobLines([killed], 6250, plainPaint), renderJobLines([killed], 6000, plainPaint));
	});

	test("hides a job once its completion is delivered", () => {
		const delivered = makeJob({ state: "done", code: 0, endedAt: 9000, attempts: 1, delivered: true });
		const killed = makeJob({ id: "j2", state: "done", signal: "SIGTERM", endedAt: 9000, claimed: true });
		assert.deepStrictEqual(renderJobLines([delivered, killed], 6000, plainPaint), []);
	});

	test("marks a finished job whose completion is still pending", () => {
		const job = makeJob({ state: "done", code: 0, attempts: 1, startedAt: 1000, endedAt: 4000, command: "sleep 3; echo done" });
		assert.deepStrictEqual(renderJobLines([job], 90000, plainPaint), ["✓  j1  3s     exit 0 · pending  sleep 3; echo done"]);
	});

	test("marks a failed delivery with the warning colour and label", () => {
		const job = makeJob({ state: "done", code: 1, attempts: 3, deliveryFailed: true, startedAt: 1000, endedAt: 42000, command: "cargo build --release" });
		const keys: string[] = [];
		const paint = (key: string, text: string) => {
			keys.push(key);
			return text;
		};
		assert.deepStrictEqual(renderJobLines([job], 90000, paint), ["✗  j1  41s    exit 1 · not delivered  cargo build --release"]);
		contains(keys, "warning");
	});

	test("keeps running and pending jobs on separate rows", () => {
		const running = makeJob({ id: "j1", startedAt: 1000 });
		const pending = makeJob({ id: "j3", state: "done", code: 0, attempts: 1, startedAt: 1000, endedAt: 4000, command: "sleep 3; echo done" });
		const lines = renderJobLines([running, pending], 65000, plainPaint);
		assert.strictEqual((lines).length, 2);
		contains(lines[0], "1m04s");
		contains(lines[1], "exit 0 · pending");
	});

	test("pads ids so the columns line up", () => {
		const lines = renderJobLines([makeJob({ id: "j1" }), makeJob({ id: "j10" })], 1000, plainPaint);
		const frame = frameAt(SPINNER_FRAMES, 1000);
		assert.strictEqual(lines[0].startsWith(`${frame}  j1   `), true);
		assert.strictEqual(lines[1].startsWith(`${frame}  j10  `), true);
	});

	test("caps rows and counts what it hid", () => {
		const jobs = Array.from({ length: 6 }, (_, i) => makeJob({ id: `j${i + 1}` }));
		const lines = renderJobLines(jobs, 1000, plainPaint);
		assert.strictEqual((lines).length, WIDGET_MAX_ROWS + 1);
		assert.strictEqual(lines.at(-1), "+2 more");
	});

	test("never drops a failed delivery in favour of a running job", () => {
		const failed = Array.from({ length: 5 }, (_, i) =>
			makeJob({ id: `j${i + 1}`, state: "done", code: 1, attempts: 3, deliveryFailed: true, endedAt: 2000 }),
		);
		const { rows, hidden } = selectRows([makeJob({ id: "j99" }), ...failed]);
		assert.strictEqual(rows.every((job) => job.deliveryFailed), true);
		assert.strictEqual((rows).length, WIDGET_MAX_ROWS);
		assert.strictEqual(hidden, 2);
	});

	test("formats elapsed times compactly", () => {
		assert.strictEqual(formatElapsed(0), "0s");
		assert.strictEqual(formatElapsed(65000), "1m05s");
		assert.strictEqual(formatElapsed(3 * 3600_000 + 120_000), "3h02m");
	});

	test("keeps a multi-line command on one row", () => {
		// A newline inside a widget line would add a row the layout never counted,
		// and an escape byte would leak terminal state into the editor.
		const job = makeJob({ command: "cd app &&\n\tmake \u001b[31mall\u001b[0m\n" });
		assert.deepStrictEqual(renderJobLines([job], 2000, plainPaint), [`${frameAt(SPINNER_FRAMES, 2000)}  j1  1s     cd app && make [31mall[0m`]);
	});

	test("the TUI widget draws one live band per job, title then command and progress", async () => {
		const app = createFakePi([], "tui");
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "sleep 30" }, undefined, undefined, app.ctx);
		await app.tools.get("shell_job_start").execute("t2", { command: "sleep 31", title: "Nap" }, undefined, undefined, app.ctx);
		const factory = app.widgets.at(-1)?.value as (host: unknown, theme: unknown) => { render(width: number): string[] };
		const lines = factory({ requestRender: () => {} }, quiet()).render(40).map((line) => stripTerminalSequences(line));
		// Pi puts the blank line above widgets itself.
		assert.strictEqual(lines.length, 2);
		contains(lines[0], "$ sleep 30");
		contains(lines[1], "Nap  $ sleep 31");
		contains(lines[0], "%");
		doesNotContain(lines[0], "Nap");
		for (const line of lines) assert.ok(visibleWidth(line) <= 40, line);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("widget progress uses the sampled meter before sleep, with bare percentages only after a rise", (t) => {
		const now = 1_800_000_000_000;
		t.mock.timers.enable({ apis: ["Date"], now });
		const dir = tempDir();
		const meterLog = join(dir, "meter.log"), sleepLog = join(dir, "sleep.log"), bareLog = join(dir, "bare.log");
		writeFileSync(meterLog, "45 690M 45 312M 0 0 10M 0 0:01:09 0:00:38 0:00:31 10M\n");
		writeFileSync(sleepLog, "");
		writeFileSync(bareLog, "coverage 20%\n");
		const meter = makeJob({ id: "meter", command: "sleep 30; curl", logPath: meterLog, startedAt: now - 15_000 });
		const sleeping = makeJob({ id: "sleep", command: "sleep 30", logPath: sleepLog, startedAt: now - 15_000 });
		const bareJob = makeJob({ id: "bare", command: "build", logPath: bareLog, startedAt: now - 1000 });
		const jobs = [meter, sleeping, bareJob];
		let factory: any;
		const jobsWidget = createJobsWidget();
		try {
			jobsWidget.attach({ setWidget: (_id, content) => { factory = content; } }, true, () => jobs);
			assert.deepStrictEqual(jobsWidget.progressOf(meter, now), { share: .45, parts: ["31s left", "312M/690M", "10M/s"] });
			assert.deepStrictEqual(jobsWidget.progressOf(sleeping, now), { share: .5, parts: ["15s left"] });
			assert.strictEqual(jobsWidget.progressOf(sleeping, now + 15_000), undefined);
			assert.strictEqual(jobsWidget.progressOf(bareJob, now), undefined);
			const component = factory({ requestRender() {} }, quiet());
			const lines = bare(component.render(120));
			contains(lines[0], "45% · 31s left · 312M/690M · 10M/s");
			doesNotContain(lines[0], "▸");
			contains(lines[1], "50% · 15s left");
			contains(lines[2], "▸ coverage 20%");
			appendFileSync(bareLog, "coverage 20%\n");
			jobsWidget.update();
			assert.strictEqual(jobsWidget.progressOf(bareJob, now), undefined);
			appendFileSync(bareLog, "progress 21%\n");
			jobsWidget.update();
			assert.deepStrictEqual(jobsWidget.progressOf(bareJob, now), { share: .21, parts: [] });
			contains(bare(component.render(120))[2], "21%");
			doesNotContain(bare(component.render(120))[2], "▸");
			appendFileSync(bareLog, "plain output\n");
			jobsWidget.update();
			// The bar holds through a line between updates, then gives way to the output line.
			assert.deepStrictEqual(jobsWidget.progressOf(bareJob, now), { share: .21, parts: [] });
			assert.strictEqual(jobsWidget.progressOf(bareJob, now + METER_HOLD_MS), undefined);
			t.mock.timers.tick(METER_HOLD_MS);
			contains(bare(component.render(120))[2], "▸ plain output");
			for (const state of ["done", "stopping"] as const) assert.strictEqual(jobsWidget.progressOf({ ...meter, state }, now), undefined);
		} finally { jobsWidget.detach(); }
	});

	test("TUI rows cap at four, order failed delivery then oldest live then pending, and click by row", (t) => {
		const now = 1_800_000_000_000;
		t.mock.timers.enable({ apis: ["Date"], now });
		let jobs = [
			makeJob({ id: "pending", title: "Pending", state: "done", code: 0, attempts: 1, endedAt: now - 1000 }),
			makeJob({ id: "new", title: "Newest", startedAt: now - 1000 }),
			makeJob({ id: "old", title: "Older", startedAt: now - 5000 }),
			makeJob({ id: "lost", title: "Lost", state: "done", deliveryFailed: true, endedAt: now - 2000 }),
		];
		let factory: any;
		const selected: string[] = [];
		const jobsWidget = createJobsWidget();
		try {
			jobsWidget.attach({ setWidget: (_id, content) => { factory = content; } }, true, () => jobs, (job) => selected.push(job.id));
			const component = factory({ requestRender() {} }, quiet());
			const lines = component.render(100);
			assert.strictEqual(lines.length, 4);
			for (const [index, title] of ["Lost", "Older", "Newest", "Pending"].entries()) {
				contains(bare(lines)[index], title);
				assert.match(lines[index]!, /\x1b\[48;/);
				assert.deepStrictEqual(component.handleMouse({ type: "click", button: "left", y: index }), { handled: true });
			}
			assert.deepStrictEqual(selected, ["lost", "old", "new", "pending"]);
			jobs = [...jobs, makeJob({ id: "fifth" }), makeJob({ id: "sixth" })];
			const capped = component.render(100);
			assert.strictEqual(capped.length, WIDGET_MAX_ROWS + 1);
			assert.strictEqual(bare(capped).at(-1), "  +2 more");
			contains(bare(capped)[0], "Lost");
			assert.strictEqual(colorOf(capped.at(-1)!, "+2 more"), fgOf("#5f5d58"));
			for (const y of [-1, 4, 99]) assert.strictEqual(component.handleMouse({ type: "click", button: "left", y }), undefined);
			assert.strictEqual(component.handleMouse({ type: "move", button: "left", y: 0 }), undefined);
			assert.strictEqual(component.handleMouse({ type: "click", button: "right", y: 0 }), undefined);
		} finally { jobsWidget.detach(); }
	});

	test("widget reads reduced motion each render and holds its running spinner still", (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
		let factory: any;
		let motion: "full" | "reduced" = "reduced";
		const jobsWidget = createJobsWidget(() => motion);
		try {
			jobsWidget.attach({ setWidget: (_id, content) => { factory = content; } }, true, () => [makeJob()]);
			const component = factory({ requestRender() {} }, quiet());
			const first = bare(component.render(80))[0]![0];
			t.mock.timers.tick(JOB_ANIMATION.durationsMs[0]!);
			assert.strictEqual(bare(component.render(80))[0]![0], first);
			motion = "full";
			assert.strictEqual(bare(component.render(80))[0]![0], frameAt(SPINNER_FRAMES, Date.now()));
		} finally { jobsWidget.detach(); }
	});

	test("sampling dates a silent log from the job start and a written log from its growth", (t) => {
		const now = 1_800_000_000_000;
		t.mock.timers.enable({ apis: ["Date"], now });
		const dir = tempDir();
		const silentLog = join(dir, "j1.log");
		const busyLog = join(dir, "j2.log");
		writeFileSync(silentLog, "");
		writeFileSync(busyLog, "hello from the live log\n");
		const startedAt = now - QUIET_AFTER_MS - 1000;
		const jobs = [makeJob({ id: "j1", logPath: silentLog, startedAt }), makeJob({ id: "j2", logPath: busyLog, startedAt })];
		type Factory = (host: unknown, theme: unknown) => { render(width: number): string[] };
		let factory: Factory | undefined;
		const jobsWidget = createJobsWidget();
		jobsWidget.attach({ setWidget: (_id, content) => { factory = content as Factory; } }, true, () => jobs);
		const theme = quiet();
		const component = factory!({ requestRender: () => {} }, theme);
		const lines = component.render(80);
		// A silent log is quiet from its start; a written log has a fresh sample and tail.
		const bands = (busyQuiet: boolean) => jobs.map((job) => liveRow(theme, job, { width: 80, now, ...(job.id === "j2" ? { tail: "hello from the live log" } : {}), quiet: job.id === "j1" || busyQuiet }));
		assert.deepStrictEqual(lines, bands(false));
		assert.notStrictEqual(bands(true)[1], bands(false)[1]);
		assert.strictEqual(colorOf(lines[0]!, frameAt(SPINNER_FRAMES, now, QUIET_FRAME_MS)), fgOf("#5f5d58"));
		contains(bare(lines)[1], "▸ hello from the live log");
		appendFileSync(busyLog, "newest output from the live log\n");
		jobsWidget.update();
		const grown = bare(component.render(80))[1]!;
		contains(grown, "▸ newest output from the live log");
		doesNotContain(grown, "hello from the live log");
		// Colored output reaches the band as its words, not as leftover codes.
		appendFileSync(busyLog, "\x1b[32m✓\x1b[39m 212 passing\n");
		jobsWidget.update();
		const colored = bare(component.render(120))[1]!;
		contains(colored, "▸ ✓ 212 passing");
		doesNotContain(colored, "[32m");
		// A progress bar redrawn in place, with no newline in the window read, still shows.
		appendFileSync(busyLog, `\r[${"=".repeat(3000)}`);
		jobsWidget.update();
		contains(bare(component.render(120))[1]!, "▸ ====");
		// A window with nothing to show keeps the line shown before.
		appendFileSync(busyLog, `\n${" ".repeat(3000)}`);
		jobsWidget.update();
		contains(bare(component.render(120))[1]!, "▸ ====");
		jobsWidget.detach();
	});
});
const plainTheme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
function completionMessage(body: string, details: Record<string, unknown>) {
	return {
		customType: "shell-job-complete",
		content: `Job j1 finished: exit 0 after 12.1s\nlog: /tmp/j1.log\n\n${body}\n\n[Showing lines 11-20 of 20. Full output: /tmp/j1.log]`,
		details,
	};
}
const plainRender = { expanded: false, outputPad: 1 };
describe("job rendering", () => {
	test("a start row shows its command followed closely by title and status", () => {
		const row = (args: unknown, context?: object) => bare(render.renderStartCall(args, plainTheme as any, context).render(60));
		const [titled] = row({ command: "npm test -- --watchAll=false", title: "Run unit tests" });
		contains(titled, "Run unit tests");
		contains(titled, "$ npm test");
		// Without its job (a resumed row), it says only where the job ran.
		contains(titled, "\u21e2 background");
		contains(row({ command: "sleep 30" })[0], "$ sleep 30");
		// Raw titles are flattened to keep the terminal row on one line.
		contains(row({ command: "make", title: " Build\n\tall \u001b[1m" })[0], "Build all [1m");
		// An empty or non-string title falls back to the command.
		contains(row({ command: "make", title: "  " })[0], "$ make");
		contains(row({ command: "make", title: 3 })[0], "$ make");
		assert.strictEqual(row({ command: "make" }).length, 1);
		contains(row({ command: "make" }, { isPartial: false, isError: true })[0], "not started");
	});

	test("a terminal start row stays still in the background, then shows its outcome and time", () => {
		const theme = quiet();
		let job = makeJob({ title: "Build", startedAt: 1000 });
		const component = render.renderStartCall({ command: "make" }, theme as any, {}, () => job, () => 9000);
		const running = bare(component.render(60))[0]!;
		contains(running, "Build");
		contains(running, "⇢ background");
		// Still: the widget is the job's one live indicator.
		assert.strictEqual(component.render(60)[0], render.renderStartCall({ command: "make" }, theme as any, {}, () => job, () => 9700).render(60)[0]);
		job = makeJob({ title: "Build", startedAt: 1000, state: "done", code: 2, endedAt: 4000 });
		const failed = bare(component.render(60))[0]!;
		contains(failed, "exit 2");
		contains(failed, "3.0s");
		doesNotContain(failed, "⇢ background");
		// A kill the model asked for is stopped, gray, not a failure.
		job = makeJob({ title: "Build", startedAt: 1000, state: "done", signal: "SIGTERM", claimed: true, endedAt: 4000 });
		const stopped = component.render(60)[0]!;
		contains(bare([stopped])[0], "stopped");
		doesNotContain(bare([stopped])[0], "SIGTERM");
		assert.strictEqual(band.jobOutcome(job), "aborted");
	});

	test("a start row has a bullet in a two-column margin and a band; status colors carry its outcome", () => {
		const theme = quiet();
		const lineOf = (over: object) => render.renderStartCall({}, theme as any, {}, () => makeJob({ title: "Run unit tests", command: "npm test", startedAt: 1000, ...over }), () => 9000).render(80)[0]!;
		const running = lineOf({});
		assert.ok(bare([running])[0]!.startsWith("● Run unit tests  $ npm test"));
		assert.strictEqual(colorOf(running, "$"), fgOf("#8fb4c8"));
		assert.strictEqual(colorOf(running, "Run unit tests"), fgOf("#cfcdc6"));
		assert.strictEqual(colorOf(running, "⇢ background"), fgOf("#8a8882"));
		for (const [over, status, color] of [
			[{ state: "done", code: 0, endedAt: 40_000 }, "✓ exit 0", "#8fae7a"],
			[{ state: "done", code: 2, endedAt: 4000 }, "✗ exit 2", "#c97a72"],
			[{ state: "done", signal: "SIGTERM", claimed: true, endedAt: 4000 }, "■ stopped", "#8a8882"],
		] as const) {
			const line = lineOf(over);
			assert.strictEqual(colorOf(line, status), fgOf(color));
			assert.match(line, /\x1b\[48;/, "a colored band for every outcome");
		}
		assert.match(running, /\x1b\[48;/);
		contains(bare([lineOf({ state: "done", code: 0, endedAt: 40_000 })])[0], "✓ exit 0 · 39.0s");
	});

	test("a long title is cut, then left out, after the command reaches its minimum and the status stays whole", () => {
		const title = "Run the whole integration suite against staging";
		const row = (width: number) => bare(render.renderStartCall({ command: "x" }, quiet() as any, {}, () => makeJob({ title, command: "npm run integration", startedAt: 1000, state: "done", code: 2, endedAt: 4000 }), () => 9000).render(width))[0]!;
		for (const width of [40, 60, 80, 160]) {
			const line = row(width);
			assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			assert.ok(line.trimEnd().endsWith("✗ exit 2 · 3.0s"), `${width}: ${line}`);
			assert.ok(line.includes("$ npm run"), `${width}: ${line}`);
		}
		assert.ok(row(40).startsWith("● $ npm run"), "too little room: the title is left out");
		assert.ok(row(80).startsWith("● Run the") && row(80).includes("\u2026  $ npm run"), "some room: the title is cut, still first");
		assert.ok(row(160).startsWith(`● ${title}  $ npm run integration`), "room enough: the whole title");
		const untitled = bare(render.renderStartCall({}, quiet() as any, {}, () => makeJob({ title: null, command: "x".repeat(80), state: "done", code: 2, startedAt: 1000, endedAt: 4000 })).render(40))[0]!;
		assert.ok(untitled.trimEnd().endsWith("✗ exit 2 · 3.0s"), untitled);
	});

	test("a writing terminal row uses a dim bullet and command while keeping the title", () => {
		const writing = bare(render.renderStartCall({ command: "make", title: "Build" }, quiet() as any, { isPartial: true, executionStarted: false }).render(40))[0]!;
		assert.strictEqual(writing.trimEnd(), "● Build  $ make");
		const raw = render.renderStartCall({ command: "make" }, quiet() as any, { isPartial: true, executionStarted: false }).render(40)[0]!;
		assert.strictEqual(colorOf(raw, "●"), fgOf("#5f5d58"));
		assert.strictEqual(colorOf(raw, "make"), fgOf("#5f5d58"));
	});

	test("a title without a command is bold on the left", () => {
		const line = render.renderStartCall({ title: "Build" }, quiet() as any).render(40)[0]!;
		assert.ok(bare([line])[0]!.startsWith("● Build"));
		assert.match(line, /\x1b\[1mBuild/);
		doesNotContain(bare([line])[0], "$ ");
	});

	test("a shell_job row names the operation and the job by title when it knows it", () => {
		const text = (segs: { text: string }[]) => segs.map((seg) => seg.text).join("");
		assert.strictEqual(text(render.jobCallSegs({ op: "list" })), "shell_job list");
		assert.strictEqual(text(render.jobCallSegs({ op: "kill", id: "npm-test" })), "shell_job kill npm-test");
		assert.strictEqual(text(render.jobCallSegs({ op: "logs", id: "npm-test", tail: true, bytes: 4096 })), "shell_job logs npm-test (tail, 4096 bytes)");
		assert.strictEqual(text(render.jobCallSegs({ op: "kill", id: "npm-test" }, (id) => (id === "npm-test" ? "Run unit tests" : null))), "shell_job kill Run unit tests");
	});

	test("splits a completion into head, body, and notice", () => {
		const text = [
			"Job j1 finished: exit 0 after 4.0s",
			"log: /tmp/j1.log",
			"",
			"first line",
			"",
			"last line",
			"",
			"[Showing lines 11-40 of 40. Full output: /tmp/j1.log]",
		].join("\n");
		// A body may contain blank lines, so only the first and the bracketed tail split.
		assert.deepStrictEqual(splitCompletionText(text), {
			head: "Job j1 finished: exit 0 after 4.0s\nlog: /tmp/j1.log",
			body: "first line\n\nlast line",
			notice: "[Showing lines 11-40 of 40. Full output: /tmp/j1.log]",
		});
	});

	test("keeps a bracketed line that is not a truncation notice in the body", () => {
		const split = splitCompletionText("Job j1 finished: exit 0 after 1.0s\n\n[not a notice]");
		assert.strictEqual(split.body, "[not a notice]");
		assert.strictEqual(split.notice, "");
	});

	test("the completion view moves the duration into the footer and flags failures", () => {
		const ok = completionView("Job j1 finished: exit 0 after 12.1s\n\noutput", { code: 0, durationMs: 12100 });
		assert.strictEqual(ok.title, "Job j1 finished: exit 0");
		assert.strictEqual(ok.failed, false);
		assert.strictEqual(ok.took, "12.1s");
		assert.strictEqual(ok.command, "");
		const killed = completionView("Job j2 finished: signal SIGKILL after 1.5s\n\noutput", { signal: "SIGKILL", durationMs: 1500 });
		assert.strictEqual(killed.failed, true);
		assert.strictEqual(killed.title, "Job j2 finished: signal SIGKILL");
	});

	test("long durations break into minutes and hours in the title and the footer", () => {
		const hours = completionView("Job j1 finished: exit 0 after 1h 2m 3s\n\noutput", { code: 0, durationMs: 3_723_000 });
		assert.strictEqual(hours.title, "Job j1 finished: exit 0");
		assert.strictEqual(hours.took, "1h02m");
		const minutes = completionView("Job j1 finished: exit 0 after 12m 5s\n\noutput", { code: 0, durationMs: 725_000 });
		assert.strictEqual(minutes.title, "Job j1 finished: exit 0");
		assert.strictEqual(minutes.took, "12m05s");
		// A transcript written before durations were unit-broken still strips cleanly.
		assert.strictEqual(completionView("Job j1 finished: exit 0 after 3421.5s\n\noutput", { code: 0 }).title, "Job j1 finished: exit 0");
		for (const old of ["1m 1s", "1h 30m 32s", "1h30m"]) assert.strictEqual(completionView(`Job j1 finished: exit 0 after ${old}\n\noutput`, { code: 0 }).title, "Job j1 finished: exit 0");
	});

	test("formatDuration keeps tenths under a minute, then the compact shape every row shares", () => {
		assert.deepStrictEqual([0, 912, 45_400, 61_000, 725_000, 3_600_000, 5_432_000, -5, Number.NaN].map(formatDuration), [
			"0.0s", "0.9s", "45.4s", "1m01s", "12m05s", "1h00m", "1h30m", "0.0s", "0.0s",
		]);
	});

	test("the completion view takes the command from details and drops the path the log line already shows", () => {
		const view = completionView(completionMessage("output", {}).content, { code: 0, durationMs: 100, command: "make all" });
		assert.strictEqual(view.command, "make all");
		assert.deepStrictEqual(view.meta, ["log: /tmp/j1.log"]);
		assert.strictEqual(view.notice, "[Showing lines 11-20 of 20]");
		// A notice for some other path is left alone.
		const other = completionView("Job j1 finished: exit 0 after 1.0s\nlog: /tmp/j1.log\n\nx\n\n[Showing lines 1-2 of 9. Full output: /elsewhere.log]", {});
		assert.strictEqual(other.notice, "[Showing lines 1-2 of 9. Full output: /elsewhere.log]");
	});

	test("the completion view carries the job title and hides its meta line", () => {
		const text = "Job j1 finished: exit 0 after 4.0s\ntitle: Run unit tests\nlog: /tmp/j1.log\n\noutput";
		const view = completionView(text, { code: 0, durationMs: 4000, title: "Run unit tests", command: "npm test" });
		assert.strictEqual(view.label, "Run unit tests");
		assert.strictEqual(view.title, "Job j1 finished: exit 0");
		assert.deepStrictEqual(view.meta, ["log: /tmp/j1.log"]);
		// Details are authoritative; a title line in the text alone is still hidden.
		const untitled = completionView(text, { code: 0, durationMs: 4000 });
		assert.strictEqual(untitled.label, "");
		assert.deepStrictEqual(untitled.meta, ["log: /tmp/j1.log"]);
	});

	test("a completion repeats the terminal command and final status, then previews output in its gutter", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const renderer = app.renderers.get("shell-job-complete")!;
		const message = completionMessage("output", { code: 0, durationMs: 1000, title: "Run unit tests", command: "npm test" });
		const lines = bare(renderer(message, plainRender, plainTheme)!.render(80));
		assert.strictEqual(lines.length, 2);
		contains(lines[0], "$ npm test");
		contains(lines[0], "Run unit tests");
		contains(lines[0], "✓ exit 0 · 1.0s");
		assert.strictEqual(lines[1], "  │ output");
		const untitled = bare(renderer(completionMessage("output", { code: 3, durationMs: 1000, command: "npm test" }), plainRender, plainTheme)!.render(80))[0]!;
		contains(untitled, "$ npm test");
		contains(untitled, "exit 3");
		// An older message with neither names itself by its first line.
		contains(bare(renderer(completionMessage("output", { code: 0 }), plainRender, plainTheme)!.render(80))[0], "Job j1 finished: exit 0");
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("a completion previews four output lines without a hint, otherwise the last three", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const draw = (count: number) => bare(renderer(completionMessage(Array.from({ length: count }, (_, i) => `row ${i + 1}`).join("\n"), { code: 0, command: "seq", durationMs: 1000 }), plainRender, plainTheme)!.render(80));
		assert.deepStrictEqual(draw(4).slice(1), ["  │ row 1", "  │ row 2", "  │ row 3", "  │ row 4"]);
		assert.deepStrictEqual(draw(5).slice(1), ["  │ … 2 earlier lines (ctrl+o to expand)", "  │ row 3", "  │ row 4", "  │ row 5"]);
	});

	test("a collapsed completion with an earlier-lines hint fits even the narrowest terminal", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const component = renderer(completionMessage("one\ntwo\nthree\nfour\nfive", { code: 0, command: "seq", durationMs: 1000 }), plainRender, plainTheme)!;
		for (let width = 1; width <= 40; width++) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
		}
	});

	test("an expanded completion shows metadata, all output and its notice in the terminal gutter", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const message = completionMessage(body, { code: 0, durationMs: 12100, command: "seq 1 20" });
		const expanded = renderer(message, { expanded: true, outputPad: 2 }, plainTheme)!.render(80).join("\n");
		contains(expanded, "$ seq 1 20");
		contains(expanded, "log: /tmp/j1.log");
		contains(expanded, "line 1\n");
		contains(expanded, "line 20");
		contains(expanded, "[Showing lines 11-20 of 20]");
		doesNotContain(expanded, "Full output");
		// Metadata and output share the terminal gutter, with no repeated command block.
		contains(expanded, "\n  │ line 1");
		assert.strictEqual(expanded.match(/\$ seq 1 20/g)?.length, 1);
	});

	test("an expanded completion never draws wider than the terminal, however narrow", () => {
		// Pi stops drawing, and throws, on a line wider than the terminal.
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const body = Array.from({ length: 8 }, (_, index) => `line ${index + 1} of the output`).join("\n");
		const message = completionMessage(body, { code: 0, durationMs: 12100, command: "seq 1 20" });
		const component = renderer(message, { expanded: true, outputPad: 2 }, plainTheme)!;
		for (let width = 1; width <= 40; width++) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
		}
	});

	test("completion headers are outcome-colored bands; gutter output and metadata keep their own colors", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		for (const [details, status, color] of [
			[{ code: 0, durationMs: 1000 }, "✓ exit 0", "#8fae7a"],
			[{ code: 1, durationMs: 1000 }, "✗ exit 1", "#c97a72"],
			[{ signal: "SIGKILL", durationMs: 1000 }, "✗ signal SIGKILL", "#c97a72"],
		] as const) {
			const lines = renderer(completionMessage("output", details), { expanded: true, outputPad: 1 }, quiet())!.render(100);
			assert.strictEqual(colorOf(lines[0]!, status), fgOf(color));
			assert.match(lines[0]!, /\x1b\[48;/, "completion head is a band");
			assert.ok(lines.slice(1).every((line) => !/\x1b\[48;/.test(line)), "gutter has no body background");
			assert.strictEqual(colorOf(lines[1]!, "log:"), fgOf("#5f5d58"));
			assert.strictEqual(colorOf(lines[2]!, "│"), fgOf("#3a3936"));
			assert.strictEqual(colorOf(lines[2]!, "output"), fgOf("#a8a69f"));
			assert.strictEqual(colorOf(lines[3]!, "[Showing"), fgOf("#ecb64e"));
		}
	});

	test("clicking the completion expands and collapses it", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const component = renderer(completionMessage(body, { code: 0, durationMs: 12100 }), plainRender, plainTheme)!;
		assert.strictEqual(component.render(80).length, 5);
		contains(bare(component.render(80))[1], "… 17 earlier lines (ctrl+o to expand)");
		assert.deepStrictEqual(bare(component.render(80)).slice(2), ["  │ line 18", "  │ line 19", "  │ line 20"]);
		// pi routes a left click to the region pi's own tool rows use to expand.
		const click = { type: "click", button: "left", x: 3, y: 0, width: 80, height: 24 };
		assert.deepStrictEqual(component.handleMouse!(click), { handled: true });
		contains(component.render(80).join("\n"), "line 1\n");
		assert.deepStrictEqual(component.handleMouse!(click), { handled: true });
		assert.strictEqual(component.render(80).length, 5);
		assert.strictEqual(component.handleMouse!({ ...click, button: "right" }), undefined);
		assert.strictEqual(component.handleMouse!({ ...click, type: "move" }), undefined);
	});

	test("a global expand toggle clears a per-message click", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const message = completionMessage("output", { code: 0, durationMs: 12100 });
		const build = (expanded: boolean) => renderer(message, { expanded, outputPad: 1 }, plainTheme)!;
		const first = build(false);
		first.handleMouse!({ type: "click", button: "left", x: 1, y: 0, width: 80, height: 24 });
		contains(bare(build(false).render(80)).join("\n"), "log: /tmp/j1.log");
		// ctrl+O wins over the clicked state, and clearing it restores the preview.
		contains(bare(build(true).render(80)).join("\n"), "log: /tmp/j1.log");
		const collapsed = bare(build(false).render(80));
		assert.strictEqual(collapsed.length, 2);
		doesNotContain(collapsed.join("\n"), "log: /tmp/j1.log");
	});

	test("both tools render their own shell: a terminal start line and an operational manage band", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		const manage = app.tools.get("shell_job");
		assert.strictEqual(start.renderShell, "self");
		assert.strictEqual(manage.renderShell, "self");
		contains(start.renderCall({ command: "sleep 30" }, plainTheme).render(80).join("\n"), "$ sleep 30");
		contains(manage.renderCall({ op: "kill", id: "j2" }, plainTheme).render(80).join("\n"), "shell_job kill j2");
		const long = start.renderCall({ command: "x".repeat(120), title: "Long one" }, plainTheme, { expanded: true }).render(40);
		assert.strictEqual(long.length, 1);
		assert.ok(visibleWidth(long[0]) <= 40);
	});

	test("the manage row names a job this session started by its title", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const started = await app.tools.get("shell_job_start").execute("c1", { command: "sleep 30", title: "Nap" }, undefined, undefined, app.ctx);
		const row = app.tools.get("shell_job").renderCall({ op: "kill", id: started.details.id }, plainTheme).render(80).join("\n");
		contains(row, "shell_job kill Nap");
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("the start result shows only when expanded or failed, indented under the terminal row", () => {
		const result = { content: [{ type: "text", text: "Started nap (pid 4) in /tmp\nlog: /tmp/nap.log\n" }], details: {} };
		assert.deepStrictEqual(renderStartResult(result, plainTheme as any).render(60), []);
		const lines = renderStartResult(result, plainTheme as any, { expanded: true }).render(60);
		assert.strictEqual(lines.length, 2);
		assert.strictEqual(lines[0]!.startsWith("    Started nap (pid 4) in /tmp"), true);
		contains(lines[1], "log: /tmp/nap.log");
		const failed = { content: [{ type: "text", text: "Working directory does not exist: /nope" }], details: {} };
		contains(renderStartResult(failed, plainTheme as any, { isError: true }).render(60).join("\n"), "/nope");
	});

	test("the job result collapses long output", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const body = Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join("\n");
		const result = { content: [{ type: "text", text: body }], details: {} };
		const collapsed = app.tools.get("shell_job").renderResult(result, { expanded: false }, plainTheme).render(80).join("\n");
		contains(collapsed, "row 12");
		doesNotContain(collapsed, "row 8");
		// keyHint needs an initialized theme, so tests take the plain fallback.
		contains(collapsed, "\u2026 8 earlier lines (ctrl+o to expand)");
		const expanded = app.tools.get("shell_job").renderResult(result, { expanded: true }, plainTheme).render(80).join("\n");
		contains(expanded, "row 1\n");
		contains(expanded, "row 12");
	});

	test("loads on a core without the message renderer API", () => {
		const app = createFakePi();
		delete (app.pi as Record<string, unknown>).registerMessageRenderer;
		assert.doesNotThrow(() => shellJobs(app.pi as any));
	});
});
