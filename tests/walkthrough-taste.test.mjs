import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { addNote, formatNote, main, notesPath, tasteText } from "../skills/walkthrough-video/scripts/film/taste.mjs";

function scratch() {
	return mkdtempSync(join(tmpdir(), "wv-taste-"));
}

test("notesPath lives in the user config, outside the skill folder", () => {
	assert.equal(notesPath({ HOME: "/h" }), "/h/.config/pi-walkthrough-video/taste-notes.md");
	assert.equal(notesPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" }), "/x/pi-walkthrough-video/taste-notes.md");
	assert.equal(notesPath({ HOME: "/h", WV_TASTE_NOTES: "/n.md" }), "/n.md");
});

test("formatNote dates the note and names the film", () => {
	const day = new Date("2026-10-29T12:00:00Z");
	assert.equal(formatNote("The end card is too long.", { film: "pointer v2", date: day }), "- 2026-10-29, pointer v2: \"The end card is too long.\"");
	assert.equal(formatNote("  Calmer music.  ", { date: day }), "- 2026-10-29: \"Calmer music.\"");
	assert.throws(() => formatNote("   ", { date: day }), /empty/);
});

test("addNote appends to the notes file and creates it with a heading", () => {
	const dir = scratch();
	try {
		const file = join(dir, "sub", "notes.md");
		const day = new Date("2026-10-29T12:00:00Z");
		addNote(file, "One.", { date: day });
		addNote(file, "Two.", { film: "f", date: day });
		const text = readFileSync(file, "utf8");
		assert.match(text, /^# Owner notes/);
		assert.ok(text.indexOf("\"One.\"") < text.indexOf("\"Two.\""));
		assert.match(text, /- 2026-10-29, f: "Two."\n$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tasteText gives the skill's taste file, then the owner's notes", () => {
	const dir = scratch();
	try {
		const file = join(dir, "notes.md");
		assert.match(tasteText(file), /# Taste/);
		assert.match(tasteText(file), /no notes yet/);
		writeFileSync(file, "# Owner notes\n\n- 2026-10-29: \"Slower end.\"\n");
		const text = tasteText(file);
		assert.ok(text.indexOf("# Taste") < text.indexOf("Slower end."));
		assert.match(text, /win over the taste file/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("main --add writes through WV_TASTE_NOTES, and --path prints the file", async () => {
	const dir = scratch();
	const saved = process.env.WV_TASTE_NOTES;
	const lines = [];
	const log = console.log;
	try {
		process.env.WV_TASTE_NOTES = join(dir, "n.md");
		console.log = (line) => lines.push(String(line));
		assert.equal(await main(["--add", "Fewer words.", "--film", "x"]), 0);
		assert.equal(await main(["--path"]), 0);
		assert.match(readFileSync(join(dir, "n.md"), "utf8"), /x: "Fewer words."/);
		assert.equal(lines.at(-1), join(dir, "n.md"));
		await assert.rejects(main(["--film", "x"]), /--film needs --add/);
	} finally {
		console.log = log;
		if (saved === undefined) delete process.env.WV_TASTE_NOTES;
		else process.env.WV_TASTE_NOTES = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the taste text asks for the input and its effect, and a subject that a phone can see, as kit guidance", () => {
	const taste = readFileSync(new URL("../skills/walkthrough-video/references/taste.md", import.meta.url), "utf8");
	const owner = taste.slice(taste.indexOf("## 9. Owner notes"));
	const kit = taste.slice(0, taste.indexOf("## 9. Owner notes"));
	assert.match(kit, /Show the input and its effect/);
	assert.match(kit, /game or a simulator/);
	assert.match(kit, /subject.*phone/is);
	// The owner did not say these: they are not in the owner's notes.
	assert.doesNotMatch(owner, /input and its effect/);
});
