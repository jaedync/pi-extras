/**
 * TUI rows for gov_search when Tool Display is off. The result rows are the
 * Kagi ones: `details.results` has the same shape. Nothing here reaches the
 * model; Pi sends only `content` to the provider.
 */
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { painter } from "../kagi/render.ts";
import { cleanDetail } from "./errors.ts";

/** The filters in the order the call line shows them, with the prefix each gets. */
export const FILTER_LABELS = [["jurisdiction", ""], ["courtType", ""], ["court", "court:"], ["cites", "cites:"], ["domain", "site:"]] as const;

export function filterText(args: unknown): string[] {
	const input = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
	return FILTER_LABELS.flatMap(([key, prefix]) => {
		const value = input[key];
		return typeof value === "string" && value.trim() ? [`${prefix}${cleanDetail(value, 80)}`] : [];
	});
}

export function callLine(name: string, args: unknown, theme: Theme): string {
	const paint = painter(theme);
	const input = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
	const query = typeof input.query === "string" ? cleanDetail(input.query, 160) : "";
	const parts = [paint.fg("toolTitle", paint.bold(name)), query ? paint.fg("accent", `"${query}"`) : paint.fg("dim", "…")];
	for (const filter of filterText(args)) parts.push(paint.fg("muted", filter));
	if (typeof input.k === "number" && Number.isFinite(input.k)) parts.push(paint.fg("muted", `k ${input.k}`));
	return parts.join(" ");
}

export function renderCall(name: string, args: unknown, theme: Theme): Component {
	return new Text(callLine(name, args, theme), 0, 0);
}
