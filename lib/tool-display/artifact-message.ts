/**
 * The artifact extension's `artifact-feedback` message: what the owner sent
 * from the inbox (a form's answer, a comment on a page) while the agent
 * worked. Each change is a band, as a finished shell job is, with `⇠` in the
 * margin for something that came back: what came in, then the page's title,
 * and the count of fields in the rail. The fields sit in a gutter under it,
 * a few while collapsed; a click or ctrl+o shows all. Pages that were deleted
 * or expired get one band of their own.
 *
 * Tool Display registers it, as it does the mesh message (Pi asks every
 * extension for a renderer, so the sender need not own it): the artifact
 * extension comes from Dotfleet and draws nothing of its own. A message with
 * no changes in its details shows the text the model got under the band.
 */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bandBackground, paintLine, ROW_MARGIN, type Seg } from "../band/band.ts";
import { GUTTER } from "../band/job-look.ts";
import { expandable, expansionMemory } from "../band/message.ts";
import { paletteFrom, type BandTheme } from "../band/palette.ts";
import { sanitize } from "./format.ts";

export const ARTIFACT_FEEDBACK_TYPE = "artifact-feedback";
export const FEEDBACK_GLYPH = "⇠";
/** Gutter lines under each change while collapsed. */
export const FIELD_PREVIEW = 4;
/** Changes shown while collapsed; the rest fold into one line. */
export const CHANGE_PREVIEW = 3;
/** A field's value is cut here in the gutter: the popup of a row has room, a message line does not. */
const VALUE_CHARS = 2_000;

interface Change {
	readonly kind: "answer" | "comment";
	readonly artifact_id: string;
	readonly title: string;
	readonly data?: unknown;
	readonly anchor?: { readonly path?: unknown; readonly label?: unknown } | null;
	readonly thread?: unknown;
	readonly body?: unknown;
}

interface Details {
	readonly changes?: readonly unknown[];
	readonly gone?: readonly unknown[];
	readonly titles?: Readonly<Record<string, unknown>>;
}

function paintKey(theme: BandTheme, key: string, text: string): string {
	try { return theme.fg(key, text); } catch { return text; }
}

const clean = (text: unknown) => (typeof text === "string" ? sanitize(stripTerminalSequences(text)) : "");
const flat = (text: unknown) => clean(text).replace(/\s+/g, " ").trim();

function changesOf(details: Details | undefined): Change[] {
	return (Array.isArray(details?.changes) ? details.changes : []).filter((item): item is Change => {
		const c = item as Partial<Change> | null;
		return !!c && (c.kind === "answer" || c.kind === "comment") && typeof c.artifact_id === "string";
	});
}

function goneOf(details: Details | undefined): string[] {
	const titles = details?.titles && typeof details.titles === "object" ? details.titles : {};
	return (Array.isArray(details?.gone) ? details.gone : []).filter((id): id is string => typeof id === "string")
		.map((id) => flat(titles[id]) || flat(id));
}

/** A value as one line: text as written, a list joined, anything else as JSON. */
function valueText(value: unknown): string {
	if (typeof value === "string") return flat(value.slice(0, VALUE_CHARS));
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.map(flat).join(", ");
	return flat((JSON.stringify(value) ?? String(value)).slice(0, VALUE_CHARS));
}

/**
 * Gutter lines of one change: an answer's fields, key and value side by side, or a comment's
 * place and words. With `room` (expanded) long values wrap under themselves; else each is one line.
 */
function fieldLines(theme: BandTheme, change: Change, room?: number): string[] {
	const wrap = (text: string, width: number) => (room === undefined ? [text] : wrapTextWithAnsi(text, Math.max(1, width)));
	const paint = (key: string, text: string) => {
		try { return theme.fg(key, text); } catch { return text; }
	};
	if (change.kind === "comment") {
		const where = change.anchor && typeof change.anchor.path === "string" && change.anchor.path ? `on ${flat(change.anchor.label) || flat(change.anchor.path)}` : "on the whole page";
		const body = clean(change.body).replace(/\r/g, "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
		return [paint("dim", where), ...body.flatMap((line) => wrap(line, room ?? 0)).map((line) => paint("toolOutput", line))];
	}
	const data = change.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return [paint("toolOutput", valueText(data))];
	const entries = Object.entries(data as Record<string, unknown>).map(([key, value]) => [flat(key), value] as const);
	const keyWidth = Math.min(24, Math.max(0, ...entries.map(([key]) => visibleWidth(key))));
	const pad = " ".repeat(keyWidth + 2);
	return entries.flatMap(([key, value]) => {
		const text = valueText(value);
		const [first = "", ...rest] = text === "" ? [""] : wrap(text, (room ?? 0) - pad.length);
		const shown = text === "" ? paint("dim", "(empty)") : paint("toolOutput", first);
		return [`${paint("muted", truncateToWidth(key, keyWidth, "…").padEnd(keyWidth))}  ${shown}`, ...rest.map((line) => `${pad}${paint("toolOutput", line)}`)];
	});
}

function head(theme: BandTheme, width: number, what: Seg, title: string, rail: string): string {
	const palette = paletteFrom(theme);
	const bgAt = palette ? bandBackground(palette, { kind: "calm" }, width, 0, "reduced") : undefined;
	const left: Seg[] = [{ text: `${FEEDBACK_GLYPH} `, color: "accent" }, what, { text: `  ${title}`, color: "text" }];
	return paintLine(theme, palette, { width, left, indent: 0, rail: rail ? [{ text: rail, color: "dim" }] : [], ...(bgAt ? { bgAt } : {}), fallbackBg: "toolPendingBg" });
}

/** Painted lines in the gutter under a band, each cut to the width (job-look's gutterLines paints one color). */
function gutter(theme: BandTheme, lines: readonly string[], width: number): string[] {
	let bar = GUTTER;
	try { bar = theme.fg("border", GUTTER); } catch { /* plain */ }
	const room = Math.max(1, width - ROW_MARGIN - 2);
	return lines.map((line) => truncateToWidth(`${" ".repeat(ROW_MARGIN)}${bar} ${truncateToWidth(line, room, "…")}`, Math.max(1, width), "…"));
}

function expandHint(): string {
	try { return keyHint("app.tools.expand", "to expand"); } catch { return "ctrl+o to expand"; }
}

/** `… 3 more fields (ctrl+o to expand)` in the gutter. */
function hintLine(theme: BandTheme, width: number, text: string): string {
	const paint = (key: string, value: string) => {
		try { return theme.fg(key, value); } catch { return value; }
	};
	const said = `${paint("muted", `… ${text} (`)}${paint("dim", `click or ${expandHint()}`)}${paint("muted", ")")}`;
	return truncateToWidth(`${" ".repeat(ROW_MARGIN)}${paint("border", GUTTER)} ${truncateToWidth(said, Math.max(1, width - ROW_MARGIN - 2), "…")}`, Math.max(1, width), "…");
}

function changeBlock(theme: BandTheme, width: number, change: Change, expanded: boolean): string[] {
	const answer = change.kind === "answer";
	const count = answer && change.data && typeof change.data === "object" && !Array.isArray(change.data) ? Object.keys(change.data).length : 1;
	const fields = fieldLines(theme, change, expanded ? Math.max(1, width - ROW_MARGIN - 2) : undefined);
	const rail = answer ? (count === 1 ? "1 field" : `${count} fields`) : typeof change.thread === "number" ? `thread ${change.thread}` : "";
	const top = head(theme, width, { text: change.kind, color: "accent", bold: true }, flat(change.title) || flat(change.artifact_id), rail);
	// One line more shows in the space a hint for it would take.
	const shown = expanded || fields.length <= FIELD_PREVIEW + 1 ? fields : fields.slice(0, FIELD_PREVIEW);
	const hidden = fields.length - shown.length;
	const noun = answer ? "field" : "line";
	return [top, ...gutter(theme, shown, width), ...(hidden > 0 ? [hintLine(theme, width, `${hidden} more ${noun}${hidden === 1 ? "" : "s"}`)] : [])];
}

function textBlock(theme: BandTheme, width: number, text: string, expanded: boolean): string[] {
	const lines = clean(text).replace(/\r/g, "").replace(/\n+$/, "").split("\n").filter((line, index, all) => line !== "" || index < all.length - 1);
	const shown = expanded || lines.length <= FIELD_PREVIEW + 1 ? lines : lines.slice(0, FIELD_PREVIEW);
	const hidden = lines.length - shown.length;
	return [head(theme, width, { text: "feedback", color: "accent", bold: true }, "from the inbox", ""),
		...gutter(theme, shown.map((line) => paintKey(theme, "toolOutput", line)), width), ...(hidden > 0 ? [hintLine(theme, width, `${hidden} more line${hidden === 1 ? "" : "s"}`)] : [])];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: "text"; text: string } => !!part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

export function feedbackLines(theme: BandTheme, width: number, message: { content: unknown; details?: unknown }, expanded: boolean): string[] {
	const details = message.details && typeof message.details === "object" ? (message.details as Details) : undefined;
	const changes = changesOf(details);
	const gone = goneOf(details);
	if (changes.length === 0 && gone.length === 0) return textBlock(theme, width, textOf(message.content), expanded);
	const listed = expanded || changes.length <= CHANGE_PREVIEW + 1 ? changes : changes.slice(0, CHANGE_PREVIEW);
	const rest = changes.length - listed.length;
	return [
		...listed.flatMap((change) => changeBlock(theme, width, change, expanded)),
		...(rest > 0 ? [hintLine(theme, width, `${rest} more change${rest === 1 ? "" : "s"}`)] : []),
		...(gone.length > 0 ? [head(theme, width, { text: "gone", color: "muted", bold: true }, gone.join(", "), "deleted or expired")] : []),
	];
}

export function createArtifactFeedbackRenderer(): MessageRenderer {
	const memory = expansionMemory();
	return (message, options, theme) => expandable((width, expanded) => feedbackLines(theme as unknown as BandTheme, width, message, expanded),
		options.expanded, message as object, memory);
}
