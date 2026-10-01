import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, transition, view, sanitize, escapeValue, statusSequence, progressSequence, passthrough, terminalSupport, loadSettings, shouldRun } from "../lib/tab-status/core.ts";

const colors = { accent: "#123456", warning: "#abcdef", dim: "#777777", error: "#ff0000" };
const shown = (state: ReturnType<typeof initialState>, background = true) => view(state, colors, background);

test("run stays working through errors/retries until settlement; next prompt clears failure", () => {
	let s = initialState();
	assert.equal(shown(s).status, "idle");
	s = transition(s, { type: "begin" });
	assert.equal(shown(s).detail, "thinking");
	s = transition(s, { type: "message", text: "", error: "bad\nsecret second line" });
	assert.equal(shown(s).status, "working");
	assert.equal(shown(s).detail, "retrying");
	s = transition(s, { type: "settled" });
	assert.deepEqual(shown(s), { status: "waiting", color: colors.error, detail: "Error: bad", progress: 2 });
	s = transition(s, { type: "begin" });
	assert.equal(shown(s).progress, 3);
	s = transition(s, { type: "message", text: "Done.\nmore" });
	s = transition(s, { type: "settled" });
	assert.equal(shown(s).detail, "Done");
	assert.equal(view(s, colors, true, "reply").detail, "Done.");
	assert.equal(shown(s).progress, 0);
});

test("parallel tools, writing calls, nested dialogs and compaction", () => {
	let s = transition(initialState(), { type: "begin" });
	s = transition(s, { type: "phase", text: "writing bash call" });
	assert.equal(shown(s).detail, "writing bash call");
	for (const id of ["a", "b", "c"]) s = transition(s, { type: "toolStart", id, name: "bash" });
	assert.equal(shown(s).detail, "running 3 tools");
	s = transition(s, { type: "dialogStart", title: "Allow bash?" });
	assert.deepEqual(shown(s), { status: "waiting", color: colors.warning, detail: "Allow bash?", progress: 4 });
	s = transition(s, { type: "dialogEnd" });
	for (const id of ["a", "b"]) s = transition(s, { type: "toolEnd", id });
	assert.equal(shown(s).detail, "running bash");
	s = transition(s, { type: "compactStart" });
	assert.equal(shown(s).detail, "compacting");
	s = transition(s, { type: "compactEnd", retry: true });
	assert.equal(shown(s).detail, "retrying");
	s = transition(s, { type: "settled" });
	assert.equal(shown(s).status, "idle");
});

test("background snapshots replace counts, optional busy and rate waits", () => {
	let s = initialState();
	s = transition(s, { type: "background", source: "subagents", count: 2 });
	assert.equal(shown(s).status, "working");
	assert.equal(shown(s, false).status, "idle");
	s = transition(s, { type: "background", source: "shell-jobs", count: 1 });
	s = transition(s, { type: "background", source: "subagents", count: 0 });
	assert.equal(shown(s).detail, "running 1 shell job");
	s = transition(s, { type: "background", source: "shell-jobs", count: 0 });
	assert.equal(shown(s).status, "idle");
	s = transition(s, { type: "begin" });
	s = transition(s, { type: "rateWait", active: true });
	assert.equal(shown(s).status, "working");
	assert.equal(shown(s).progress, 4);
	s = transition(s, { type: "rateWait", active: false });
	assert.equal(shown(s).progress, 3);
});

test("sanitize, escape every value, truncate by code point, and clear all fields", () => {
	assert.equal(sanitize("\x1b[31mhello\x1b[0m\x07\x00\x85\nsecond"), "hello");
	assert.equal(sanitize("😀".repeat(90)).length, 160);
	assert.equal(sanitize("hello\u2028private second line"), "hello");
	assert.equal(escapeValue("a\\b;c\x1b\x07"), "a\\\\b\\;c");
	assert.equal(statusSequence({ status: "working", color: "#123456", detail: "a;b\\c" }), "\x1b]21337;status=working;indicator=#123456;status-color=#123456;detail=a\\;b\\\\c\x1b\\");
	assert.equal(statusSequence(), "\x1b]21337;status=;indicator=;status-color=;detail=\x1b\\");
	for (const state of [0, 2, 3] as const) assert.equal(progressSequence(state), `\x1b]9;4;${state}\x07`);
	assert.equal(progressSequence(4), "\x1b]9;4;4;100\x07");
	assert.equal(escapeValue("a\u200bb\u202ec\u2066d\ufeffe\u200f"), "abcde");
	const seq = statusSequence();
	assert.equal(passthrough(seq, false), seq);
	assert.equal(passthrough(seq, true), `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
});

for (const state of [0, 2, 3, 4] as const) {
	test(`Windows Terminal progress state ${state} includes an explicit percentage`, () => {
		// Error and paused fill the ring; at 0 Windows Terminal draws only a sliver.
		const sequence = `\x1b]9;4;${state};${state === 2 || state === 4 ? 100 : 0}\x07`;
		assert.equal(progressSequence(state, true), sequence);
		assert.equal(passthrough(progressSequence(state, true), true), `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
	});
}

test("known terminals, forced progress, setting validation, and interactive guards", () => {
	for (const env of [{ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.0" }, { LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.7.0" }]) assert.deepEqual(terminalSupport(env), { sessionStatus: true, progress: true });
	for (const env of [{ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20250209-182623-44866cc1" }, { TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.0" }, { WT_SESSION: "id", LC_TERMINAL_VERSION: "1.6.0" }]) assert.deepEqual(terminalSupport(env), { sessionStatus: false, progress: true });
	assert.deepEqual(terminalSupport({ TERM: "xterm-256color" }), { sessionStatus: false, progress: false });
	assert.deepEqual(loadSettings({}), { enabled: true, sessionStatus: "auto", progress: "auto", busyWhileBackground: true, detail: "done" });
	assert.equal(loadSettings({ progress: "yes", enabled: 0 }).progress, "auto");
	assert.equal(loadSettings({ progress: false }).progress, false);
	assert.equal(shouldRun({ hasUI: true, mode: "tui" }, true), true);
	for (const mode of ["print", "json", "rpc"]) assert.equal(shouldRun({ hasUI: true, mode }, true), false);
	assert.equal(shouldRun({ hasUI: false, mode: "tui" }, true), false);
	assert.equal(shouldRun({ hasUI: true, mode: "tui" }, false), false);
});
