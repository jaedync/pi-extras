/**
 * release-notes: what changed in pi-extras, shown once after an update.
 *
 * Pi shows its own changelog the same way: the first new session after an
 * update gets the entries newer than the version last seen, and a fresh
 * install is recorded without showing anything. The version seen is kept in
 * pi-extras.json, since Pi's own record is for Pi.
 */
import { Markdown, truncateToWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { readSection, writeSection } from "./extras-config.ts";

export const NOTES_SECTION = "releaseNotes";
export const NOTES_ENTRY = "pi-extras-release-notes";

/**
 * Releases before 0.6 kept no record, so a missing one cannot tell a fresh
 * install from an update. While 0.6 is current, a missing record is read as
 * an update from 0.5, so everyone updating sees what changed; from 0.7 on it
 * means a fresh install again.
 */
const UNRECORDED = { series: "0.6.", since: "0.5.0" };

export interface NotesEntry {
	readonly version: string;
	/** The entry as written, from its `## x.y.z` heading to the next. */
	readonly markdown: string;
}

/** What a notes entry in the session holds. */
export interface NotesData {
	readonly version: string;
	readonly markdown: string;
	/** Pi's collapseChangelog: one line instead of the notes. */
	readonly collapsed?: boolean;
}

const HEADING = /^##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/;

/** Entries newest first, as the file lists them. */
export function parseChangelog(text: string): NotesEntry[] {
	const entries: NotesEntry[] = [];
	let current: { version: string; lines: string[] } | undefined;
	for (const line of text.split("\n")) {
		const match = HEADING.exec(line);
		if (match) {
			if (current) entries.push({ version: current.version, markdown: current.lines.join("\n").trim() });
			current = { version: `${match[1]}.${match[2]}.${match[3]}`, lines: [line] };
		} else if (line.startsWith("## ")) {
			if (current) entries.push({ version: current.version, markdown: current.lines.join("\n").trim() });
			current = undefined;
		} else current?.lines.push(line);
	}
	if (current) entries.push({ version: current.version, markdown: current.lines.join("\n").trim() });
	return entries;
}

export function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	return 0;
}

/** The entries to show for `version` when `seen` was the last one shown, or none for a fresh install. */
export function notesToShow(entries: readonly NotesEntry[], version: string, seen: string | undefined): NotesEntry[] {
	const since = seen ?? (version.startsWith(UNRECORDED.series) ? UNRECORDED.since : undefined);
	if (since === undefined) return [];
	return entries.filter((entry) => compareVersions(entry.version, since) > 0 && compareVersions(entry.version, version) <= 0);
}

export function readSeen(file?: string): string | undefined {
	const seen = readSection(NOTES_SECTION, file).seen;
	return typeof seen === "string" && /^\d+\.\d+\.\d+$/.test(seen) ? seen : undefined;
}

export function writeSeen(version: string, file?: string): void {
	writeSection(NOTES_SECTION, { seen: version }, file);
}

export interface NotesTheme {
	fg(key: "accent" | "border" | "muted", text: string): string;
	bold(text: string): string;
}

/** Framed like Pi's own "What's New": a rule, the title, the notes, a rule. */
export class NotesView implements Component {
	private readonly data: NotesData;
	private readonly theme: NotesTheme;
	private readonly markdown: Markdown | undefined;

	constructor(data: NotesData, theme: NotesTheme, markdownTheme: MarkdownTheme) {
		this.data = data;
		this.theme = theme;
		this.markdown = data.collapsed ? undefined : new Markdown(data.markdown, 1, 0, markdownTheme);
	}

	render(width: number): string[] {
		const rule = this.theme.fg("border", "\u2500".repeat(Math.max(1, width)));
		if (this.markdown === undefined) {
			const line = `pi-extras updated to ${this.data.version}. Use ${this.theme.bold("/pi-extras changelog")} to read what changed.`;
			return [rule, truncateToWidth(` ${line}`, width), rule];
		}
		const title = ` ${this.theme.bold(this.theme.fg("accent", "What's new in pi-extras"))}`;
		return [rule, truncateToWidth(title, width), "", ...this.markdown.render(width), "", rule];
	}

	invalidate(): void {
		this.markdown?.invalidate();
	}
}
