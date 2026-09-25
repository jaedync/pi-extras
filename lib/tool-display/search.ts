/**
 * The grep, find and ls rows. The band says what was found (`23 matches in
 * 7 files`) instead of listing the first lines; the popup and Pi's expand key
 * show the full listing.
 */
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Seg } from "../band/band.ts";
import { grepSummary, listSummary, sanitize, type GrepSummary, type ListSummary } from "./format.ts";
import { absolutePath, errorLines, mutedSeg, numberArg, pathSeg, plural, resultText, shownPath, stringArg, titleSeg, wrapAll, type Kit } from "./kit.ts";
import { toolRenderers, type ToolSpec, type View } from "./tool.ts";

type Tool = "grep" | "find" | "ls";
type Summary = GrepSummary | ListSummary;

const flat = (text: string) => sanitize(text).replace(/\n/g, " ");
const failed = (view: View) => !view.context.isPartial && view.context.isError;

function describe(view: View, tool: Tool): Seg[] {
	const args = view.context.args;
	const path = stringArg(args, "path");
	const limit = numberArg(args, "limit");
	const limitSeg: Seg[] = limit !== undefined ? [{ text: ` limit ${limit}`, color: "toolOutput" }] : [];
	if (tool === "ls") return [titleSeg("ls"), pathSeg(view.kit, path, view.context.cwd, "."), ...limitSeg];
	const pattern = stringArg(args, "pattern") ?? "";
	const where: Seg = { text: ` in ${flat(path || ".")}`, color: "toolOutput" };
	if (tool === "find") return [titleSeg("find"), { text: ` ${flat(pattern)}`, color: "accent" }, where, ...limitSeg];
	const glob = stringArg(args, "glob");
	return [titleSeg("grep"), { text: ` /${flat(pattern)}/`, color: "accent" }, where, ...(glob ? [{ text: ` (${flat(glob)})`, color: "toolOutput" }] : []), ...limitSeg];
}

export function summaryText(tool: Tool, summary: Summary): Seg[] {
	let text: string;
	if ("matches" in summary) text = summary.matches === 0 ? "no matches" : `${plural(summary.matches, "match", "matches")} in ${plural(summary.files, "file")}`;
	else if (summary.entries === 0) text = tool === "ls" ? "empty" : "no files";
	else if (tool === "ls") text = plural(summary.entries, "entry", "entries") + (summary.dirs > 0 ? ` (${plural(summary.dirs, "dir")})` : "");
	else text = plural(summary.entries, "file");
	return summary.notice ? [mutedSeg(` · ${text}`), { text: " · limit reached", color: "warning" }] : [mutedSeg(` · ${text}`)];
}

function summaryOf(view: View, tool: Tool): Summary | undefined {
	if (!view.result || view.context.isPartial || view.context.isError) return undefined;
	const text = resultText(view.result);
	return tool === "grep" ? grepSummary(text) : listSummary(text);
}

function listing(view: View, summary: Summary, width: number): string[] {
	const text = resultText(view.result);
	const notice = summary.notice ? wrapTextWithAnsi(view.paint.fg("warning", summary.notice), width) : [];
	const empty = "matches" in summary ? summary.matches === 0 : summary.entries === 0;
	if (empty) return notice;
	const body = text.trim().replace(/\n\n\[[^\n]*\]$/, "").split("\n").map((line) => view.paint.fg("toolOutput", line));
	return [...wrapAll(body, width), ...notice];
}

export function searchSpec(tool: Tool): ToolSpec {
	return {
		label: () => tool,
		title(view) {
			const summary = summaryOf(view, tool);
			return [...describe(view, tool), ...(summary ? summaryText(tool, summary) : [])];
		},
		body(view, width) {
			if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
			const summary = summaryOf(view, tool);
			return summary && view.context.expanded ? listing(view, summary, width) : [];
		},
		details(view) {
			const path = stringArg(view.context.args, "path");
			return `in ${shownPath(absolutePath(path || ".", view.context.cwd))}`;
		},
		output(view, width) {
			if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
			const summary = summaryOf(view, tool);
			if (!summary) return [view.paint.fg("dim", "(searching…)")];
			const lines = listing(view, summary, width);
			return lines.length > 0 ? lines : [view.paint.fg("dim", "(nothing found)")];
		},
	};
}

export const searchRenderers = (kit: Kit, tool: Tool) => toolRenderers(kit, searchSpec(tool));
