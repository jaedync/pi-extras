/**
 * release-notes: after an update, the first new session shows what changed in
 * pi-extras, once per version. `/pi-extras changelog` shows it again.
 *
 * The notes are a custom entry: drawn in the transcript, never sent to the model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getMarkdownTheme, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { operationalError } from "../lib/operational-log.ts";
import { NOTES_ENTRY, NotesView, notesToShow, parseChangelog, readSeen, writeSeen, type NotesData, type NotesEntry } from "../lib/release-notes.ts";

const PACKAGE = new URL("../package.json", import.meta.url);
const CHANGELOG = new URL("../CHANGELOG.md", import.meta.url);
const LOG_FILE = join(getAgentDir(), "pi-extras.log");

function installed(): { version: string; entries: NotesEntry[] } | undefined {
	try {
		const version = (JSON.parse(readFileSync(PACKAGE, "utf8")) as { version?: unknown }).version;
		if (typeof version !== "string") return undefined;
		return { version, entries: parseChangelog(readFileSync(CHANGELOG, "utf8")) };
	} catch (error) {
		operationalError(LOG_FILE, "release-notes", `could not read the changelog: ${(error as Error).message}`);
		return undefined;
	}
}

function collapsed(ctx: ExtensionContext): boolean {
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCollapseChangelog();
	} catch {
		return false;
	}
}

export default function releaseNotes(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<NotesData>(NOTES_ENTRY, (entry, _options, theme) => {
		const data = entry.data;
		if (typeof data?.version !== "string" || typeof data.markdown !== "string") return undefined;
		return new NotesView(data, theme, getMarkdownTheme());
	});

	pi.on("session_start", (_event, ctx) => {
		// Like Pi's own notes: only in the terminal, and only for a session with nothing in it yet.
		if (ctx.mode !== "tui") return;
		if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return;
		const current = installed();
		if (current === undefined) return;
		const seen = readSeen();
		if (seen === current.version) return;
		const shown = notesToShow(current.entries, current.version, seen);
		try {
			writeSeen(current.version);
		} catch (error) {
			// Without a record the notes would come back every session; better not to show them.
			operationalError(LOG_FILE, "release-notes", `could not record the version seen: ${(error as Error).message}`);
			return;
		}
		if (shown.length === 0) return;
		const data: NotesData = { version: current.version, markdown: shown.map((entry) => entry.markdown).join("\n\n"), collapsed: collapsed(ctx) };
		pi.appendEntry(NOTES_ENTRY, data);
	});

	pi.registerCommand("pi-extras", {
		description: "Show what changed in this version of pi-extras",
		getArgumentCompletions: (prefix) => ("changelog".startsWith(prefix.trim().toLowerCase()) ? [{ value: "changelog", label: "changelog", description: "What changed in this version" }] : null),
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() !== "changelog") {
				ctx.ui.notify("Use /pi-extras changelog.", "warning");
				return;
			}
			const current = installed();
			const entry = current?.entries.find((candidate) => candidate.version === current.version);
			if (current === undefined || entry === undefined) {
				ctx.ui.notify("This copy of pi-extras has no notes for its version.", "warning");
				return;
			}
			pi.appendEntry(NOTES_ENTRY, { version: current.version, markdown: entry.markdown } satisfies NotesData);
		},
	});
}
