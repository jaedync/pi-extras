/**
 * A tool call the model is writing now: how much of its arguments came, when
 * they last grew, and the text it writes at the moment. Rows draw a pen from
 * it, a rail (`writing   1,204 chars   6.2s`) and the newest lines of the text.
 *
 * Some providers send a call's start and hold its arguments until the model
 * has written them all, so a draft can have no arguments for a long time.
 */
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatTime, type Seg } from "./band.ts";
import { glowing, glowLines, noteText, type GlowTheme, type Trail } from "./glow.ts";

/** Arguments that grew this recently still flow; after it, the pen slows and dims. */
export const FLOWING_MS = 400;
export const PREVIEW_LINES = 2;
export const CARET = "▍";
// Between values, a string this long is worth a preview; a name or a model id is not.
const LONG = 24;
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

const clean = (text: string): string => text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, "");

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
/** Whether the preview still fades, so its row keeps asking for frames. */
export const glows = (draft: Draft, now: number): boolean => glowing(draft.trail, now);

/** `writing   1,204 chars   6.2s`; a call with no arguments yet has no size. */
export function writingRail(chars: number, elapsedMs: number): Seg[] {
	const gap: Seg = { text: "   ", color: "dim" };
	const size: Seg[] = chars > 0 ? [gap, { text: `${chars.toLocaleString("en-US")} chars`, color: "muted" }] : [];
	return [{ text: "writing", color: "dim" }, ...size, gap, { text: formatTime(Math.max(1, elapsedMs)), color: "text" }];
}

export const draftRail = (draft: Draft, now: number): Seg[] => writingRail(draft.chars, now - draft.startedAt);

/** The newest lines of the text, new characters bright and fading, a caret after the last; `width` leaves the caret its column. */
export function draftPreview(draft: Draft, width: number, now: number, theme: GlowTheme, motion: "full" | "reduced", count = PREVIEW_LINES): string[] {
	if (!draft.text || width < 2 || count <= 0) return [];
	const lines = wrapTextWithAnsi(draft.text, width - 1).slice(-count);
	const painted = motion === "full" ? glowLines(lines, draft.text.length, draft.trail, now, theme, "muted") : lines.map((line) => theme.fg("muted", line));
	return painted.map((line, index) => (index === painted.length - 1 ? line + theme.fg("accent", CARET) : line));
}
