/**
 * What the tool row renderers share: the host's highlighting, diff and hint
 * helpers (injected so tests can run without a live Pi), the animation clock,
 * chain records, the popup opener, and text helpers.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Motion, Seg } from "../band/band.ts";
import type { AnimationClock } from "../band/clock.ts";
import type { PopupSource, PopupTheme } from "../band/popup.ts";
import type { ChainRun } from "../chain/run.ts";
import { sanitize } from "./format.ts";

export interface Kit {
	/** How to see the rest of a row: `click for all`, or Pi's expand key outside the fullscreen UI. */
	readonly moreHint: () => string;
	/** One output line per input line, or anything else to fall back to plain text. */
	readonly highlight: (code: string, lang: string) => string[];
	readonly language: (path: string) => string | undefined;
	/** Pi's colored diff for the `details.diff` its edit tool returns. */
	readonly diff: (diff: string) => string;
	/** A file URL for a terminal hyperlink, or undefined when the terminal has none. */
	readonly fileUrl: (absolutePath: string) => string | undefined;
	readonly now: () => number;
	readonly motion: () => Motion;
	/** Whether bash commands are broken into steps. */
	readonly chains: () => boolean;
	readonly clock: AnimationClock;
	/** The live or saved step record of a bash call. */
	readonly chainRun: (toolCallId: string, command: string) => ChainRun | undefined;
	/** Opens a row's popup; false when there is nowhere to show one. */
	readonly openPopup: (source: PopupSource) => boolean;
}

export type ThemeLike = PopupTheme;

export type PaintKey = "toolTitle" | "toolOutput" | "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text" | "border";

export interface Paint {
	fg(key: PaintKey, text: string): string;
	bold(text: string): string;
}

/** A theme missing a key degrades to plain text rather than breaking the row. */
export function painter(theme: ThemeLike): Paint {
	const safe = (paint: () => string, text: string) => {
		try { return paint(); } catch { return text; }
	};
	return {
		fg: (key, text) => safe(() => theme.fg(key, text), text),
		bold: (text) => safe(() => theme.bold(text), text),
	};
}

/** The subset of Pi's render context the rows use. */
export interface RenderContext {
	readonly args: unknown;
	readonly toolCallId: string;
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

export const titleSeg = (name: string): Seg => ({ text: name, color: "accent", bold: true });
export const mutedSeg = (text: string): Seg => ({ text, color: "muted" });

export const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? word : many}`;

export function more(paint: Paint, kit: Kit, text: string): string {
	return `${paint.fg("muted", `… ${text} (`)}${paint.fg("dim", kit.moreHint())}${paint.fg("muted", ")")}`;
}

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
	return { lines: shown, skipped: index + 1 };
}

/** Text blocks of a tool result, stripped of terminal sequences and control bytes. */
export function resultText(result: { content?: unknown } | undefined): string {
	const blocks = result && Array.isArray(result.content) ? result.content : [];
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

export function absolutePath(raw: string, cwd: string): string {
	const clean = sanitize(raw).replace(/\n/g, " ").replace(/^@/, "");
	const home = homedir();
	return isAbsolute(clean) ? clean : resolve(cwd, clean.replace(/^~(?=\/|$)/, home));
}

/** A path as Pi shows it: home as `~`. */
export function shownPath(raw: string): string {
	const clean = sanitize(raw).replace(/\n/g, " ").replace(/^@/, "");
	const home = homedir();
	return clean.startsWith(home) ? `~${clean.slice(home.length)}` : clean;
}

/** A path segment in the accent color, linked to the file when the terminal supports it. */
export function pathSeg(kit: Kit, raw: string | undefined, cwd: string, fallback = "…"): Seg {
	if (!raw) return { text: ` ${fallback}`, color: "toolOutput" };
	const url = kit.fileUrl(absolutePath(raw, cwd));
	return url ? { text: ` ${shownPath(raw)}`, color: "accent", link: url } : { text: ` ${shownPath(raw)}`, color: "accent" };
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

/** Lines of `text` without trailing blank lines. */
export function textLines(text: string): string[] {
	const trimmed = text.replace(/\n+$/, "");
	return trimmed === "" ? [] : trimmed.split("\n");
}
