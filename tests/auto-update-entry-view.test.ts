/**
 * The update entry in the transcript: the "start" entry shows nothing, the
 * "done" entry one line, and expanded the pi-extras notes between the versions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { updateEntryView } from "../lib/auto-update/entry-view.ts";
import { parseChangelog } from "../lib/release-notes.ts";

const CHANGELOG = parseChangelog([
	"# Changelog", "",
	"## 0.31.1 - 2026-10-26", "", "- Thirty-one one.", "",
	"## 0.31.0 - 2026-10-26", "", "- Thirty-one.", "",
	"## 0.30.0 - 2026-10-25", "", "- Thirty.",
].join("\n"));
const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
const markdownTheme = new Proxy({}, { get: () => (text: string) => text });
const hint = (description: string) => `ctrl+o ${description}`;
const view = (data: unknown, expanded: boolean) => updateEntryView(data, { expanded, theme, markdownTheme: markdownTheme as never, changelog: () => CHANGELOG, hint });
const lines = (data: unknown, expanded = false) => view(data, expanded)?.render(80).map((line) => stripTerminalSequences(line).trimEnd());
const DONE = { phase: "done", target: "t", text: "Updated pi-extras 0.30.0 → 0.31.1", extras: { from: "0.30.0", to: "0.31.1" } };

test("the start entry shows nothing: the done line says it all", () => {
	assert.equal(view({ phase: "start", target: "t", text: "Updating pi-extras 0.30.0 → 0.31.1: reloading" }, false), undefined);
	assert.equal(view({ phase: "start", target: "t", text: "x" }, true), undefined);
});

test("collapsed: one line with both versions and the key that shows the notes", () => {
	assert.deepEqual(lines(DONE), [" Updated pi-extras 0.30.0 → 0.31.1 · ctrl+o for what changed"]);
});

test("expanded: the line, then every pi-extras entry after the old version up to the new one", () => {
	const text = lines(DONE, true)!.join("\n");
	assert.match(text, /^ Updated pi-extras 0\.30\.0 → 0\.31\.1\n/);
	assert.match(text, /Thirty-one one\./);
	assert.match(text, /Thirty-one\./);
	assert.doesNotMatch(text, /Thirty\.$/m, "the old version's own notes are not new");
});

test("no notes in the range, an older entry or a broken one: a plain line or nothing", () => {
	assert.deepEqual(lines({ ...DONE, text: "Updated Pi 1.4.0 → 1.4.1", extras: undefined }, true), [" Updated Pi 1.4.0 → 1.4.1"]);
	assert.deepEqual(lines({ ...DONE, extras: { from: "0.31.1", to: "0.32.0" } }), [" Updated pi-extras 0.30.0 → 0.31.1"], "this changelog has no 0.32.0");
	assert.deepEqual(lines({ phase: "done", target: "t", text: "Updated: pi-extras 0.31.0" }), [" Updated: pi-extras 0.31.0"]);
	assert.equal(view({ phase: "done" }, false), undefined);
	assert.equal(view(undefined, false), undefined);
	assert.deepEqual(lines({ ...DONE, extras: { from: 3, to: "0.31.1" } }), [" Updated pi-extras 0.30.0 → 0.31.1"]);
});
