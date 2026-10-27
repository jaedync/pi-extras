/**
 * Any other page: title and preview metadata, then readable text from the
 * page's `<article>` or `<main>`, or the body without navigation. Plain text
 * and JSON are returned as they are. A link whose content-type says it is an
 * image (a download link with no file extension) is the image. When a site
 * refuses plain HTTP clients (403, 429, 503, a bot check, a timeout or a
 * dropped connection), a local headless browser reads the page instead.
 */
import { parse } from "node-html-parser";
import { isChallenge, renderPage } from "../browser.ts";
import { agentsFor } from "../config.ts";
import { BROWSER_UA, get, HttpError, type HttpResult, IMAGE_TYPE, PLAIN_UA, PREVIEW_UA } from "../http.ts";
import { sniffImage } from "../media/image-bytes.ts";
import { MAX_IMAGE_BYTES, prepareImage, UNLOADABLE_IMAGE } from "../media/images.ts";
import { decodeEntities, fenced, htmlToText, isoDate, jsonLd, metaTags } from "../text.ts";
import { plainLine, proseLines } from "../summary.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const DROP = "script, style, noscript, nav, header, footer, aside, form, svg, iframe, [role=navigation], [aria-hidden=true], .sidebar, .advert, .ad, .cookie, .newsletter";

/** Below this share of the page's text, the longest `<article>` is a teaser card, not the content. */
const ARTICLE_SHARE = 0.1;

export function mainText(html: string): string {
	const root = parse(html, { comment: false });
	const outer = root.querySelector("main") ?? root.querySelector("[role=main]") ?? root.querySelector("body") ?? root;
	const article = root.querySelectorAll("article").reduce<ReturnType<typeof root.querySelector>>((best, node) => (!best || node.text.length > best.text.length ? node : best), null);
	const scope = article && article.text.length >= outer.text.length * ARTICLE_SHARE ? article : outer;
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

/** The line every Wikipedia article starts with; it says nothing about the article. */
const WIKIPEDIA_TAGLINE = /^From Wikipedia, the free encyclopedia$/m;

/** `note` goes under the heading, for example to say how the page was read. */
export function webFromHtml(html: string, url: string, note?: string): Pulled {
	const meta = metaTags(html);
	const tag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
	const title = meta.get("og:title") ?? (tag ? decodeEntities(tag) : undefined) ?? new URL(url).hostname;
	const article = jsonLd(html).find((block) => typeof (block as { articleBody?: unknown }).articleBody === "string") as { articleBody?: string; author?: Author | Author[]; datePublished?: string } | undefined;
	const author = authorNames(article?.author) ?? meta.get("author") ?? meta.get("article:author");
	const date = isoDate(article?.datePublished ?? meta.get("article:published_time") ?? meta.get("date"));
	const description = meta.get("og:description") ?? meta.get("description");
	const body = mainText(html);
	const longer = article?.articleBody && article.articleBody.length > body.length ? article.articleBody : body;
	const head = [`# ${title}`, [meta.get("og:site_name"), author, date].filter(Boolean).join(" · "), url, description && !longer.startsWith(description.slice(0, 60)) ? `> ${description}` : "", note ? `\n${note}` : ""].filter(Boolean).join("\n");
	const byline = plainLine([meta.get("og:site_name"), author, date].filter(Boolean).join(" · "));
	const summary = [byline, ...(description ? [plainLine(description)] : proseLines(longer.replace(WIKIPEDIA_TAGLINE, ""), title, 2))].filter(Boolean);
	return { platform: "web", title, url, markdown: `${head}\n\n${longer || "(no readable text found; the page may need JavaScript)"}`, summary, photos: previewImage(meta.get("og:image"), url) };
}

const BLOCKED = new Set([403, 429, 503]);
/** A name that does not resolve fails in a browser too. */
const NO_NAME = /^(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA)$/;

/** Why a failed plain read may still work in a browser, or nothing when it will not (a 404, a bad name, the caller's abort). */
function blockedReason(error: unknown): string | undefined {
	if (error instanceof HttpError) return BLOCKED.has(error.status) ? `the site refused the plain request (HTTP ${error.status})` : undefined;
	if ((error as Error)?.name === "TimeoutError") return "the plain request timed out";
	if (error instanceof TypeError && error.message === "fetch failed") return NO_NAME.test(String((error.cause as { code?: unknown } | undefined)?.code)) ? undefined : "the site dropped the plain request";
	return undefined;
}

/** The page a browser makes for an image link: no text and one `<img>` of the link itself. */
function imageViewer(html: string, url: string): boolean {
	const root = parse(html);
	const body = root.querySelector("body") ?? root;
	const images = body.querySelectorAll("img");
	if (images.length !== 1 || body.text.trim()) return false;
	try {
		return new URL(images[0].getAttribute("src") ?? "", url).href === new URL(url).href;
	} catch {
		return false;
	}
}

async function pullWithBrowser(url: string, ctx: AdapterContext, reason: string, failure: Error): Promise<Pulled> {
	const setting = ctx.config.browser;
	if (setting === false) throw failure;
	ctx.progress(`${reason}; reading it with a local browser`);
	let body: string;
	try {
		body = await (ctx.render ?? renderPage)(url, { signal: ctx.signal, ...(typeof setting === "string" ? { browser: setting } : {}) });
	} catch (error) {
		ctx.signal?.throwIfAborted();
		throw new Error(`${failure.message}. ${(error as Error).message}`);
	}
	if (isChallenge(body)) throw new Error(`${failure.message}, and the local browser also got a bot check.`);
	if (imageViewer(body, url)) throw new Error(`${failure.message}; the link is an image that the site refused.`);
	return webFromHtml(body, url, `_Read with a local browser: ${reason}._`);
}

/**
 * The bytes already read are the image, under the same limits as an image link
 * with a file extension. The result names the link that was given: a redirect
 * target can be a signed URL whose token must not reach the transcript.
 */
async function pullImage(page: HttpResult, url: string, ctx: AdapterContext): Promise<Pulled> {
	const pulled: Pulled = { platform: "image", title: url, url, markdown: `Image: ${url}`, photos: [] };
	if (!ctx.options.images) return pulled;
	const image = page.bytes && page.bytes.length <= MAX_IMAGE_BYTES ? await prepareImage(page.bytes) : undefined;
	if (!image) throw new Error(UNLOADABLE_IMAGE);
	return { ...pulled, images: [image] };
}

export async function pullWeb(url: string, ctx: AdapterContext): Promise<Pulled> {
	let page: HttpResult;
	try {
		page = await get(url, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "web", [BROWSER_UA, PREVIEW_UA, PLAIN_UA]) });
	} catch (error) {
		ctx.signal?.throwIfAborted();
		const reason = blockedReason(error);
		if (!reason) throw error;
		return pullWithBrowser(url, ctx, reason, error as Error);
	}
	if (/html/i.test(page.contentType) && isChallenge(page.body)) return pullWithBrowser(url, ctx, "the site showed a bot check", new Error(`${new URL(url).hostname} showed a bot check`));
	// A server that does not know the type sends octet-stream or no type; then the bytes decide.
	if (IMAGE_TYPE.test(page.contentType) || (page.bytes && sniffImage(page.bytes))) return pullImage(page, url, ctx);
	if (/json/i.test(page.contentType)) return { platform: "web", title: url, url: page.url, markdown: fenced(page.body, "json"), photos: [] };
	if (/^text\/plain|markdown/i.test(page.contentType)) return { platform: "web", title: url, url: page.url, markdown: page.body, photos: [] };
	if (!/html|xml/i.test(page.contentType) && page.contentType) throw new Error(`This link is ${page.contentType.split(";")[0]}, not a page. Use fetch_content for PDFs and documents.`);
	return webFromHtml(page.body, page.url);
}
