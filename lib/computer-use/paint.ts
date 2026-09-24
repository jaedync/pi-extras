/** Theme access for the computer use rows and dialogs; a theme missing a key degrades to plain text. */
import type { Theme } from "@earendil-works/pi-coding-agent";

export type PaintKey = "toolTitle" | "toolOutput" | "text" | "muted" | "dim" | "accent" | "success" | "error" | "warning" | "border";

export interface Paint { fg(key: PaintKey, text: string): string; bold(text: string): string }

export function painter(theme: Theme): Paint {
	const safe = (paint: () => string, text: string) => { try { return paint(); } catch { return text; } };
	return { fg: (key, text) => safe(() => theme.fg(key, text), text), bold: (text) => safe(() => theme.bold(text), text) };
}

export function rule(paint: Paint, width: number): string {
	return paint.fg("border", "─".repeat(Math.max(0, width)));
}

export function hints(paint: Paint, pairs: ReadonlyArray<readonly [string, string]>): string {
	return pairs.map(([key, label]) => `${paint.fg("dim", key)} ${paint.fg("muted", label)}`).join("   ");
}
