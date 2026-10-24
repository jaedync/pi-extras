/**
 * Reads the API's JSON and removes repeated results. The index often lists
 * one page twice: the same URL again, or a mirror host of the same site
 * (ftc.gov and search.ftc.gov) with the same title and description. Only
 * the first, higher-ranked copy stays.
 */
import { cleanDetail, errors } from "./errors.ts";

export const MAX_TITLE_CHARS = 200;
const MAX_URL_CHARS = 2048;
/** Kept whole here; the output cuts it to its own length. */
const MAX_DESCRIPTION_CHARS = 2000;

export interface GovResult {
	rank: number;
	title: string;
	url: string;
	snippet: string;
	excerptClipped: boolean;
}

export interface ParsedResponse {
	results: GovResult[];
	/** Records the API sent. */
	retrievedCount: number;
	/** Records left out because their URL was not a plain web address. */
	rejectedCount: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function webUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > MAX_URL_CHARS) return undefined;
	try {
		const url = new URL(value.trim());
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function record(item: unknown): Omit<GovResult, "rank"> | undefined {
	if (!isObject(item)) return undefined;
	const url = webUrl(item.url);
	if (!url) return undefined;
	const title = typeof item.title === "string" ? cleanDetail(item.title, MAX_TITLE_CHARS) : "";
	const snippet = typeof item.description === "string" ? cleanDetail(item.description, MAX_DESCRIPTION_CHARS) : "";
	return { title: title || new URL(url).hostname, url, snippet, excerptClipped: false };
}

/** The `data.web` list of a 200 answer. */
export function parseResponse(body: string): ParsedResponse {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw errors.response("the body is not JSON");
	}
	if (!isObject(json) || json.success !== true || !isObject(json.data)) throw errors.response("success or data is missing");
	const web = json.data.web ?? [];
	if (!Array.isArray(web)) throw errors.response("data.web is not a list");
	const results: GovResult[] = [];
	for (const item of web) {
		const parsed = record(item);
		if (parsed) results.push({ ...parsed, rank: results.length + 1 });
	}
	return { results, retrievedCount: web.length, rejectedCount: web.length - results.length };
}

const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

function urlKey(href: string): string {
	const url = new URL(href);
	const host = url.hostname.replace(/^www\./, "");
	const path = url.pathname.replace(/\/+$/, "");
	return `${host}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
}

/** The last two labels: ftc.gov for both ftc.gov and search.ftc.gov. */
function siteOf(href: string): string {
	return new URL(href).hostname.split(".").slice(-2).join(".");
}

function contentKey(result: GovResult): string | undefined {
	// A title alone is too weak: many code sections share a heading such as "Definitions".
	if (!result.snippet) return undefined;
	return `${siteOf(result.url)}\n${normal(result.title)}\n${normal(result.snippet)}`;
}

/** Drops repeats, keeps rank order and numbers the rest from 1. */
export function dedupe(results: readonly GovResult[]): { results: GovResult[]; duplicateCount: number } {
	const seen = new Set<string>();
	const kept: GovResult[] = [];
	for (const result of results) {
		const keys = [`url:${urlKey(result.url)}`, ...(contentKey(result) ? [`content:${contentKey(result)}`] : [])];
		if (keys.some((key) => seen.has(key))) continue;
		for (const key of keys) seen.add(key);
		kept.push({ ...result, rank: kept.length + 1 });
	}
	return { results: kept, duplicateCount: results.length - kept.length };
}

/** The reason in a 400 answer: `error` plus the first few `details`, cleaned and bounded. */
export function badRequestReason(body: string): string {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return "";
	}
	if (!isObject(json)) return "";
	const parts: string[] = [];
	if (typeof json.error === "string") parts.push(json.error);
	const details = Array.isArray(json.details) ? json.details.slice(0, 3) : [];
	for (const detail of details) {
		if (typeof detail === "string") parts.push(detail);
		else if (isObject(detail) && typeof detail.message === "string") {
			const path = Array.isArray(detail.path) ? detail.path.filter((part) => typeof part === "string" || typeof part === "number").join(".") : "";
			parts.push(path ? `${path}: ${detail.message}` : detail.message);
		}
	}
	return cleanDetail(parts.join("; "));
}
