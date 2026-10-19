/**
 * The Pull Link row (pull_link). The band names the link in short, the
 * options it was called with and, once read, the platform and what else
 * came with it (images, the page of a long result, the cache). Under it sit
 * the title and the adapter's summary lines; expanded, the full link too.
 * While the call runs, the rail names its step (`reading captions`). The
 * popup holds the whole result.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SEP } from "../cc-phase.ts";
import type { Seg } from "../band/band.ts";
import { formatDuration, link } from "../kagi/render.ts";
import { platformName, reason, shortUrl } from "../link-context/names.ts";
import { PAGE_CHARS } from "../link-context/format.ts";
import { proseLines, SUMMARY_LINES } from "../link-context/summary.ts";
import { sanitize } from "./format.ts";
import { errorLines, mutedSeg, numberArg, plural, resultText, stringArg, textLines, titleSeg, wrapAll } from "./kit.ts";
import type { ToolSpec, View } from "./tool.ts";

interface LinkDetails {
	readonly progress?: string;
	readonly platform?: string;
	readonly title?: string;
	readonly url?: string;
	readonly chars?: number;
	readonly images?: number;
	readonly next?: number;
	readonly cached?: boolean;
	readonly durationMs?: number;
	readonly preview?: readonly string[];
}

const flat = (text: string) => sanitize(text).replace(/\s+/g, " ").trim();
const failed = (view: View) => !view.context.isPartial && view.context.isError;
const done = (view: View) => !!view.result && !view.context.isPartial && !failed(view);
const urlOf = (view: View) => stringArg(view.context.args, "url");

function detailsOf(view: View): LinkDetails {
	const details = view.result?.details;
	return details && typeof details === "object" ? (details as LinkDetails) : {};
}

/** The result as the model got it, without the untrusted-content wrapper. */
const resultBody = (view: View) => resultText(view.result).replace(/^<untrusted-content[^>]*>\n?|\n?<\/untrusted-content>$/g, "");

/** The options a call was made with, as `, 5 comments`. */
function optionSegs(args: unknown): Seg[] {
	const parts: string[] = [];
	const comments = numberArg(args, "comments");
	const frames = numberArg(args, "frames");
	const offset = numberArg(args, "offset");
	const range = stringArg(args, "range");
	const at = (args as { at?: unknown } | undefined)?.at;
	if (comments !== undefined) parts.push(plural(comments, "comment"));
	if (frames) parts.push(plural(frames, "frame"));
	if (Array.isArray(at) && at.length) parts.push(`at ${flat(at.map(String).join(" "))}`);
	if (range) parts.push(flat(range));
	if ((args as { transcript?: unknown } | undefined)?.transcript === false) parts.push("no transcript");
	if (offset) parts.push(`from ${offset.toLocaleString("en-US")}`);
	return parts.map((part) => mutedSeg(`${SEP}${part}`));
}

/** What the read found: the platform, images, the page of a long result, the cache. */
function factSegs(view: View): Seg[] {
	if (!done(view)) return [];
	const d = detailsOf(view);
	const facts = [platformName(d.platform, d.url ?? urlOf(view) ?? "")];
	if (d.images) facts.push(plural(d.images, "image"));
	if (d.next !== undefined && d.chars) {
		const offset = numberArg(view.context.args, "offset") ?? 0;
		facts.push(`page ${Math.floor(offset / PAGE_CHARS) + 1} of ${Math.ceil(d.chars / PAGE_CHARS)}`);
	}
	if (d.cached) facts.push("cached");
	return facts.map((fact) => mutedSeg(`${SEP}${flat(fact)}`));
}

/** The adapter's summary; a row saved before summaries shows the first prose lines of its result. */
function summary(view: View, title: string): string[] {
	const preview = detailsOf(view).preview;
	if (Array.isArray(preview)) return preview.filter((line): line is string => typeof line === "string").slice(0, SUMMARY_LINES).map(flat);
	return proseLines(resultBody(view), title, SUMMARY_LINES);
}

export const linkSpec: ToolSpec = {
	name: "pull_link",
	label: () => "pull_link",
	title(view) {
		const url = urlOf(view);
		const target: Seg = url ? { text: ` ${flat(shortUrl(url))}`, color: "accent", link: url } : { text: " …", color: "toolOutput" };
		return [titleSeg("pull_link"), target, ...optionSegs(view.context.args), ...factSegs(view)];
	},
	lead(view, phase) {
		const progress = detailsOf(view).progress;
		return phase.kind === "running" && typeof progress === "string" && progress ? [{ text: flat(progress).toLowerCase(), color: "muted" }] : [];
	},
	body(view, width) {
		if (failed(view)) return wrapAll(errorLines(view.paint, reason(resultText(view.result), urlOf(view) ?? "")), width);
		if (!done(view)) return [];
		const title = flat(detailsOf(view).title ?? "");
		const url = urlOf(view);
		const lines = [
			...(title ? [view.paint.fg("toolOutput", title)] : []),
			...summary(view, title).map((line) => view.paint.fg("muted", line)),
			...(view.context.expanded && url ? [link(view.paint.fg("dim", flat(url)), url)] : []),
		];
		return lines.map((line) => truncateToWidth(line, width, "…"));
	},
	details(view) {
		const d = detailsOf(view);
		const parts = [platformName(d.platform, d.url ?? urlOf(view) ?? "")];
		if (typeof d.chars === "number") parts.push(`${d.chars.toLocaleString("en-US")} chars`);
		if (typeof d.durationMs === "number") parts.push(`took ${formatDuration(d.durationMs)}`);
		return parts.join(SEP);
	},
	head(view, width) {
		const url = urlOf(view);
		return url ? wrapAll([link(view.paint.fg("accent", flat(url)), url)], width) : [];
	},
	outputLabel: () => "result",
	output(view, width) {
		if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
		if (!view.result || view.context.isPartial) return [view.paint.fg("dim", "(reading…)")];
		return wrapAll(textLines(resultBody(view)).map((line) => view.paint.fg("toolOutput", line)), width);
	},
};
