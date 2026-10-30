/**
 * wv taste: prints the skill's taste file (references/taste.md) and then the
 * owner's own notes, which win over it. `--add` appends one owner note.
 *
 * The notes live in the user's config folder, not in the skill folder, so a
 * package update does not overwrite them.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../lib/args.mjs";

const TASTE_FILE = new URL("../../references/taste.md", import.meta.url);

const USAGE = `Usage: wv taste [--add "<note>" [--film <name>]] [--path]

Prints the taste file of the skill (references/taste.md), then the owner's notes.
The owner's notes win over the taste file. Read both before you plan a film,
and give both to the reviewer.

Options:
  --add <note>   append one owner note, dated today, in the owner's own words
  --film <name>  the film that the note is about (with --add)
  --path         print the path of the notes file

The notes file is \${WV_TASTE_NOTES}, or
\${XDG_CONFIG_HOME:-~/.config}/pi-walkthrough-video/taste-notes.md.`;

/**
 * The owner's notes file.
 * @param {Record<string, string | undefined>} env
 */
export function notesPath(env = process.env) {
	if (env.WV_TASTE_NOTES) return env.WV_TASTE_NOTES;
	const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
	return join(config, "pi-walkthrough-video", "taste-notes.md");
}

/**
 * One note as a list line: the date, the film and the owner's words.
 * @param {string} note
 * @param {{film?: string, date?: Date}} [options]
 */
export function formatNote(note, { film, date = new Date() } = {}) {
	const words = String(note).trim().replace(/\s+/g, " ");
	if (!words) throw new UsageError("taste: the note is empty");
	const day = date.toISOString().slice(0, 10);
	return `- ${day}${film ? `, ${film}` : ""}: "${words}"`;
}

/**
 * Appends one note; makes the file with a heading when it does not exist.
 * @param {string} file
 * @param {string} note
 * @param {{film?: string, date?: Date}} [options]
 */
export function addNote(file, note, options = {}) {
	const line = formatNote(note, options);
	if (!existsSync(file)) {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, "# Owner notes\n\nEach line is one note from the owner about a film, in the owner's words.\n\n");
	}
	appendFileSync(file, `${line}\n`);
	return line;
}

/**
 * The taste file, then the owner's notes.
 * @param {string} file the notes file
 */
export function tasteText(file) {
	const taste = readFileSync(TASTE_FILE, "utf8").trimEnd();
	const notes = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
	const tail = notes
		? `The owner's notes (${file}). They win over the taste file.\n\n${notes}`
		: `The owner's notes: no notes yet (${file}).`;
	return `${taste}\n\n---\n\n${tail}\n`;
}

/** @param {string[]} argv */
export async function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(USAGE);
		return 0;
	}
	let parsed;
	try {
		parsed = parseArgs({ args: argv, allowPositionals: false, strict: true, options: { add: { type: "string" }, film: { type: "string" }, path: { type: "boolean" } } });
	} catch (error) {
		throw new UsageError(`taste: ${/** @type {Error} */ (error).message}`);
	}
	const { values } = parsed;
	const file = notesPath();
	if (values.film !== undefined && values.add === undefined) throw new UsageError("taste: --film needs --add");
	if (values.add !== undefined) {
		console.log(`${addNote(file, values.add, { film: values.film })}\n  added to ${file}`);
		return 0;
	}
	if (values.path) {
		console.log(file);
		return 0;
	}
	process.stdout.write(tasteText(file));
	return 0;
}
