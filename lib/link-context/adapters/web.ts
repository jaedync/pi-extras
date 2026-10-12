/**
 * Any other page: title and preview metadata, then readable text from the
 * page's `<article>` or `<main>`, or the body without navigation. Plain text
 * and JSON are returned as they are.
 */
import { parse } from "node-html-parser";
import { agentsFor } from "../config.ts";
import { BROWSER_UA, get, PLAIN_UA, PREVIEW_UA } from "../http.ts";
import { decodeEntities, fenced, htmlToText, isoDate, jsonLd, metaTags } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const DROP = "script, style, noscript, nav, header, footer, aside, form, svg, iframe, [role=navigation], [aria-hidden=true], .sidebar, .advert, .ad, .cookie, .newsletter";

export function mainText(html: string): string {
	const root = parse(html, { comment: false });
	const scope = root.querySelector("article") ?? root.querySelector("main") ?? root.querySelector("[role=main]") ?? root.querySelector("body") ?? root;
	for (const node of scope.querySelectorAll(DROP)) node.remove();
	return htmlToText(scope.innerHTML);
}

type Author = { name?: unknown } | null | undefined;

/** JSON-LD names, which third-party pages ship as one object, a list, or nulls. */
function authorNames(author: Author | Author[]): string | undefined {
	const names = (Array.isArray(author) ? author : [author]).map((a) => a?.name).filter((name): name is string => typeof name === "string" && !!name.trim());
	return names.length ? names.join(", ") : undefined;
}

/** The og:image as an absolute link, or nothing when the page's value is not a URL. */
function previewImage(image: string | undefined, url: string): string[] {
	if (!image) return [];
	try {
		return [new URL(image, url).href];
	} catch {
		return [];
	}
}

export function webFromHtml(html: string, url: string): Pulled {
	const meta = metaTags(html);
	const tag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
	const title = meta.get("og:title") ?? (tag ? decodeEntities(tag) : undefined) ?? new URL(url).hostname;
	const article = jsonLd(html).find((block) => typeof (block as { articleBody?: unknown }).articleBody === "string") as { articleBody?: string; author?: Author | Author[]; datePublished?: string } | undefined;
	const author = authorNames(article?.author) ?? meta.get("author") ?? meta.get("article:author");
	const date = isoDate(article?.datePublished ?? meta.get("article:published_time") ?? meta.get("date"));
	const description = meta.get("og:description") ?? meta.get("description");
	const body = mainText(html);
	const longer = article?.articleBody && article.articleBody.length > body.length ? article.articleBody : body;
	const head = [`# ${title}`, [meta.get("og:site_name"), author, date].filter(Boolean).join(" · "), url, description && !longer.startsWith(description.slice(0, 60)) ? `> ${description}` : ""].filter(Boolean).join("\n");
	return { platform: "web", title, url, markdown: `${head}\n\n${longer || "(no readable text found; the page may need JavaScript)"}`, photos: previewImage(meta.get("og:image"), url) };
}

export async function pullWeb(url: string, ctx: AdapterContext): Promise<Pulled> {
	const page = await get(url, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "web", [BROWSER_UA, PREVIEW_UA, PLAIN_UA]) });
	if (/json/i.test(page.contentType)) return { platform: "web", title: url, url: page.url, markdown: fenced(page.body, "json"), photos: [] };
	if (/^text\/plain|markdown/i.test(page.contentType)) return { platform: "web", title: url, url: page.url, markdown: page.body, photos: [] };
	if (!/html|xml/i.test(page.contentType) && page.contentType) throw new Error(`This link is ${page.contentType.split(";")[0]}, not a page. Use fetch_content for PDFs and documents.`);
	return webFromHtml(page.body, page.url);
}
