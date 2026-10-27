/**
 * How the update entry draws in the transcript. The "start" entry exists for
 * the loop guard (session.ts counts it) and shows nothing; the "done" entry is
 * one dim line with the time it happened, and expanded it shows the pi-extras
 * notes since the old version.
 */
import { Container, Text, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { dateFormat, dateMs } from "../date-format.ts";
import { compareVersions, NotesView, type NotesEntry, type NotesTheme } from "../release-notes.ts";
import { STATUS_TIME_ZONE } from "../status-plus-logic.ts";

export interface EntryViewDeps {
	readonly expanded: boolean;
	readonly theme: NotesTheme & { fg(key: "dim", text: string): string };
	readonly markdownTheme: MarkdownTheme;
	/** The changelog of the running pi-extras: newer than any version an older entry names. */
	readonly changelog: () => readonly NotesEntry[];
	/** The expand key and a description, styled like Pi's own hints. */
	readonly hint: (description: string) => string;
	/** The entry's timestamp; the clock and zone that place it are for tests. */
	readonly at?: string;
	readonly now?: () => number;
	readonly timeZone?: string;
}

/** When the update happened: the time on the same day, else the date, with the year when it differs. */
export function updatedWhen(at: number, now: number, timeZone = STATUS_TIME_ZONE): string | undefined {
	if (dateMs(at) === undefined || dateMs(now) === undefined) return undefined;
	const day = dateFormat("ymd", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
	const [then, today] = [day.format(at), day.format(now)];
	if (then === today) return dateFormat("h:mm", timeZone, { hour: "numeric", minute: "2-digit" }).format(at);
	const year = then.slice(-4) !== today.slice(-4);
	return dateFormat(year ? "mmm d, yyyy" : "mmm d", timeZone, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) }).format(at);
}

const VERSION = /^\d+\.\d+\.\d+$/;

function range(extras: unknown): { readonly from: string; readonly to: string } | undefined {
	if (typeof extras !== "object" || extras === null) return undefined;
	const { from, to } = extras as { from?: unknown; to?: unknown };
	return typeof from === "string" && typeof to === "string" && VERSION.test(from) && VERSION.test(to) ? { from, to } : undefined;
}

function notesBetween(entries: readonly NotesEntry[], from: string, to: string): NotesEntry[] {
	return entries.filter((entry) => compareVersions(entry.version, from) > 0 && compareVersions(entry.version, to) <= 0);
}

export function updateEntryView(data: unknown, deps: EntryViewDeps): Component | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { phase, text, extras } = data as { phase?: unknown; text?: unknown; extras?: unknown };
	if (phase !== "done" || typeof text !== "string") return undefined;
	const versions = range(extras);
	let notes: NotesEntry[] = [];
	if (versions) {
		try {
			notes = notesBetween(deps.changelog(), versions.from, versions.to);
		} catch {
			// An unreadable changelog: the line alone still says what happened.
		}
	}
	const when = deps.at === undefined ? undefined : updatedWhen(Date.parse(deps.at), (deps.now ?? Date.now)(), deps.timeZone);
	const line = deps.theme.fg("dim", when ? `${text} · ${when}` : text);
	if (notes.length === 0) return new Text(line, 1, 0);
	if (!deps.expanded) return new Text(`${line}${deps.theme.fg("dim", " · ")}${deps.hint("for what changed")}`, 1, 0);
	const box = new Container();
	box.addChild(new Text(line, 1, 0));
	box.addChild(new NotesView({ version: versions!.to, markdown: notes.map((entry) => entry.markdown).join("\n\n") }, deps.theme, deps.markdownTheme));
	return box;
}
