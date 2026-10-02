import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { GUTTER, PROMPT, cleanOutput, gutterLines, jobBand, lastLine, promptSegs, type JobBandSpec } from "../lib/band/job-look.ts";
import { bandBackground, fallbackKey, type BandPhase } from "../lib/band/band.ts";
import { bgSgr } from "../lib/band/color.ts";
import { paletteFrom } from "../lib/band/palette.ts";
import { BULLET_GLYPH, JOB_ANIMATION, JOB_STOPPING_ANIMATION, animationFrameMs, glyphAt } from "../lib/band/glyph.ts";
import { QUIET_FRAME_MS, factsOf, jobRow, liveRow, type JobFacts } from "../lib/shell-jobs-band.ts";
import type { Job } from "../lib/shell-jobs-process.ts";
import { colorOf } from "./support/tool-rows.ts";
import { bgOf, fgOf, quiet } from "./support/quiet-theme.ts";

const theme = quiet();
const palette = paletteFrom(theme)!;
const plain = (line: string) => stripTerminalSequences(line);
const spec: JobBandSpec = { width: 120, phase: { kind: "queued" }, margin: { text: "●", color: "dim" }, command: "c".repeat(30), title: "T".repeat(12), status: [{ text: "STATUS", color: "muted" }], facts: ["fact-one", "fact-two"], tail: "z".repeat(20), clockMs: 1000 };
const draw = (width: number) => plain(jobBand(theme, { ...spec, width })).trimEnd();
const job = (extra: Partial<Job> = {}): Job => ({ id: "build", pid: 1, command: "make all", title: "Build", toolCallId: null, cwd: "/tmp", logPath: "/tmp/no-job-look-log", startedAt: 1000, epoch: 1, state: "running", code: null, signal: null, endedAt: null, claimed: false, attempts: 0, delivered: false, deliveryFailed: false, cleanupError: null, runtimeId: "rt", ...extra });

function backgroundAt(line: string, column: number): string | undefined {
	let x = 0, background: string | undefined;
	for (const token of line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/gu)) {
		if (token[0].startsWith("\x1b[")) {
			if (token[0].startsWith("\x1b[48;")) background = token[0];
		} else {
			if (x === column) return background;
			x += visibleWidth(token[0]);
		}
	}
	return undefined;
}

const expectedBg = (phase: BandPhase, x = 0, width = 100, now = 9000, motion: "full" | "reduced" = "full") => bgSgr(bandBackground(palette, phase, width, now, motion)(x), palette.mode);

test("a job band leads with its bold title, then its command and status close together, never right-aligned", () => {
	const line = jobBand(theme, { ...spec, command: "sleep 30", title: "Nap", status: [{ text: "⇢ background", color: "muted" }], facts: [], tail: undefined });
	assert.ok(plain(line).startsWith("● Nap  $ sleep 30  ⇢ background"), plain(line));
	assert.equal(visibleWidth(line), 120);
	assert.match(line, /\x1b\[1mNap/);
	assert.equal(colorOf(line, PROMPT), fgOf("#8fb4c8"));
	assert.ok(line.includes(expectedBg(spec.phase, 0, 120, 1000)));
	assert.equal(promptSegs("ls")[0]!.bold, true);
});

test("cut order keeps what a job is doing: the command gives way to 16, then the output line, all facts but the first, the title, the first fact, the rest of the command", () => {
	assert.ok(draw(103).includes("c".repeat(30)) && draw(103).endsWith(`▸ ${"z".repeat(20)}`));
	assert.ok(draw(102).includes(`$ ${"c".repeat(28)}…  `) && draw(102).endsWith(`▸ ${"z".repeat(20)}`));
	assert.ok(draw(89).includes(`$ ${"c".repeat(15)}…  `) && draw(89).endsWith(`▸ ${"z".repeat(20)}`));
	assert.ok(draw(88).endsWith(`▸ ${"z".repeat(18)}…`));
	assert.ok(draw(79).endsWith(`▸ ${"z".repeat(9)}…`));
	assert.ok(!draw(78).includes("▸") && draw(78).includes("T".repeat(12)));
	assert.ok(draw(65).includes("fact-two"));
	assert.ok(draw(64).includes(`${"T".repeat(12)}  $ ${"c".repeat(15)}…  STATUS · fact-one`) && !draw(64).includes("fact-two"));
	assert.ok(draw(53).startsWith(`● ${"T".repeat(10)}…  $ `));
	assert.ok(draw(48).startsWith(`● ${"T".repeat(5)}…  $ `));
	assert.ok(!draw(47).includes("TT") && draw(47).includes("fact-one"));
	assert.ok(!draw(39).includes("fact-one") && draw(39).includes(`${"c".repeat(15)}…`));
	assert.ok(draw(25).includes(`${"c".repeat(11)}…  STATUS`));
	assert.equal(draw(16), "● STATUS");
});

test("a long output line keeps 24 columns before the command gives way", () => {
	const line = plain(jobBand(theme, { ...spec, width: 103, tail: "z".repeat(60) })).trimEnd();
	assert.ok(line.includes(`$ ${"c".repeat(25)}…  `), line);
	assert.ok(line.endsWith(`▸ ${"z".repeat(23)}…`), line);
});

test("status stays whole when there is room for the margin, prompt and status", () => {
	for (let width = 20; width <= 120; width++) {
		const line = plain(jobBand(theme, { ...spec, width, status: [{ text: "⇢ background", color: "muted" }] }));
		assert.ok(line.includes("⇢ background"), `${width}: ${line}`);
	}
});

test("status stays whole even when the command must give way entirely", () => {
	// A command shorter than four columns says too little and must not steal the status's room.
	for (let width = 15; width < 23; width++) {
		const line = plain(jobBand(theme, { ...spec, width, status: [{ text: "⇢ background", color: "muted" }] }));
		assert.ok(line.includes("⇢ background"), `${width}: ${line}`);
		assert.doesNotMatch(line, /\$/, `${width}: no lone prompt or unusable command`);
	}
});

test("job bands never run past widths 1..120, including wide glyphs", () => {
	for (let width = 1; width <= 120; width++) for (const command of [spec.command, "界😀é".repeat(40), ""]) {
		const line = jobBand(theme, { ...spec, width, command });
		assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
	}
});

test("transcript phases use a still bullet and the phase background, including delivery failure and unstarted", () => {
	const cases: Array<{ facts: JobFacts; state?: "writing" | "unstarted"; phase: BandPhase; color: string; status: string }> = [
		{ facts: factsOf(job()), state: "writing", phase: { kind: "writing" }, color: "#5f5d58", status: "" },
		{ facts: factsOf(job()), phase: { kind: "queued" }, color: "#5f5d58", status: "⇢ background" },
		{ facts: { ...factsOf(job()), state: "unknown" }, phase: { kind: "queued" }, color: "#5f5d58", status: "⇢ background" },
		{ facts: factsOf(job({ state: "stopping" })), phase: { kind: "queued" }, color: "#5f5d58", status: "stopping · 8.0s" },
		{ facts: factsOf(job({ state: "done", code: 0, endedAt: 4000 })), phase: { kind: "done", outcome: "ok", sinceMs: Infinity }, color: "#8fae7a", status: "✓ exit 0 · 3.0s" },
		{ facts: factsOf(job({ state: "done", code: 2, endedAt: 4000 })), phase: { kind: "done", outcome: "fail", sinceMs: Infinity }, color: "#c97a72", status: "✗ exit 2 · 3.0s" },
		{ facts: factsOf(job({ state: "done", claimed: true, signal: "SIGTERM", endedAt: 5000 })), phase: { kind: "done", outcome: "aborted", sinceMs: Infinity }, color: "#8a8882", status: "■ stopped · 4.0s" },
		{ facts: factsOf(job({ state: "done", code: 0, deliveryFailed: true, endedAt: 4000 })), phase: { kind: "done", outcome: "timeout", sinceMs: Infinity }, color: "#ecb64e", status: "not delivered · 3.0s" },
		{ facts: factsOf(job()), state: "unstarted", phase: { kind: "done", outcome: "fail", sinceMs: Infinity }, color: "#c97a72", status: "✗ not started" },
	];
	for (const { facts, state, phase, color, status } of cases) {
		const line = jobRow(theme, facts, { width: 100, now: 9000, ...(state ? { state } : {}) });
		assert.ok(plain(line).startsWith(`${BULLET_GLYPH} Build  $ make all`));
		assert.ok(plain(line).includes(status));
		assert.equal(colorOf(line, BULLET_GLYPH), fgOf(color));
		assert.equal(backgroundAt(line, 0), expectedBg(phase));
		assert.equal(backgroundAt(line, 99), expectedBg(phase, 99));
	}
	assert.equal(expectedBg({ kind: "writing" }), bgOf("#232326"));
});

test("job bands fall back to theme backgrounds without a derivable palette", () => {
	const keys: string[] = [];
	const bare = { ...theme, getFgAnsi: () => "", getBgAnsi: () => "", bg: (key: string, text: string) => { keys.push(key); return text; } };
	for (const phase of [{ kind: "queued" }, { kind: "progress", share: .45 }, { kind: "done", outcome: "ok", sinceMs: Infinity }, { kind: "done", outcome: "fail", sinceMs: Infinity }, { kind: "done", outcome: "aborted", sinceMs: Infinity }] as const) {
		jobBand(bare, { ...spec, phase });
		assert.equal(keys.at(-1), fallbackKey(phase));
	}
});

test("live progress is a linear fill with a lead near share × width, percent and facts instead of tail", () => {
	const progress = { share: .45, parts: ["31s left", "312M/690M", "10M/s"] };
	const line = liveRow(theme, job(), { width: 100, now: 9000, progress, tail: "not shown" });
	assert.match(plain(line), /8\.0s  45% · 31s left · 312M\/690M · 10M\/s/);
	assert.equal(colorOf(line, "45%"), fgOf("#8fb4c8"));
	assert.match(line, /\x1b\[1m45%/);
	assert.doesNotMatch(plain(line), /▸|not shown/);
	for (const x of [0, 43, 44, 45, 99]) assert.equal(backgroundAt(line, x), expectedBg({ kind: "progress", share: .45 }, x));
	assert.notEqual(backgroundAt(line, 43), backgroundAt(line, 45));
});

test("the cell a fill is crossing creeps with the share, so slow progress never looks stalled", () => {
	const at = (share: number) => liveRow(theme, job(), { width: 100, now: 9000, motion: "reduced", progress: { share, parts: [] } });
	const [early, late] = [at(.452), at(.458)];
	for (const x of [0, 44, 46, 99]) assert.equal(backgroundAt(early, x), backgroundAt(late, x), `cell ${x} holds`);
	assert.notEqual(backgroundAt(early, 45), backgroundAt(late, 45), "the crossing cell moves within itself");
	assert.equal(backgroundAt(early, 45), expectedBg({ kind: "progress", share: .452 }, 45, 100, 9000, "reduced"));
});

test("a known share keeps the spinner lively and the band filling, even when the log is silent", () => {
	// A sleep prints nothing by design; the quiet crawl would wrongly suggest it is stuck.
	const now = 61_000;
	const row = liveRow(theme, job(), { width: 100, now, quiet: true, progress: { share: .5, parts: ["30s left"] } });
	assert.equal(colorOf(row, glyphAt(JOB_ANIMATION, now)), fgOf("#8fb4c8"));
	assert.equal(backgroundAt(row, 10), expectedBg({ kind: "progress", share: .5 }, 10, 100, now));
});

test("progress with no share sweeps and shows what the meter says instead of the raw line", () => {
	const row = liveRow(theme, job(), { width: 100, now: 9000, progress: { parts: ["312M", "12.1M/s"] }, tail: "0 0 0 312M 0 0 11.8M 0 --:--:-- 0:00:26 --:--:-- 12.1M" });
	assert.match(plain(row), /8\.0s · 312M · 12\.1M\/s/);
	assert.doesNotMatch(plain(row), /%|▸/);
	assert.equal(backgroundAt(row, 20), expectedBg({ kind: "running", elapsedMs: 8000 }, 20, 100, 9000));
});

test("live rows sweep with a tail, calm down with a dim crawl, and hold the spinner on reduced motion", () => {
	const now = 61_000;
	const loud = liveRow(theme, job(), { width: 100, now, tail: "checking src/band" });
	assert.match(plain(loud), /Build  \$ make all  1m00s  ▸ checking src\/band/);
	assert.equal(colorOf(loud, glyphAt(JOB_ANIMATION, now)), fgOf("#8fb4c8"));
	assert.equal(backgroundAt(loud, 20), expectedBg({ kind: "running", elapsedMs: 60000 }, 20, 100, now));
	const quietRow = liveRow(theme, job(), { width: 100, now, quiet: true });
	const crawl = glyphAt(JOB_ANIMATION, now * animationFrameMs(JOB_ANIMATION) / QUIET_FRAME_MS);
	assert.ok(plain(quietRow).startsWith(`${crawl} Build  $`));
	assert.equal(colorOf(quietRow, crawl), fgOf("#5f5d58"));
	assert.equal(backgroundAt(quietRow, 0), expectedBg({ kind: "calm" }, 0, 100, now));
	assert.equal(backgroundAt(quietRow, 0), backgroundAt(quietRow, 99));
	for (const quiet of [false, true]) for (const state of ["running", "stopping"] as const) {
		const animation = state === "running" ? JOB_ANIMATION : JOB_STOPPING_ANIMATION;
		for (const at of [0, 470, 100_750]) {
			const line = liveRow(theme, job({ state }), { width: 100, now: at, quiet, motion: "reduced" });
			assert.ok(plain(line).startsWith(`${glyphAt(animation, at, { reduced: true })} Build  $`));
		}
	}
	const stopping = liveRow(theme, job({ state: "stopping" }), { width: 100, now });
	assert.match(plain(stopping), /stopping · 1m00s/);
	assert.equal(colorOf(stopping, glyphAt(JOB_STOPPING_ANIMATION, now)), fgOf("#ecb64e"));
});

test("finished and delivery-failed live rows are exactly the transcript band", () => {
	for (const extra of [{ state: "done" as const, code: 0, endedAt: 4000 }, { deliveryFailed: true }, { state: "done" as const, code: 2, endedAt: 4000 }]) {
		const record = job(extra);
		assert.equal(liveRow(theme, record, { width: 80, now: 9000, tail: "ignored", progress: { share: .45, parts: [] } }), jobRow(theme, factsOf(record), { width: 80, now: 9000 }));
	}
});

test("an untitled live job still shows its command, not its id", () => {
	const line = plain(liveRow(theme, job({ title: null }), { width: 60, now: 9000 }));
	assert.ok(line.includes("$ make all  8.0s"));
	assert.ok(!line.includes("build"));
});

test("the latest output line is the last one with words, as a terminal shows it", () => {
	assert.equal(lastLine("one\ntwo\n\n"), "two");
	assert.equal(lastLine("progress 10%\rprogress 55%\n"), "progress 55%");
	assert.equal(lastLine("\x1b[32mgreen\x1b[0m\n"), "green");
	assert.equal(lastLine(""), undefined);
	assert.equal(lastLine("   \n\t\n"), undefined);
});

test("output sits in a gutter under the prompt, cut to the width", () => {
	const lines = gutterLines(theme, ["checked 42 files", "y".repeat(80)], 30);
	assert.equal(lines.length, 2);
	const text = lines.map(plain);
	assert.equal(text[0]!.trimEnd(), `  ${GUTTER} checked 42 files`);
	assert.ok(visibleWidth(text[1]!) <= 30);
	assert.ok(text[1]!.endsWith("…"), text[1]);
	assert.equal(colorOf(lines[0]!, "checked"), fgOf("#a8a69f"));
});

test("terminal controls in output never reach the screen", () => {
	const [line] = gutterLines(theme, ["\x1b[31mred\x1b[0m\x07 done\r"], 30);
	assert.equal(plain(line!).trimEnd(), `  ${GUTTER} red done`);
	assert.ok(!line!.includes("\x07"));
});

test("color codes whose ESC was stripped upstream don't show as text; ordinary brackets do", () => {
	assert.equal(cleanOutput("[32m✓[39m 212 passing[0m"), "✓ 212 passing");
	assert.equal(cleanOutput("[2K[1;33mwarn[0m"), "warn");
	assert.equal(cleanOutput("items[0] = [1, 2] and [see docs]"), "items[0] = [1, 2] and [see docs]");
});

test("a gutter line never runs past a terminal narrower than the gutter", () => {
	for (const width of [1, 2, 3, 4, 5]) for (const line of gutterLines(theme, ["output"], width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
});
