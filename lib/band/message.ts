/** Shared Markdown previews and per-message expansion for incoming agent mail. */
import { Markdown, truncateToWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { ROW_MARGIN } from "./band.ts";
import type { BandTheme } from "./palette.ts";
import { bodyBackground, onBackground } from "./surface.ts";

export type MarkdownSource = () => MarkdownTheme | undefined;
export const markdownOf = (source: MarkdownSource | undefined): MarkdownTheme | undefined => {
	try { return source?.(); } catch { return undefined; }
};

/*
 * Mail comes from other sessions and subagents, so its Markdown is untrusted.
 * pi-tui's parser recurses per nesting level: 3,000 nested quotes overflow the
 * stack and 2,000 nested list items exhaust the heap, which no catch can stop.
 * Bodies past these limits are shown as plain text instead. Real mail is far
 * below them; they are set where parsing still takes a few milliseconds.
 */
const MARKDOWN_MAX_CHARS = 32_000;
const MARKDOWN_MAX_LINES = 800;
/** Blockquote markers or list indent levels (two columns each) at the start of a line. */
const MARKDOWN_MAX_DEPTH = 16;
/** The plain fallback keeps this much of a body; an expanded view shows at most MAX_EXPANDED_LINES. */
const PLAIN_MAX_CHARS = 64_000;
export const MAX_EXPANDED_LINES = 1_000;
/** Text sits under the band's title, which starts after the row's margin. */
const BODY_INDENT = 2 + ROW_MARGIN;
/** Laid-out bodies kept across redraws, newest last. */
const LAYOUT_CACHE_SIZE = 32;

/** Whether `text` is small and shallow enough to hand to the Markdown parser. */
export function markdownIsSafe(text: string): boolean {
	if (text.length > MARKDOWN_MAX_CHARS) return false;
	let lines = 0;
	for (const line of text.split("\n")) {
		if (++lines > MARKDOWN_MAX_LINES) return false;
		const prefix = /^[\s>]*/.exec(line)![0];
		const quotes = prefix.split(">").length - 1;
		const indent = prefix.replace(/>/g, "").replace(/\t/g, "  ").length;
		if (quotes > MARKDOWN_MAX_DEPTH || indent > MARKDOWN_MAX_DEPTH * 2) return false;
	}
	return true;
}

interface Layout {
	readonly theme: BandTheme;
	readonly markdown: boolean;
	readonly lines: readonly string[];
	/** Finished rows by width, preview limit and background: padding and backgrounds cost as much as parsing on long bodies. */
	readonly framed: Map<string, readonly string[]>;
}
const layouts = new Map<string, Layout>();

/** Pi redraws every frame; parsing and highlighting a long body each time stalls typing. */
function layout(theme: BandTheme, text: string, inner: number, color: string, markdown: MarkdownTheme | undefined, paint: (key: string, value: string) => string): Layout {
	const key = `${inner}\u0000${color}\u0000${text}`;
	const cached = layouts.get(key);
	// Pi builds a new Markdown theme object per call, always from the active Theme, so
	// the Theme's identity (it changes on a theme switch) is what invalidates a layout.
	if (cached && cached.theme === theme && cached.markdown === !!markdown) {
		layouts.delete(key);
		layouts.set(key, cached);
		return cached;
	}
	const entry: Layout = { theme, markdown: !!markdown, lines: render(text, inner, color, markdown, paint), framed: new Map() };
	layouts.set(key, entry);
	if (layouts.size > LAYOUT_CACHE_SIZE) layouts.delete(layouts.keys().next().value!);
	return entry;
}

function render(text: string, inner: number, color: string, markdown: MarkdownTheme | undefined, paint: (key: string, value: string) => string): string[] {
	const plain = (note: boolean) => [
		...(note ? [paint("dim", "shown as plain text (too large or deeply nested for Markdown)")] : []),
		...wrapTextWithAnsi(text.slice(0, PLAIN_MAX_CHARS), inner).map((line) => paint(color, line)),
		...(text.length > PLAIN_MAX_CHARS ? [paint("dim", `… ${text.length - PLAIN_MAX_CHARS} more characters not shown`)] : []),
	];
	if (!markdown) return plain(false);
	if (!markdownIsSafe(text)) return plain(true);
	try {
		return new Markdown(text, 0, 0, markdown, { color: (line: string) => paint(color, line) }).render(inner).map((line) => line.trimEnd());
	} catch {
		return plain(false);
	}
}

/** `null` shows the whole body, up to MAX_EXPANDED_LINES; a preview keeps enough room for its expansion hint. */
export function messageBody(theme: BandTheme, width: number, text: string, color: string, limit: number | null, markdown?: MarkdownTheme, background = bodyBackground(theme)): string[] {
	const trimmed = text.replace(/\r/g, "").trim();
	if (!trimmed) return [];
	const paint = (key: string, value: string) => {
		try { return theme.fg(key, value); } catch { return value; }
	};
	const pad = " ".repeat(Math.min(BODY_INDENT, Math.max(0, width - 1)));
	const inner = Math.max(1, width - pad.length);
	const entry = layout(theme, trimmed, inner, color, markdown, paint);
	const frameKey = `${width}\u0000${limit}\u0000${background}`;
	const framed = entry.framed.get(frameKey);
	if (framed) return [...framed];
	const all = entry.lines;
	const shown = all.slice(0, limit ?? MAX_EXPANDED_LINES);
	const lines = shown.map((line) => pad + truncateToWidth(line, inner, "…"));
	const hidden = all.length - shown.length;
	const count = `${hidden}${shown.length > 0 ? " more" : ""} line${hidden === 1 ? "" : "s"}`;
	// Past the expanded cap a click would only collapse the body, so don't offer one.
	const hint = limit === null ? `… ${count} not shown` : `… ${count} (click to show)`;
	if (hidden > 0) lines.push(pad + truncateToWidth(paint("dim", hint), inner, "…"));
	const result = onBackground(lines, width, background);
	entry.framed.set(frameKey, result);
	return [...result];
}

export const expansionMemory = () => ({ overrides: new WeakMap<object, boolean>(), seen: new WeakMap<object, boolean>() });

/** Click overrides belong to the original message; ctrl+o resets them when its global flag changes. */
export function expandable(render: (width: number, expanded: boolean) => string[], globalExpanded: boolean, key: object, memory: ReturnType<typeof expansionMemory>): Component {
	if (memory.seen.get(key) !== globalExpanded) {
		memory.overrides.delete(key);
		memory.seen.set(key, globalExpanded);
	}
	const expanded = () => memory.overrides.get(key) ?? globalExpanded;
	return {
		render: (width: number) => render(Math.max(1, width), expanded()),
		invalidate: () => {},
		handleMouse: (event: { type: string; button: string }) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			memory.overrides.set(key, !expanded());
			return { handled: true };
		},
	} as Component;
}
