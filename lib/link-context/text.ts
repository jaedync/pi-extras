/** Small text helpers shared by adapters: entities, HTML to text, times and quoting. */
import { parse, type HTMLElement } from "node-html-parser";

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

const BLOCK = new Set(["p", "div", "br", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "tr", "section", "article", "header", "footer", "table"]);

function walk(node: HTMLElement, out: string[]): void {
	for (const child of node.childNodes) {
		if (child.nodeType === 3) {
			out.push(child.text);
			continue;
		}
		if (child.nodeType !== 1) continue;
		const element = child as HTMLElement;
		const tag = element.tagName?.toLowerCase() ?? "";
		if (["script", "style", "noscript", "svg", "template", "iframe"].includes(tag)) continue;
		if (tag === "a") {
			const href = element.getAttribute("href");
			const label = element.text.trim();
			out.push(href && /^https?:/.test(href) && label && label !== href ? `[${label}](${href})` : label || href || "");
			continue;
		}
		if (/^h[1-6]$/.test(tag)) out.push(`\n\n${"#".repeat(Number(tag[1]))} `);
		else if (tag === "li") out.push("\n- ");
		else if (BLOCK.has(tag)) out.push("\n\n");
		if (tag === "pre" || tag === "code") out.push("`");
		walk(element, out);
		if (tag === "pre" || tag === "code") out.push("`");
		if (BLOCK.has(tag)) out.push("\n\n");
	}
}

/** Readable text from an HTML fragment, with links kept as markdown. */
export function htmlToText(html: string): string {
	const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, pre: true } });
	const out: string[] = [];
	walk(root, out);
	return tidy(decodeEntities(out.join("")));
}

export function tidy(text: string): string {
	return text.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** `1:02:03` style, the form people use when they cite a moment in a video. */
export function clock(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Parses `90`, `1:30`, `1:02:03` or `1m30s` into seconds. */
export function parseClock(text: string): number | undefined {
	const value = text.trim();
	if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
	if (/^\d+(?::\d{1,2}){1,2}$/.test(value)) return value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
	const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
	if (units && value) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
	return undefined;
}

export interface Range { readonly start: number; readonly end?: number }

/** `1:00-2:30`, `5:00-` or `-0:45`; the end is exclusive and open when absent. */
export function parseRange(text: string | undefined): Range | undefined {
	if (!text?.trim()) return undefined;
	const [from, to, extra] = text.split("-");
	if (extra !== undefined) throw new Error(`Range must look like 1:00-2:30, not ${text}`);
	const start = from?.trim() ? parseClock(from) : 0;
	const end = to?.trim() ? parseClock(to) : undefined;
	if (start === undefined || (to?.trim() && end === undefined) || (end !== undefined && end <= start)) throw new Error(`Range must look like 1:00-2:30, not ${text}`);
	return end === undefined ? { start } : { start, end };
}

export function quote(text: string): string {
	return text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

export function compactNumber(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

/** `12 likes · 3 replies` from labelled counts, skipping unknown ones. */
export function stats(pairs: ReadonlyArray<[string, unknown]>): string {
	return pairs.flatMap(([label, value]) => {
		const shown = compactNumber(value);
		return shown === undefined ? [] : [`${shown} ${label}`];
	}).join(" · ");
}

export function isoDate(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString().replace(/\.\d+Z$/, "Z");
	if (typeof value !== "string" || !value) return undefined;
	if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toISOString().replace(/\.\d+Z$/, "Z");
}

/** Pulls `<meta property|name="key" content="...">` values; keys are lower-cased. */
export function metaTags(html: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
		const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
		if (key && content && !found.has(key)) found.set(key, decodeEntities(content[1] ?? content[2] ?? ""));
	}
	return found;
}

/** JSON-LD blocks that parse; malformed ones are skipped. */
export function jsonLd(html: string): unknown[] {
	const blocks: unknown[] = [];
	for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			const value = JSON.parse(match[1]) as unknown;
			blocks.push(...(Array.isArray(value) ? value : [value]));
		} catch {
			// Sites ship broken JSON-LD often enough; the page's other metadata still applies.
		}
	}
	return blocks;
}
