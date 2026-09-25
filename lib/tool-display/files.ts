/**
 * The read, edit and write rows. Each header ends with what the call did:
 * lines read, lines added and removed, or lines written. Collapsed, a read
 * shows no content, and a diff or new file shows its first lines.
 */
import { basename, dirname } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { diffStats, readSummary, sanitize, type ReadSummary } from "./format.ts";
import { Lines, type Paint, type PaintKey } from "./slot.ts";
import { codeLines, errorLines, hasImage, header, meta, more, numberArg, pathText, plural, resultText, slotFor, stringArg, title, wrapAll, type Kit, type RenderContext, type ThemeLike } from "./kit.ts";

/** Diff lines shown collapsed. Most edits fit; a rewrite does not. */
export const DIFF_PREVIEW_LINES = 20;
/** File lines shown collapsed for a write; the same as Pi's write row. */
export const WRITE_PREVIEW_LINES = 10;
/** Instruction files Pi also shows as a labelled, compact read. */
const RESOURCE_FILES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

type ResultInput = { content?: unknown; details?: unknown };
type ResultOptions = { expanded: boolean; isPartial: boolean };

function lineRange(paint: Paint, args: unknown): string {
	const offset = numberArg(args, "offset");
	const limit = numberArg(args, "limit");
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return paint.fg("warning", `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`);
}

/** Skills and instruction files read as a label, as Pi's own row does. */
function readLabel(paint: Paint, path: string): string | undefined {
	const name = basename(path);
	if (name === "SKILL.md") return `${title(paint, "skill")} ${paint.fg("accent", basename(dirname(path)) || name)}`;
	if (RESOURCE_FILES.has(name)) return `${title(paint, "read")} ${paint.fg("accent", name)}`;
	return undefined;
}

export function readMeta(paint: Paint, summary: ReadSummary | "image" | undefined): string {
	if (summary === undefined) return "";
	if (summary === "image") return meta(paint, [["muted", "image"]]);
	if (summary.longLine) return meta(paint, [["warning", "line over the size limit"]]);
	const count = summary.total !== undefined ? `${summary.lines.toLocaleString("en-US")} of ${plural(summary.total, "line")}` : plural(summary.lines, "line");
	return meta(paint, [["muted", count]]);
}

export function readRenderers(kit: Kit) {
	return {
		renderCall(_args: unknown, theme: ThemeLike, context: RenderContext) {
			const { slot, state } = slotFor("call", kit, theme, context);
			return slot.setBody(new Lines((width) => {
				const paint = state.paint as Paint;
				const path = stringArg(context.args, "path", "file_path");
				const label = !context.expanded && path ? readLabel(paint, sanitize(path)) : undefined;
				const main = label ?? `${title(paint, "read")} ${pathText(paint, kit, path, context.cwd)}`;
				return header(main + lineRange(paint, context.args), readMeta(paint, state.read as ReadSummary | "image" | undefined), width, context.expanded);
			}));
		},
		renderResult(result: ResultInput, options: ResultOptions, theme: ThemeLike, context: RenderContext) {
			const { slot, paint, state } = slotFor("result", kit, theme, context);
			const text = resultText(result);
			if (context.isError) {
				state.read = undefined;
				return slot.setBody(new Lines((width) => wrapAll(errorLines(paint, text), width)));
			}
			state.read = hasImage(result) ? "image" : readSummary(text);
			if (!options.expanded || state.read === "image") return slot.setBody(new Lines(() => []));
			const path = stringArg(context.args, "path", "file_path");
			const lang = path ? kit.language(path) : undefined;
			const lines = codeLines(paint, kit, text.replace(/\n+$/, "").split("\n"), lang);
			return slot.setBody(new Lines((width) => wrapAll(lines, width)));
		},
	};
}

function editCount(args: unknown): number {
	const edits = args && typeof args === "object" ? (args as { edits?: unknown }).edits : undefined;
	return Array.isArray(edits) ? edits.length : 0;
}

export function editRenderers(kit: Kit) {
	return {
		renderCall(_args: unknown, theme: ThemeLike, context: RenderContext) {
			const { slot, state, row } = slotFor("call", kit, theme, context);
			return slot.setBody(new Lines((width) => {
				const paint = state.paint as Paint;
				const path = stringArg(context.args, "path", "file_path");
				const stats = state.diffStats as { added: number; removed: number } | undefined;
				const count = editCount(context.args);
				const parts: Array<readonly [PaintKey, string]> = stats
					? [["success", `+${stats.added}`], ["error", `−${stats.removed}`]]
					: row.status === "pending" && count > 1 ? [["muted", plural(count, "edit")]] : [];
				// The two counts read as one figure, `+12 −3`, not two parts.
				const tail = parts.length === 2 ? `${paint.fg("muted", " · ")}${paint.fg(parts[0]![0], parts[0]![1])} ${paint.fg(parts[1]![0], parts[1]![1])}` : meta(paint, parts);
				return header(`${title(paint, "edit")} ${pathText(paint, kit, path, context.cwd)}`, tail, width, context.expanded);
			}));
		},
		renderResult(result: ResultInput, options: ResultOptions, theme: ThemeLike, context: RenderContext) {
			const { slot, paint, state } = slotFor("result", kit, theme, context);
			const diff = !context.isError && result.details && typeof result.details === "object" ? (result.details as { diff?: unknown }).diff : undefined;
			if (typeof diff !== "string") {
				state.diffStats = undefined;
				return slot.setBody(new Lines((width) => (context.isError ? wrapAll(errorLines(paint, resultText(result)), width) : [])));
			}
			state.diffStats = diffStats(diff);
			const lines = kit.diff(sanitize(diff)).split("\n");
			return slot.setBody(new Lines((width) => {
				if (options.expanded || lines.length <= DIFF_PREVIEW_LINES) return wrapAll(lines, width);
				const hidden = lines.length - DIFF_PREVIEW_LINES;
				return [...wrapAll(lines.slice(0, DIFF_PREVIEW_LINES), width), truncateToWidth(more(paint, kit, plural(hidden, "more diff line")), width, "…")];
			}));
		},
	};
}

interface WriteCache { readonly key: string; readonly lines: string[] }

export function writeRenderers(kit: Kit) {
	return {
		renderCall(_args: unknown, theme: ThemeLike, context: RenderContext) {
			const { slot, state } = slotFor("call", kit, theme, context);
			const path = stringArg(context.args, "path", "file_path");
			const raw = context.args && typeof context.args === "object" ? (context.args as { content?: unknown }).content : undefined;
			const content = typeof raw === "string" ? sanitize(raw).replace(/\n+$/, "") : undefined;
			const lines = content ? content.split("\n") : [];
			// A row replayed from history never streams, so Pi does not mark its arguments complete.
			const complete = context.argsComplete || context.executionStarted || !context.isPartial;
			let code: string[] = [];
			if (content && complete) {
				// Highlight once the content is complete; streaming shows plain text rather than re-highlighting every chunk.
				const key = `${path}\u0000${content.length}\u0000${content.slice(-64)}`;
				const cached = state.write as WriteCache | undefined;
				code = cached?.key === key ? cached.lines : codeLines(state.paint as Paint, kit, lines, path ? kit.language(path) : undefined);
				state.write = { key, lines: code } satisfies WriteCache;
			} else {
				code = lines.slice(0, context.expanded ? lines.length : WRITE_PREVIEW_LINES).map((line) => (state.paint as Paint).fg("toolOutput", line));
			}
			return slot.setBody(new Lines((width) => {
				const paint = state.paint as Paint;
				const count = raw === undefined ? "" : plural(lines.length, "line") + (complete ? "" : "…");
				const out = header(`${title(paint, "write")} ${pathText(paint, kit, path, context.cwd)}`, meta(paint, [["muted", count]]), width, context.expanded);
				if (raw !== undefined && typeof raw !== "string") return [...out, paint.fg("error", "[invalid content]")];
				if (lines.length === 0) return out;
				const shown = context.expanded ? code : code.slice(0, WRITE_PREVIEW_LINES);
				const body = [...wrapAll(shown, width)];
				if (lines.length > shown.length) body.push(truncateToWidth(more(paint, kit, plural(lines.length - shown.length, "more line")), width, "…"));
				// A blank line sets the file off from the header in the boxed layout, as Pi does.
				return kit.density() === "boxed" ? [...out, "", ...body] : [...out, ...body];
			}, kit.density));
		},
		renderResult(result: ResultInput, _options: ResultOptions, theme: ThemeLike, context: RenderContext) {
			const { slot, paint } = slotFor("result", kit, theme, context);
			const text = context.isError ? resultText(result) : "";
			return slot.setBody(new Lines((width) => wrapAll(errorLines(paint, text), width)));
		},
	};
}
