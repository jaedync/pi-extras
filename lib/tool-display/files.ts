/**
 * The read, edit and write rows. The band says what the call did: lines
 * read, lines added and removed, or lines written. Collapsed, a read shows
 * no content, a diff shows its first lines, and a new file its last few
 * (where a streaming write is); the popup and Pi's expand key show everything.
 */
import { basename, dirname } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Seg } from "../band/band.ts";
import { diffStats, readSummary, sanitize, type ReadSummary } from "./format.ts";
import { absolutePath, codeLines, errorLines, hasImage, more, mutedSeg, numberArg, pathSeg, plural, resultText, shownPath, stringArg, tail, textLines, titleSeg, wrapAll, type Kit } from "./kit.ts";
import { BODY_INDENT, indent } from "./row.ts";
import { toolRenderers, type ToolSpec, type View } from "./tool.ts";

/** Diff lines shown collapsed. Most edits fit; a rewrite does not. */
export const DIFF_PREVIEW_LINES = 20;
/** File lines shown collapsed for a write: the end, which is where a streaming write is. */
export const WRITE_PREVIEW_LINES = 3;
/** Instruction files Pi also shows as a labelled, compact read. */
const RESOURCE_FILES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

const pathOf = (view: View) => stringArg(view.context.args, "path", "file_path");
const failed = (view: View) => !view.context.isPartial && view.context.isError;

function errorBody(view: View, width: number): string[] {
	return failed(view) && view.result ? wrapAll(errorLines(view.paint, resultText(view.result)), width) : [];
}

function fileDetails(view: View, extra: string[] = []): string {
	const path = pathOf(view);
	return [path ? shownPath(absolutePath(path, view.context.cwd)) : "(no path)", ...extra].join(" · ");
}

// ── read ──

function readRange(args: unknown): Seg[] {
	const offset = numberArg(args, "offset");
	const limit = numberArg(args, "limit");
	if (offset === undefined && limit === undefined) return [];
	const start = offset ?? 1;
	return [{ text: `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`, color: "warning" }];
}

/** Skills and instruction files read as a label, as Pi's own row does. */
function readLabel(path: string): Seg[] | undefined {
	const name = basename(path);
	if (name === "SKILL.md") return [titleSeg("skill"), { text: ` ${basename(dirname(path)) || name}`, color: "accent" }];
	if (RESOURCE_FILES.has(name)) return [titleSeg("read"), { text: ` ${name}`, color: "accent" }];
	return undefined;
}

function readFacts(view: View): ReadSummary | "image" | undefined {
	if (!view.result || view.context.isPartial || view.context.isError) return undefined;
	return hasImage(view.result) ? "image" : readSummary(resultText(view.result));
}

export function readText(summary: ReadSummary | "image" | undefined): Seg[] {
	if (summary === undefined) return [];
	if (summary === "image") return [mutedSeg(" · image")];
	if (summary.longLine) return [{ text: " · line over the size limit", color: "warning" }];
	const count = summary.total !== undefined ? `${summary.lines.toLocaleString("en-US")} of ${plural(summary.total, "line")}` : plural(summary.lines, "line");
	return [mutedSeg(` · ${count}`)];
}

function readContent(view: View): string[] {
	const text = view.result ? resultText(view.result) : "";
	const path = pathOf(view);
	return codeLines(view.paint, view.kit, textLines(text), path ? view.kit.language(path) : undefined);
}

export const readSpec: ToolSpec = {
	label: () => "read",
	title(view) {
		const path = pathOf(view);
		const label = !view.context.expanded && path ? readLabel(sanitize(path)) : undefined;
		return [...(label ?? [titleSeg("read"), pathSeg(view.kit, path, view.context.cwd)]), ...readRange(view.context.args), ...readText(readFacts(view))];
	},
	body(view, width) {
		if (failed(view)) return errorBody(view, width);
		if (!view.context.expanded || readFacts(view) === "image") return [];
		return wrapAll(readContent(view), width);
	},
	details: (view) => fileDetails(view),
	output: (view, width) => (failed(view) ? errorBody(view, width) : wrapAll(readContent(view), width)),
};

// ── edit ──

function editCount(args: unknown): number {
	const edits = args && typeof args === "object" ? (args as { edits?: unknown }).edits : undefined;
	return Array.isArray(edits) ? edits.length : 0;
}

function diffOf(view: View): string | undefined {
	if (!view.result || failed(view)) return undefined;
	const details = view.result.details;
	const diff = details && typeof details === "object" ? (details as { diff?: unknown }).diff : undefined;
	return typeof diff === "string" ? diff : undefined;
}

const diffLines = (kit: Kit, diff: string) => kit.diff(sanitize(diff)).split("\n");

export const editSpec: ToolSpec = {
	label: () => "edit",
	title(view) {
		const head = [titleSeg("edit"), pathSeg(view.kit, pathOf(view), view.context.cwd)];
		const diff = diffOf(view);
		if (diff) {
			const stats = diffStats(diff);
			// The two counts read as one figure, `+12 −3`, not two parts.
			return [...head, mutedSeg(" · "), { text: `+${stats.added}`, color: "success" }, { text: ` −${stats.removed}`, color: "error" }];
		}
		const count = editCount(view.context.args);
		return view.context.isPartial && count > 1 ? [...head, mutedSeg(` · ${plural(count, "edit")}`)] : head;
	},
	body(view, width) {
		if (failed(view)) return errorBody(view, width);
		const diff = diffOf(view);
		if (!diff) return [];
		const lines = diffLines(view.kit, diff);
		if (view.context.expanded || lines.length <= DIFF_PREVIEW_LINES) return wrapAll(lines, width);
		const hidden = lines.length - DIFF_PREVIEW_LINES;
		return [...wrapAll(lines.slice(0, DIFF_PREVIEW_LINES), width), truncateToWidth(more(view.paint, view.kit, plural(hidden, "more diff line")), width, "…")];
	},
	details: (view) => fileDetails(view, editCount(view.context.args) > 1 ? [plural(editCount(view.context.args), "edit")] : []),
	outputLabel: () => "diff",
	output(view, width) {
		if (failed(view)) return errorBody(view, width);
		const diff = diffOf(view);
		return diff ? wrapAll(diffLines(view.kit, diff), width) : [view.paint.fg("dim", view.context.isPartial ? "(editing…)" : "(no diff)")];
	},
};

// ── write ──

interface WriteCache { readonly key: string; readonly lines: string[] }

function contentOf(view: View): { raw: unknown; lines: string[] } {
	const raw = view.context.args && typeof view.context.args === "object" ? (view.context.args as { content?: unknown }).content : undefined;
	const text = typeof raw === "string" ? sanitize(raw).replace(/\n+$/, "") : "";
	return { raw, lines: text ? text.split("\n") : [] };
}

/** A row replayed from history never streams, so Pi does not mark its arguments complete. */
const argsDone = (view: View) => view.context.argsComplete || view.context.executionStarted || !view.context.isPartial;

/** The file's lines, highlighted once complete; while it streams, plain text rather than re-highlighting every chunk. */
function writeLines(view: View): string[] {
	const { lines } = contentOf(view);
	if (!argsDone(view)) return lines.map((line) => view.paint.fg("toolOutput", line));
	const path = pathOf(view);
	const key = `${path}\u0000${lines.length}\u0000${lines.at(-1) ?? ""}`;
	const cached = view.row.write as WriteCache | undefined;
	if (cached?.key === key) return cached.lines;
	const code = codeLines(view.paint, view.kit, lines, path ? view.kit.language(path) : undefined);
	view.row.write = { key, lines: code } satisfies WriteCache;
	return code;
}

export const writeSpec: ToolSpec = {
	label: () => "write",
	title(view) {
		const { raw, lines } = contentOf(view);
		const head = [titleSeg("write"), pathSeg(view.kit, pathOf(view), view.context.cwd)];
		if (raw === undefined) return head;
		if (typeof raw !== "string") return [...head, { text: " · [invalid content]", color: "error" }];
		return [...head, mutedSeg(` · ${plural(lines.length, "line")}${argsDone(view) ? "" : "…"}`)];
	},
	below(view, width) {
		const { lines } = contentOf(view);
		if (lines.length === 0) return [];
		const inner = Math.max(1, width - BODY_INDENT);
		const code = writeLines(view);
		if (view.context.expanded) return indent(wrapAll(code, inner));
		const shown = tail(code, WRITE_PREVIEW_LINES, inner);
		const hint = shown.skipped > 0 ? [truncateToWidth(more(view.paint, view.kit, plural(shown.skipped, "earlier line")), inner, "…")] : [];
		return indent([...hint, ...shown.lines]);
	},
	body: (view, width) => errorBody(view, width),
	details: (view) => fileDetails(view),
	outputLabel: () => "content",
	output(view, width) {
		const error = errorBody(view, width);
		const code = writeLines(view);
		return [...error, ...(code.length > 0 ? wrapAll(code, width) : [view.paint.fg("dim", "(empty file)")])];
	},
};

export const readRenderers = (kit: Kit) => toolRenderers(kit, readSpec);
export const editRenderers = (kit: Kit) => toolRenderers(kit, editSpec);
export const writeRenderers = (kit: Kit) => toolRenderers(kit, writeSpec);
