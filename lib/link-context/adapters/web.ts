/**
 * Any other page: title and preview metadata, then readable text from the
 * page's `<article>` or `<main>`, or the body without navigation. Plain text
 * and JSON are returned as they are.
 */
import { parse } from "node-html-parser";
import { agentsFor } from "../config.ts";
import { BROWSER_UA, get, PLAIN_UA, PREVIEW_UA } from "../http.ts";
import { htmlToText, isoDate, jsonLd, metaTags } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const DROP = "script, style, noscript, nav, header, footer, aside, form, svg, iframe, [role=navigation], [aria-hidden=true], .sidebar, .advert, .ad, .cookie, .newsletter";

export function mainText(html: string): string {
	const root = parse(html, { comment: false });
	const scope = root.querySelector("article") ?? root.querySelector("main") ?? root.querySelector("[role=main]") ?? root.querySelector("body") ?? root;
	for (const node of scope.querySelectorAll(DROP)) node.remove();
	return htmlToText(scope.innerHTML);
}

export function webFromHtml(html: string, url: string): Pulled {
	const meta = metaTags(html);
	const title = meta.get("og:title") ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? new URL(url).hostname;
	const article = jsonLd(html).find((block) => typeof (block as { articleBody?: unknown }).articleBody === "string") as { articleBody?: string; author?: { name?: string } | { name?: string }[]; datePublished?: string } | undefined;
	const author = article?.author ? (Array.isArray(article.author) ? article.author.map((a) => a.name).join(", ") : article.author.name) : meta.get("author") ?? meta.get("article:author");
	const date = isoDate(article?.datePublished ?? meta.get("article:published_time") ?? meta.get("date"));
	const description = meta.get("og:description") ?? meta.get("description");
	const body = mainText(html);
	const longer = article?.articleBody && article.articleBody.length > body.length ? article.articleBody : body;
	const head = [`# ${title}`, [meta.get("og:site_name"), author, date].filter(Boolean).join(" · "), url, description && !longer.startsWith(description.slice(0, 60)) ? `> ${description}` : ""].filter(Boolean).join("\n");
	const image = meta.get("og:image");
	return { platform: "web", title, url, markdown: `${head}\n\n${longer || "(no readable text found; the page may need JavaScript)"}`, photos: image ? [new URL(image, url).href] : [] };
}

export async function pullWeb(url: string, ctx: AdapterContext): Promise<Pulled> {
	const page = await get(url, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "web", [BROWSER_UA, PREVIEW_UA, PLAIN_UA]) });
	if (/json/i.test(page.contentType)) return { platform: "web", title: url, url: page.url, markdown: `\`\`\`json\n${page.body}\n\`\`\``, photos: [] };
	if (/^text\/plain|markdown/i.test(page.contentType)) return { platform: "web", title: url, url: page.url, markdown: page.body, photos: [] };
	if (!/html|xml/i.test(page.contentType) && page.contentType) throw new Error(`This link is ${page.contentType.split(";")[0]}, not a page. Use fetch_content for PDFs and documents.`);
	return webFromHtml(page.body, page.url);
}
