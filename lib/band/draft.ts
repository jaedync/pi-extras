/**
 * A tool call the model is writing now: how much of its arguments came, when
 * they last grew, and the text it writes at the moment. Rows draw a pen from
 * it, a rail (`writing   1,204 chars   6.2s`) and the newest lines of the text.
 *
 * Some providers send a call's start and hold its arguments until the model
 * has written them all, so a draft can have no arguments for a long time.
 */
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatTime, type Seg } from "./band.ts";
import { glowLines, noteText, type GlowTheme, type Trail } from "./glow.ts";

/** Arguments that grew this recently still flow; after it, the pen slows and dims. */
export const FLOWING_MS = 400;
export const PREVIEW_LINES = 2;
export const CARET = "▍";
// Between values, a string this long is worth a preview; a name or a model id is not.
const LONG = 24;
// Times the preview's room that a tail keeps before it is wrapped.
const TAIL_SLACK = 3;
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export interface Draft {
	/** The arguments last seen, so the same object costs nothing on the next frame. */
	readonly args: unknown;
	readonly chars: number;
	readonly startedAt: number;
	readonly changedAt: number;
	readonly text: string;
	readonly trail?: Trail;
}

interface Leaf { readonly path: string; readonly text?: string }
function leaves(value: unknown, path: string, out: Leaf[]): Leaf[] {
	if (typeof value === "string") out.push({ path, text: value });
	else if (Array.isArray(value)) value.forEach((item, index) => leaves(item, `${path}/${index}`, out));
	else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) leaves(item, `${path}/${key}`, out);
	else out.push({ path });
	return out;
}
const pick = (args: unknown): Leaf | undefined => {
	const all = leaves(args, "", []);
	const last = all[all.length - 1];
	return last?.text !== undefined ? last : all.filter((leaf) => (leaf.text?.length ?? 0) >= LONG).pop();
};

/** The string being written: the last value when it is a string, else the last long one. Partial JSON keeps key order. */
export const writingText = (args: unknown): string => pick(args)?.text ?? "";

/** Model text made safe to paint: no escapes or control characters, tabs as spaces. */
export const cleanText = (text: string): string => text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, "");
const clean = cleanText;

export function noteDraft(prev: Draft | undefined, args: unknown, now: number): Draft {
	if (prev && prev.args === args) return prev;
	const json = JSON.stringify(args ?? {}) ?? "";
	const chars = json === "{}" ? 0 : json.length;
	const leaf = pick(args);
	const text = clean(leaf?.text ?? "");
	return {
		args, chars, text,
		startedAt: prev?.startedAt ?? now,
		changedAt: prev && chars <= prev.chars ? prev.changedAt : chars > 0 ? now : prev?.changedAt ?? now,
		trail: leaf ? noteText(prev?.trail, leaf.path, text.length, now) : prev?.trail,
	};
}

export const flowing = (draft: Draft, now: number): boolean => draft.chars > 0 && now - draft.changedAt < FLOWING_MS;

/** `writing   1,204 chars   6.2s`; a call with no arguments yet has no size. */
export function writingRail(chars: number, elapsedMs: number): Seg[] {
	const gap: Seg = { text: "   ", color: "dim" };
	const size: Seg[] = chars > 0 ? [gap, { text: `${chars.toLocaleString("en-US")} chars`, color: "muted" }] : [];
	return [{ text: "writing", color: "dim" }, ...size, gap, { text: formatTime(Math.max(1, elapsedMs)), color: "text" }];
}

export const draftRail = (draft: Draft, now: number): Seg[] => writingRail(draft.chars, now - draft.startedAt);

/** The newest lines of the text, new characters bright and fading, a caret after the last; `width` leaves the caret its column. */
export const draftPreview = (draft: Draft, width: number, now: number, theme: GlowTheme, motion: "full" | "reduced", count = PREVIEW_LINES): string[] =>
	previewLines({ text: draft.text, length: draft.text.length, trail: draft.trail }, width, now, theme, motion, "muted", count);

/** A cleaned text, or the tail of one, whose last character is number `length` of what the trail counts. */
export interface Streamed { readonly text: string; readonly length: number; readonly trail: Trail | undefined }

/**
 * The end of a text that holds its last `count` lines at `width`: wrapping
 * costs the whole text, which can be a 200 KB file. A wrap from the start of
 * the paragraph is exact; in a long paragraph the cut moves in fixed steps, so
 * the lines keep their breaks while the text grows. Cut at a space, so the
 * first word stays whole.
 */
export function wrapTail(text: string, width: number, count: number): string {
	const budget = (count + 1) * Math.max(1, width) * TAIL_SLACK;
	if (text.length <= 2 * budget) return text;
	const paragraph = text.lastIndexOf("\n", text.length - budget);
	if (paragraph >= 0 && text.length - paragraph <= 4 * budget) return text.slice(paragraph + 1);
	const cut = Math.floor((text.length - budget) / budget) * budget;
	const space = text.indexOf(" ", cut);
	return text.slice(space >= 0 && space < text.length - 1 ? space + 1 : cut);
}

export function previewLines(streamed: Streamed, width: number, now: number, theme: GlowTheme, motion: "full" | "reduced", base: string, count = PREVIEW_LINES): string[] {
	if (!streamed.text.trim() || width < 2 || count <= 0) return [];
	const lines = wrapTextWithAnsi(wrapTail(streamed.text, width - 1, count), width - 1).slice(-count);
	const painted = motion === "full" ? glowLines(lines, streamed.length, streamed.trail, now, theme, base) : lines.map((line) => theme.fg(base, line));
	// A wide character can overrun a one-column wrap; the caret takes the last column.
	return painted.map((line, index) => (index === painted.length - 1 ? truncateToWidth(line, width - 1, "") + theme.fg("accent", CARET) : truncateToWidth(line, width, "")));
}
