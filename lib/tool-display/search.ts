/**
 * The grep, find and ls rows. Collapsed, the header says what was found
 * (`23 matches in 7 files`) instead of listing the first lines; expanded, the
 * full listing follows.
 */
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { grepSummary, listSummary, sanitize, type GrepSummary, type ListSummary } from "./format.ts";
import { Lines, type Paint, type PaintKey } from "./slot.ts";
import { errorLines, header, meta, numberArg, pathText, plural, resultText, slotFor, stringArg, title, wrapAll, type Kit, type RenderContext, type ThemeLike } from "./kit.ts";

type Tool = "grep" | "find" | "ls";
type Summary = GrepSummary | ListSummary;
type ResultInput = { content?: unknown; details?: unknown };

const flat = (text: string) => sanitize(text).replace(/\n/g, " ");

function describe(paint: Paint, kit: Kit, tool: Tool, args: unknown, cwd: string): string {
	const path = stringArg(args, "path");
	const limit = numberArg(args, "limit");
	const limitText = limit !== undefined ? paint.fg("toolOutput", ` limit ${limit}`) : "";
	if (tool === "ls") return `${title(paint, "ls")} ${pathText(paint, kit, path, cwd, ".")}${limitText}`;
	const pattern = stringArg(args, "pattern");
	const where = paint.fg("toolOutput", ` in ${flat(path || ".")}`);
	if (tool === "find") return `${title(paint, "find")} ${paint.fg("accent", flat(pattern ?? ""))}${where}${limitText}`;
	const glob = stringArg(args, "glob");
	return `${title(paint, "grep")} ${paint.fg("accent", `/${flat(pattern ?? "")}/`)}${where}${glob ? paint.fg("toolOutput", ` (${flat(glob)})`) : ""}${limitText}`;
}

export function summaryParts(tool: Tool, summary: Summary): Array<readonly [PaintKey, string]> {
	const parts: Array<readonly [PaintKey, string]> = [];
	if ("matches" in summary) {
		parts.push(["muted", summary.matches === 0 ? "no matches" : `${plural(summary.matches, "match", "matches")} in ${plural(summary.files, "file")}`]);
	} else if (summary.entries === 0) {
		parts.push(["muted", tool === "ls" ? "empty" : "no files"]);
	} else if (tool === "ls") {
		parts.push(["muted", plural(summary.entries, "entry", "entries") + (summary.dirs > 0 ? ` (${plural(summary.dirs, "dir")})` : "")]);
	} else {
		parts.push(["muted", plural(summary.entries, "file")]);
	}
	if (summary.notice) parts.push(["warning", "limit reached"]);
	return parts;
}

export function searchRenderers(kit: Kit, tool: Tool) {
	return {
		renderCall(_args: unknown, theme: ThemeLike, context: RenderContext) {
			const { slot, state } = slotFor("call", kit, theme, context);
			return slot.setBody(new Lines((width) => {
				const paint = state.paint as Paint;
				const summary = state.summary as Summary | undefined;
				return header(describe(paint, kit, tool, context.args, context.cwd), summary ? meta(paint, summaryParts(tool, summary)) : "", width, context.expanded);
			}));
		},
		renderResult(result: ResultInput, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: RenderContext) {
			const { slot, paint, state } = slotFor("result", kit, theme, context);
			const text = resultText(result);
			if (context.isError) {
				state.summary = undefined;
				return slot.setBody(new Lines((width) => wrapAll(errorLines(paint, text), width)));
			}
			const summary = tool === "grep" ? grepSummary(text) : listSummary(text);
			state.summary = summary;
			const empty = "matches" in summary ? summary.matches === 0 : summary.entries === 0;
			return slot.setBody(new Lines((width) => {
				const notice = summary.notice ? wrapTextWithAnsi(paint.fg("warning", summary.notice), width) : [];
				if (!options.expanded || empty) return options.expanded ? notice : [];
				const body = text.trim().replace(/\n\n\[[^\n]*\]$/, "").split("\n").map((line) => paint.fg("toolOutput", line));
				return [...wrapAll(body, width), ...notice];
			}));
		},
	};
}
