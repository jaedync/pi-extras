/** Shared Markdown previews and per-message expansion for incoming agent mail. */
import { Markdown, truncateToWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { BandTheme } from "./palette.ts";
import { bodyBackground, onBackground } from "./surface.ts";

export type MarkdownSource = () => MarkdownTheme | undefined;
export const markdownOf = (source: MarkdownSource | undefined): MarkdownTheme | undefined => {
	try { return source?.(); } catch { return undefined; }
};

/** `null` shows the whole body; a preview keeps enough room for its expansion hint. */
export function messageBody(theme: BandTheme, width: number, text: string, color: string, limit: number | null, markdown?: MarkdownTheme, background = bodyBackground(theme)): string[] {
	const trimmed = text.replace(/\r/g, "").trim();
	if (!trimmed) return [];
	const paint = (key: string, value: string) => {
		try { return theme.fg(key, value); } catch { return value; }
	};
	const pad = " ".repeat(Math.min(3, Math.max(0, width - 1)));
	const inner = Math.max(1, width - pad.length);
	const all = markdown
		? new Markdown(trimmed, 0, 0, markdown, { color: (line: string) => paint(color, line) }).render(inner).map((line) => line.trimEnd())
		: wrapTextWithAnsi(trimmed, inner).map((line) => paint(color, line));
	const shown = limit === null ? all : all.slice(0, limit);
	const lines = shown.map((line) => pad + truncateToWidth(line, inner, "…"));
	const hidden = all.length - shown.length;
	const count = `${hidden}${shown.length > 0 ? " more" : ""} line${hidden === 1 ? "" : "s"}`;
	if (hidden > 0) lines.push(pad + truncateToWidth(paint("dim", `… ${count} (click to show)`), inner, "…"));
	return onBackground(lines, width, background);
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
