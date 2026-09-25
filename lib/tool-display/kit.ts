/**
 * What the tool row renderers share: the host's highlighting, diff and hint
 * helpers (injected so tests can run without a live Pi), a theme painter and
 * width-aware line helpers.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitize } from "./format.ts";
import { Slot, rowState, type Density, type Paint, type PaintKey, type RowState } from "./slot.ts";

export interface Kit {
	readonly density: () => Density;
	/** The expand hint, e.g. `ctrl+o to expand`, styled by the host. */
	readonly hint: () => string;
	/** One output line per input line, or anything else to fall back to plain text. */
	readonly highlight: (code: string, lang: string) => string[];
	readonly language: (path: string) => string | undefined;
	/** Pi's colored diff for the `details.diff` its edit tool returns. */
	readonly diff: (diff: string) => string;
	/** Wraps styled text in a terminal hyperlink when the terminal supports one. */
	readonly link: (styled: string, absolutePath: string) => string;
	readonly now: () => number;
}

export interface ThemeLike {
	fg(key: string, text: string): string;
	bg(key: string, text: string): string;
	bold(text: string): string;
}

/** A theme missing a key degrades to plain text rather than breaking the row. */
export function painter(theme: ThemeLike): Paint {
	const safe = (paint: () => string, text: string) => {
		try { return paint(); } catch { return text; }
	};
	return {
		fg: (key, text) => safe(() => theme.fg(key, text), text),
		bg: (key, text) => safe(() => theme.bg(key, text), text),
		bold: (text) => safe(() => theme.bold(text), text),
	};
}

/** The subset of Pi's render context the rows use. */
export interface RenderContext {
	readonly args: unknown;
	readonly state: Record<string, unknown>;
	readonly lastComponent: unknown;
	readonly cwd: string;
	readonly executionStarted: boolean;
	readonly argsComplete: boolean;
	readonly isPartial: boolean;
	readonly expanded: boolean;
	readonly isError: boolean;
	invalidate(): void;
}

export interface RowParts {
	readonly slot: Slot;
	readonly row: RowState;
	readonly paint: Paint;
	readonly state: Record<string, unknown>;
}

/** The slot Pi handed back last time, or a new one, with the row state brought up to date. */
export function slotFor(kind: "call" | "result", kit: Kit, theme: ThemeLike, context: RenderContext): RowParts {
	const state = context.state;
	const row = rowState(state, context);
	if (kind === "result") row.hasResult = true;
	state.paint = painter(theme);
	const slot = context.lastComponent instanceof Slot
		? context.lastComponent
		: new Slot({ kind, row, density: kit.density, paint: () => state.paint as Paint });
	return { slot, row, paint: state.paint as Paint, state };
}

export const title = (paint: Paint, name: string) => paint.fg("toolTitle", paint.bold(name));

/** Joins metadata parts behind a separator; empty parts are dropped. */
export function meta(paint: Paint, parts: ReadonlyArray<readonly [PaintKey, string] | undefined>): string {
	const shown = parts.filter((part): part is readonly [PaintKey, string] => !!part && part[1] !== "");
	return shown.map(([key, text]) => `${paint.fg("muted", " · ")}${paint.fg(key, text)}`).join("");
}

/**
 * One header line. The metadata stays visible and the main text is cut to
 * fit; expanded, the header wraps instead.
 */
export function header(main: string, tail: string, width: number, expanded: boolean): string[] {
	if (expanded) return wrapTextWithAnsi(main + tail, width);
	const tailWidth = visibleWidth(tail);
	if (visibleWidth(main) + tailWidth <= width) return [main + tail];
	if (tailWidth > width / 2) return [truncateToWidth(main + tail, width, "…")];
	return [truncateToWidth(main, width - tailWidth, "…") + tail];
}

export function more(paint: Paint, kit: Kit, text: string): string {
	return `${paint.fg("muted", `… ${text} (`)}${kit.hint()}${paint.fg("muted", ")")}`;
}

export const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? word : many}`;

export function wrapAll(lines: readonly string[], width: number): string[] {
	return lines.flatMap((line) => wrapTextWithAnsi(line, width));
}

/** The last `max` visual lines of `lines` at `width`, wrapping only what is shown. */
export function tail(lines: readonly string[], max: number, width: number): { lines: string[]; skipped: number } {
	const shown: string[] = [];
	let index = lines.length - 1;
	for (; index >= 0 && shown.length < max; index--) {
		const wrapped = wrapTextWithAnsi(lines[index]!, width);
		shown.unshift(...wrapped.slice(Math.max(0, wrapped.length - (max - shown.length))));
	}
	const hiddenRows = index + 1;
	return { lines: shown, skipped: hiddenRows };
}

/** Text blocks of a tool result, stripped of terminal sequences and control bytes. */
export function resultText(result: { content?: unknown }): string {
	const blocks = Array.isArray(result.content) ? result.content : [];
	const text = blocks
		.filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("\n");
	return sanitize(stripTerminalSequences(text));
}

export const hasImage = (result: { content?: unknown }) =>
	Array.isArray(result.content) && result.content.some((block) => !!block && typeof block === "object" && (block as { type?: unknown }).type === "image");

export function stringArg(args: unknown, ...keys: string[]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	for (const key of keys) {
		const value = (args as Record<string, unknown>)[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

export function numberArg(args: unknown, key: string): number | undefined {
	const value = args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A path as Pi shows it: home as `~`, accent colored and linked to the file. */
export function pathText(paint: Paint, kit: Kit, raw: string | undefined, cwd: string, fallback = "…"): string {
	if (!raw) return paint.fg("toolOutput", fallback);
	const clean = sanitize(raw).replace(/\n/g, " ").replace(/^@/, "");
	const home = homedir();
	const shown = clean.startsWith(home) ? `~${clean.slice(home.length)}` : clean;
	const absolute = isAbsolute(clean) ? clean : resolve(cwd, clean.replace(/^~(?=\/|$)/, home));
	return kit.link(paint.fg("accent", shown), absolute);
}

/** Highlighted lines, or plain output-colored lines when the highlighter is unavailable or disagrees. */
export function codeLines(paint: Paint, kit: Kit, lines: readonly string[], lang: string | undefined): string[] {
	if (lang) {
		try {
			const highlighted = kit.highlight(lines.join("\n"), lang);
			if (highlighted.length === lines.length) return highlighted;
		} catch {
			// Fall through to plain text.
		}
	}
	return lines.map((line) => paint.fg("toolOutput", line));
}

export function errorLines(paint: Paint, text: string): string[] {
	const trimmed = text.trim();
	return trimmed ? trimmed.split("\n").map((line) => paint.fg("error", line)) : [];
}
