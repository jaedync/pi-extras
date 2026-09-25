import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The version seen goes to pi-extras.json, so it must land in a scratch agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "release-notes-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const notes = await import("../lib/release-notes.ts");
const { default: releaseNotes } = await import("../extensions/release-notes.ts");
const { stripTerminalSequences } = await import("@earendil-works/pi-tui");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const CONFIG = join(agentDir, "pi-extras.json");

const SAMPLE = [
	"# Changelog", "", "Rules.", "",
	"## 0.7.0 - 2026-10-01", "", "### Added", "", "- Seven.", "",
	"## [0.6.1]", "", "- Six one.", "",
	"## Unreleased notes", "", "- Not a version.", "",
	"## 0.6.0 - 2026-09-26", "", "- Six.", "",
	"## 0.5.0 - 2026-09-25", "", "- Five.",
].join("\n");

test("the changelog parses into versioned entries, newest first", () => {
	const entries = notes.parseChangelog(SAMPLE);
	assert.deepEqual(entries.map((entry) => entry.version), ["0.7.0", "0.6.1", "0.6.0", "0.5.0"]);
	assert.equal(entries[0].markdown, "## 0.7.0 - 2026-10-01\n\n### Added\n\n- Seven.");
	assert.equal(entries[1].markdown, "## [0.6.1]\n\n- Six one.");
	assert.equal(notes.compareVersions("0.10.0", "0.9.9"), 1);
	assert.equal(notes.compareVersions("1.2.3", "1.2.3"), 0);
});

test("an update shows every entry since the version seen, and a fresh install nothing", () => {
	const entries = notes.parseChangelog(SAMPLE);
	const versions = (version, seen) => notes.notesToShow(entries, version, seen).map((entry) => entry.version);
	assert.deepEqual(versions("0.7.0", "0.6.0"), ["0.7.0", "0.6.1"]);
	assert.deepEqual(versions("0.7.0", "0.7.0"), []);
	// Nothing past the installed version, even if the file has it.
	assert.deepEqual(versions("0.6.1", "0.5.0"), ["0.6.1", "0.6.0"]);
	// 0.5 kept no record, so while 0.6 is current a missing one is an update from 0.5.
	assert.deepEqual(versions("0.6.1", undefined), ["0.6.1", "0.6.0"]);
	assert.deepEqual(versions("0.7.0", undefined), []);
});

test("the version seen is kept in pi-extras.json beside other settings", () => {
	const file = join(agentDir, "seen.json");
	assert.equal(notes.readSeen(file), undefined);
	notes.writeSeen("0.6.0", file);
	assert.equal(notes.readSeen(file), "0.6.0");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { releaseNotes: { seen: "0.6.0" } });
});

const theme = { fg: (_key, text) => text, bold: (text) => text };
const markdownTheme = new Proxy({}, { get: () => (text) => text });

test("the notes are framed like Pi's own, or one line when Pi collapses its changelog", () => {
	const full = new notes.NotesView({ version: "0.6.0", markdown: "## 0.6.0\n\n- Six." }, theme, markdownTheme).render(40).map(stripTerminalSequences);
	assert.equal(full[0], "─".repeat(40));
	assert.equal(full[1].trim(), "What's new in pi-extras");
	assert.ok(full.some((line) => line.includes("Six.")));
	assert.equal(full.at(-1), "─".repeat(40));
	const short = new notes.NotesView({ version: "0.6.0", markdown: "x", collapsed: true }, theme, markdownTheme).render(200).map(stripTerminalSequences);
	assert.equal(short.length, 3);
	assert.match(short[1], /pi-extras updated to 0\.6\.0\. Use \/pi-extras changelog/);
});

function app({ mode = "tui", messages = [] } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const appended = [];
	const renderers = new Map();
	const notices = [];
	const ctx = {
		mode, cwd: agentDir, isProjectTrusted: () => false,
		sessionManager: { getBranch: () => messages },
		ui: { notify: (text, level) => notices.push([text, level]) },
	};
	releaseNotes({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
		appendEntry: (type, data) => appended.push([type, data]),
	});
	return {
		appended, renderers, notices,
		start: () => handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx),
		run: (args) => commands.get("pi-extras").handler(args, ctx),
	};
}

test("the first new session after an update shows the notes once, and never to a resumed one", async (t) => {
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previous = notes.parseChangelog(changelog)[1]?.version ?? "0.0.1";
	notes.writeSeen(previous, CONFIG);
	// A session that already has messages is left alone, and so is print mode.
	app({ messages: [{ type: "message" }] }).start();
	app({ mode: "print" }).start();
	assert.equal(notes.readSeen(CONFIG), previous);
	const first = app();
	first.start();
	assert.equal(first.appended.length, 1);
	const [type, data] = first.appended[0];
	assert.equal(type, notes.NOTES_ENTRY);
	assert.equal(data.version, pkg.version);
	assert.match(data.markdown, new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")}`));
	assert.equal(notes.readSeen(CONFIG), pkg.version);
	const again = app();
	again.start();
	assert.equal(again.appended.length, 0);
	// /pi-extras changelog shows this version's notes on demand.
	await again.run("changelog");
	assert.equal(again.appended[0][1].markdown, data.markdown);
	await again.run("nope");
	assert.equal(again.notices.at(-1)[1], "warning");
	// A malformed entry draws nothing rather than breaking the transcript.
	assert.equal(again.renderers.get(notes.NOTES_ENTRY)({ data: { version: 1 } }, { expanded: false }, theme), undefined);
});
