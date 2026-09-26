/**
 * The Kagi search row (web_search or kagi_search). The band says what was
 * searched and how many results came back; under it sit the first results,
 * and the popup lists every result with its address and excerpt.
 */
import type { Seg } from "../band/band.ts";
import type { SearchResult } from "../kagi/parser.ts";
import { formatDuration, link, type RenderDetails } from "../kagi/render.ts";
import { sanitize } from "./format.ts";
import { errorLines, more, mutedSeg, numberArg, plural, resultText, stringArg, textLines, titleSeg, wrapAll } from "./kit.ts";
import type { ToolSpec, View } from "./tool.ts";

/** Results listed under the band before `… N more results`. */
export const SEARCH_PREVIEW_RESULTS = 3;

const flat = (text: string) => sanitize(text).replace(/\s+/g, " ").trim();
const failed = (view: View) => !view.context.isPartial && view.context.isError;

function detailsOf(view: View): RenderDetails | undefined {
	if (!view.result || view.context.isPartial || failed(view)) return undefined;
	const details = view.result.details;
	return details && typeof details === "object" ? (details as RenderDetails) : undefined;
}

/** The results; Kagi leaves the list out when there are none. */
function resultsOf(view: View): SearchResult[] | undefined {
	const details = detailsOf(view);
	if (!details) return undefined;
	if (!Array.isArray(details.results)) return details.resultCount === 0 ? [] : undefined;
	return details.results.filter((result) => !!result && typeof result.title === "string" && typeof result.url === "string");
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function summary(view: View): Seg[] {
	const details = detailsOf(view);
	const results = resultsOf(view);
	if (!details || !results) return [];
	const count = details.resultCount ?? results.length;
	const segs: Seg[] = [mutedSeg(` · ${count === 0 ? "no results" : plural(count, "result")}`)];
	if (details.status === "partial") segs.push({ text: " · partial", color: "warning" });
	if (details.cached) segs.push(mutedSeg(" · cached"));
	return segs;
}

function resultLine(view: View, result: SearchResult, rankWidth: number): string {
	const rank = view.paint.fg("dim", `${String(result.rank).padStart(rankWidth)}.`);
	const host = hostOf(result.url);
	return `${rank} ${view.paint.fg("toolOutput", flat(result.title))}${host ? `  ${link(view.paint.fg("muted", host), result.url)}` : ""}`;
}

/** Before structured details, or when a result carries none: its text. */
function plainLines(view: View, width: number): string[] {
	return wrapAll(textLines(resultText(view.result)).map((line) => view.paint.fg("toolOutput", line)), width);
}

function statusText(details: RenderDetails, results: readonly SearchResult[]): string {
	const shown = details.resultCount ?? results.length;
	const parts = [plural(shown, "result")];
	if (typeof details.requestedCount === "number" && details.requestedCount !== shown) parts.push(`of ${details.requestedCount} requested`);
	if (details.status === "partial") parts.push("partial");
	if (details.cached) parts.push("cached");
	if (typeof details.pagesFetched === "number" && details.pagesFetched > 1) parts.push(`${details.pagesFetched} pages`);
	return parts.join(" · ");
}

export function webSearchSpec(name: string): ToolSpec {
	return {
		label: () => name,
		title(view) {
			const query = stringArg(view.context.args, "query");
			const domain = stringArg(view.context.args, "domain");
			return [
				titleSeg(name),
				{ text: ` ${query ? flat(query) : "…"}`, color: query ? "accent" : "toolOutput" },
				...(domain ? [{ text: ` site:${flat(domain)}`, color: "toolOutput" }] : []),
				...summary(view),
			];
		},
		body(view, width) {
			if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
			if (!view.result || view.context.isPartial) return [];
			const results = resultsOf(view);
			if (!results) return plainLines(view, width).slice(0, SEARCH_PREVIEW_RESULTS);
			const shown = view.context.expanded ? results : results.slice(0, SEARCH_PREVIEW_RESULTS);
			const rankWidth = String(Math.max(0, ...shown.map((result) => result.rank))).length;
			const lines = wrapAll(shown.map((result) => resultLine(view, result, rankWidth)), width);
			const hidden = results.length - shown.length;
			return hidden > 0 ? [...lines, more(view.paint, view.kit, plural(hidden, "more result"))] : lines;
		},
		details(view) {
			const limit = numberArg(view.context.args, "limit");
			const took = detailsOf(view)?.durationMs;
			return ["Kagi search", ...(limit !== undefined ? [`limit ${limit}`] : []), ...(typeof took === "number" ? [`took ${formatDuration(took)}`] : [])].join(" · ");
		},
		head(view, width) {
			const query = stringArg(view.context.args, "query");
			return query ? wrapAll([view.paint.fg("accent", flat(query))], width) : [];
		},
		outputLabel: () => "results",
		output(view, width) {
			if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
			if (!view.result || view.context.isPartial) return [view.paint.fg("dim", "(searching…)")];
			const results = resultsOf(view);
			if (!results) return plainLines(view, width);
			if (results.length === 0) return [view.paint.fg("dim", "(no results)")];
			const rankWidth = String(Math.max(...results.map((result) => result.rank))).length;
			const pad = " ".repeat(rankWidth + 2);
			const blocks = results.map((result) => wrapAll([
				resultLine(view, result, rankWidth),
				`${pad}${link(view.paint.fg("dim", flat(result.url)), result.url)}`,
				...(result.snippet ? [`${pad}${view.paint.fg("muted", flat(result.snippet))}`] : []),
			], width));
			return [...blocks.flatMap((block) => [...block, ""]), view.paint.fg("muted", statusText(detailsOf(view)!, results))];
		},
	};
}
