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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paint } from "../lib/shell-jobs-render.ts";
import { formatDuration } from "../lib/shell-jobs-core.ts";
import {
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
	WIDGET_REFRESH_MS,
	createJobsWidget,
	formatElapsed,
	frameAt,
	plainPaint,
	renderJobLines,
	selectRows,
} = widget;
const SPINNER_ROW = new RegExp(`^ ?[${SPINNER_FRAMES.join("")}]  j1`);
const { completionView, jobCallLine, renderStartResult, splitCompletionText, startCallLine, startCallLines } = render;
const { stripTerminalSequences, visibleWidth } = tui;

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

	test("spinners advance one frame per refresh and share a phase", () => {
		assert.strictEqual(frameAt(SPINNER_FRAMES, 0), SPINNER_FRAMES[0]);
		assert.strictEqual(frameAt(SPINNER_FRAMES, WIDGET_REFRESH_MS - 1), SPINNER_FRAMES[0]);
		assert.strictEqual(frameAt(SPINNER_FRAMES, WIDGET_REFRESH_MS), SPINNER_FRAMES[1]);
		assert.strictEqual(frameAt(SPINNER_FRAMES, WIDGET_REFRESH_MS * SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
		assert.strictEqual(frameAt(STOPPING_FRAMES, WIDGET_REFRESH_MS * 5), STOPPING_FRAMES[1]);
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
		assert.deepStrictEqual(renderJobLines([makeJob({ state: "stopping" })], null, plainPaint), ["◐  j1  stopping  npm test -- --watchAll=false"]);
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

	test("the TUI component pads rows to the column pi uses for widgets", async () => {
		const app = createFakePi([], "tui");
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		await app.tools.get("shell_job_start").execute("t1", { command: "sleep 30" }, undefined, undefined, app.ctx);
		const factory = app.widgets.at(-1)?.value as (host: unknown, theme: unknown) => { render(width: number): string[] };
		const component = factory({ requestRender: () => {} }, { fg: (_key: string, text: string) => text });
		const lines = component.render(40);
		// One leading space, like the Text(line, 1, 0) pi wraps string widgets in.
		assert.match(lines[0], SPINNER_ROW);
		assert.strictEqual(lines[0].startsWith(" "), true);
		assert.ok(visibleWidth(lines[0]) <= 40);
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("sampling dates a silent log from the job start and a written log from its growth", () => {
		const dir = tempDir();
		const silentLog = join(dir, "j1.log");
		const busyLog = join(dir, "j2.log");
		writeFileSync(silentLog, "");
		writeFileSync(busyLog, "hello\n");
		const startedAt = Date.now() - QUIET_AFTER_MS - 1000;
		const jobs = [makeJob({ id: "j1", logPath: silentLog, startedAt }), makeJob({ id: "j2", logPath: busyLog, startedAt })];
		type Factory = (host: unknown, theme: unknown) => { render(width: number): string[] };
		let factory: Factory | undefined;
		const jobsWidget = createJobsWidget();
		jobsWidget.attach({ setWidget: (_id, content) => { factory = content as Factory; } }, true, () => jobs);
		const keys: string[] = [];
		const component = factory!({ requestRender: () => {} }, { fg: (key: string, text: string) => { keys.push(key); return text; } });
		const lines = component.render(80);
		assert.match(lines[0], SPINNER_ROW);
		// Each row paints icon, id, elapsed. j1 never printed, so its first sample is
		// dated from its start and it is already quiet; j2 has output, so it is fresh.
		assert.deepStrictEqual(keys.slice(0, 3), ["dim", "accent", "muted"]);
		assert.deepStrictEqual(keys.slice(3, 6), ["accent", "accent", "muted"]);
		jobsWidget.detach();
	});
});
const plainTheme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
const rawPaint: Paint = { fg: (_key, text) => text, bg: (_key, text) => text, bold: (text) => text };
// Marks the background so a test can see which key was applied to which line.
const bgTheme = {
	fg: (_key: string, text: string) => text,
	bg: (key: string, text: string) => `<${key}>${text}</>`,
	bold: (text: string) => text,
};

function completionMessage(body: string, details: Record<string, unknown>) {
	return {
		customType: "shell-job-complete",
		content: `Job j1 finished: exit 0 after 12.1s\nlog: /tmp/j1.log\n\n${body}\n\n[Showing lines 11-20 of 20. Full output: /tmp/j1.log]`,
		details,
	};
}
const plainRender = { expanded: false, outputPad: 1 };
describe("job rendering", () => {
	test("the start call reads like the built-in bash tool", () => {
		assert.strictEqual(startCallLine({ command: "sleep 30" }, rawPaint), "$ sleep 30");
		assert.strictEqual(startCallLine({ command: "make", cwd: "/tmp/x" }, rawPaint), "$ make (cwd /tmp/x)");
		assert.strictEqual(startCallLine({}, rawPaint), "$ [invalid arg]");
		assert.strictEqual(startCallLine({ command: "" }, rawPaint), "$ ...");
	});

	test("a titled start call leads with the title and keeps the command visible", () => {
		assert.deepStrictEqual(startCallLines({ command: "sleep 30" }, rawPaint, 80, false), ["$ sleep 30"]);
		assert.deepStrictEqual(startCallLines({ command: "npm test -- --watchAll=false", title: "Run unit tests" }, rawPaint, 80, false), [
			"Run unit tests",
			"$ npm test -- --watchAll=false",
		]);
		assert.deepStrictEqual(startCallLines({ command: "make", cwd: "/tmp/x", title: "Build" }, rawPaint, 80, false), ["Build", "$ make (cwd /tmp/x)"]);
		// The model's raw title may carry newlines or control bytes; the row is one line.
		assert.deepStrictEqual(startCallLines({ command: "make", title: " Build\n\tall \u001b[1m" }, rawPaint, 80, false)[0], "Build all [1m");
		// An empty or non-string title falls back to the plain bash-style line.
		assert.deepStrictEqual(startCallLines({ command: "make", title: "  " }, rawPaint, 80, false), ["$ make"]);
		assert.deepStrictEqual(startCallLines({ command: "make", title: 3 }, rawPaint, 80, false), ["$ make"]);
	});

	test("under a title the command collapses to one line until the row is expanded", () => {
		const command = "cd app && npm ci && npm run build -- --mode production && npm test -- --watchAll=false";
		const collapsed = startCallLines({ command, title: "Build and test" }, rawPaint, 40, false);
		assert.strictEqual(collapsed.length, 2);
		assert.ok(visibleWidth(collapsed[1]) <= 40, collapsed[1]);
		// The cut closes the colour sequence around the ellipsis, so compare the bare text.
		const bare = stripTerminalSequences(collapsed[1]);
		assert.strictEqual(bare.startsWith("$ cd app && npm ci"), true, bare);
		assert.strictEqual(bare.endsWith("…"), true, bare);
		const expanded = startCallLines({ command, title: "Build and test" }, rawPaint, 40, true);
		assert.deepStrictEqual(expanded, ["Build and test", `$ ${command}`]);
		// Without a title nothing is truncated, exactly as before.
		assert.deepStrictEqual(startCallLines({ command }, rawPaint, 40, false), [`$ ${command}`]);
	});

	test("the management call names the operation and its paging arguments", () => {
		assert.strictEqual(jobCallLine({ op: "list" }, rawPaint), "shell_job list");
		assert.strictEqual(jobCallLine({ op: "kill", id: "j2" }, rawPaint), "shell_job kill j2");
		assert.strictEqual(jobCallLine({ op: "logs", id: "j1", tail: true, bytes: 4096 }, rawPaint), "shell_job logs j1 (tail, 4096 bytes)");
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
		assert.strictEqual(hours.took, "1h 2m 3s");
		const minutes = completionView("Job j1 finished: exit 0 after 12m 5s\n\noutput", { code: 0, durationMs: 725_000 });
		assert.strictEqual(minutes.title, "Job j1 finished: exit 0");
		assert.strictEqual(minutes.took, "12m 5s");
		// A transcript written before durations were unit-broken still strips cleanly.
		assert.strictEqual(completionView("Job j1 finished: exit 0 after 3421.5s\n\noutput", { code: 0 }).title, "Job j1 finished: exit 0");
	});

	test("formatDuration matches Pi's bash footer shape", () => {
		assert.deepStrictEqual([0, 912, 45_400, 61_000, 725_000, 3_600_000, 5_432_000, -5, Number.NaN].map(formatDuration), [
			"0.0s", "0.9s", "45.4s", "1m 1s", "12m 5s", "1h 0m 0s", "1h 30m 32s", "0.0s", "0.0s",
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

	test("a titled completion leads its header with the title", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const renderer = app.renderers.get("shell-job-complete")!;
		const message = completionMessage("output", { code: 0, durationMs: 1000, title: "Run unit tests", command: "npm test" });
		const text = renderer(message, plainRender, plainTheme)!.render(80).join("\n");
		contains(text, "Run unit tests · Job j1 finished: exit 0");
		contains(text, "$ npm test");
		const plain = renderer(completionMessage("output", { code: 0, durationMs: 1000 }), plainRender, plainTheme)!.render(80).join("\n");
		contains(plain, "Job j1 finished: exit 0");
		doesNotContain(plain, "·");
		await fire(app.handlers, "session_shutdown", app.ctx);
	});

	test("the completion renderer collapses the body behind the expand hint", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		assert.strictEqual(typeof renderer, "function");
		const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const message = completionMessage(body, { code: 0, durationMs: 12100, command: "seq 1 20" });
		const collapsed = renderer(message, { expanded: false, outputPad: 2 }, plainTheme)!.render(80).join("\n");
		contains(collapsed, "Job j1 finished: exit 0");
		contains(collapsed, "$ seq 1 20");
		contains(collapsed, "log: /tmp/j1.log");
		// keyHint needs an initialized theme, so tests take the plain fallback.
		contains(collapsed, "... (15 earlier lines, ctrl+o to expand)");
		contains(collapsed, "line 20");
		doesNotContain(collapsed, "line 15");
		contains(collapsed, "[Showing lines 11-20 of 20]");
		doesNotContain(collapsed, "Full output");
		contains(collapsed, "Took 12.1s");
		const expanded = renderer(message, { expanded: true, outputPad: 2 }, plainTheme)!.render(80).join("\n");
		contains(expanded, "line 1");
		contains(expanded, "line 20");
		doesNotContain(expanded, "earlier lines");
	});

	test("the completion renders on the background of a finished tool call", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const ok = renderer(completionMessage("output", { code: 0, durationMs: 1000 }), plainRender, bgTheme)!;
		contains(ok.render(60).join("\n"), "<toolSuccessBg>");
		const bad = completionMessage("output", { signal: "SIGKILL", durationMs: 1000 });
		const failed = renderer(bad, plainRender, bgTheme)!;
		contains(failed.render(60).join("\n"), "<toolErrorBg>");
	});

	test("clicking the completion expands and collapses it", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const component = renderer(completionMessage(body, { code: 0, durationMs: 12100 }), plainRender, plainTheme)!;
		contains(component.render(80).join("\n"), "line 16");
		// pi routes a left click to the region pi's own tool rows use to expand.
		const click = { type: "click", button: "left", x: 3, y: 4, width: 80, height: 24 };
		assert.deepStrictEqual(component.handleMouse!(click), { handled: true });
		// Lines are padded to the width, so match the label and its trailing pad.
		contains(component.render(80).join("\n"), "line 1 ");
		doesNotContain(component.render(80).join("\n"), "earlier lines");
		assert.deepStrictEqual(component.handleMouse!(click), { handled: true });
		contains(component.render(80).join("\n"), "earlier lines");
		assert.strictEqual(component.handleMouse!({ ...click, button: "right" }), undefined);
		assert.strictEqual(component.handleMouse!({ ...click, type: "move" }), undefined);
	});

	test("a global expand toggle clears a per-message click", () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		const renderer = app.renderers.get("shell-job-complete")!;
		const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const message = completionMessage(body, { code: 0, durationMs: 12100 });
		const build = (expanded: boolean) => renderer(message, { expanded, outputPad: 1 }, plainTheme)!;
		const first = build(false);
		first.handleMouse!({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 24 });
		doesNotContain(build(false).render(80).join("\n"), "earlier lines");
		// ctrl+O wins over the clicked state, and clearing it restores the collapse.
		doesNotContain(build(true).render(80).join("\n"), "earlier lines");
		contains(build(false).render(80).join("\n"), "earlier lines");
	});

	test("both tools expose call and result renderers", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const start = app.tools.get("shell_job_start");
		const manage = app.tools.get("shell_job");
		assert.strictEqual(typeof start.renderCall, "function");
		assert.strictEqual(typeof start.renderResult, "function");
		assert.strictEqual(typeof manage.renderCall, "function");
		assert.strictEqual(typeof manage.renderResult, "function");
		contains(start.renderCall({ command: "sleep 30" }, plainTheme).render(80).join("\n"), "$ sleep 30");
		contains(manage.renderCall({ op: "kill", id: "j2" }, plainTheme).render(80).join("\n"), "shell_job kill j2");
		// A titled call renders two lines and honours the row's expanded state.
		const command = "x".repeat(120);
		const titled = start.renderCall({ command, title: "Long one" }, plainTheme, { expanded: false }).render(40);
		// Text pads each line to the width.
		assert.strictEqual(titled[0].trimEnd(), "Long one");
		assert.strictEqual(titled.length, 2);
		assert.ok(visibleWidth(titled[1]) <= 40);
		const open = start.renderCall({ command, title: "Long one" }, plainTheme, { expanded: true }).render(40);
		assert.ok(open.length > 2);
		assert.ok(open.every((line: string) => visibleWidth(line) <= 40));
	});

	test("the start result sits under a blank line, like bash output", () => {
		const result = { content: [{ type: "text", text: "Started j1 (pid 4) in /tmp\nlog: /tmp/j1.log\n" }], details: {} };
		const lines = renderStartResult(result, plainTheme as any).render(60);
		assert.strictEqual(lines[0].trim(), "");
		contains(lines[1], "Started j1 (pid 4) in /tmp");
		contains(lines[2], "log: /tmp/j1.log");
		assert.strictEqual(lines.length, 3);
	});

	test("the job result collapses long output", async () => {
		const app = createFakePi();
		shellJobs(app.pi as any);
		await fire(app.handlers, "session_start", app.ctx);
		const body = Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join("\n");
		const result = { content: [{ type: "text", text: body }], details: {} };
		const collapsed = app.tools.get("shell_job").renderResult(result, { expanded: false }, plainTheme).render(80).join("\n");
		contains(collapsed, "row 12");
		doesNotContain(collapsed, "row 7");
		contains(collapsed, "... (7 earlier lines, ctrl+o to expand)");
		const expanded = app.tools.get("shell_job").renderResult(result, { expanded: true }, plainTheme).render(80).join("\n");
		contains(expanded, "row 1");
		contains(expanded, "row 12");
	});

	test("loads on a core without the message renderer API", () => {
		const app = createFakePi();
		delete (app.pi as Record<string, unknown>).registerMessageRenderer;
		assert.doesNotThrow(() => shellJobs(app.pi as any));
	});
});
