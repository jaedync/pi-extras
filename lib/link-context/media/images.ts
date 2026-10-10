/**
 * Images for the model: a post's photos, image links in posts and comments
 * (imgur, i.redd.it, direct files), and video thumbnails. Capped in count and
 * size, and fetched through the same checked redirects as every other request.
 * An image that fails to load stays in the text as a link.
 */
import { deadline, PLAIN_UA, readBytes, request, type Fetcher } from "../http.ts";
import type { ImageBlock } from "../types.ts";
import { IMGUR_ID } from "../url.ts";

export const MAX_IMAGES = 6;
/** Base64 adds a third; this keeps each image under the 5 MB that providers accept for one image. */
export const MAX_IMAGE_BYTES = 3_700_000;
const TYPES = /^image\/(jpeg|png|webp|gif)\b/i;
const IMAGE_FILE = /\.(?:jpe?g|png|webp|gif)$/i;
const IMAGE_HOSTS = new Set(["i.imgur.com", "i.redd.it", "preview.redd.it", "pbs.twimg.com", "media.giphy.com", "i.giphy.com"]);

/** Smaller variants where a host offers them, so an image costs fewer tokens. */
export function sized(url: string): string {
	const parsed = new URL(url);
	if (parsed.hostname === "pbs.twimg.com" && parsed.pathname.startsWith("/media/")) {
		const format = /\.(jpe?g|png|webp)$/i.exec(parsed.pathname)?.[1] ?? parsed.searchParams.get("format") ?? "jpg";
		return `https://pbs.twimg.com${parsed.pathname.replace(/\.(jpe?g|png|webp)$/i, "")}?format=${format === "jpeg" ? "jpg" : format}&name=medium`;
	}
	return url;
}

/** The image file behind a link, when the link is to one image; albums and pages are not. */
export function imageLink(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	// imgur.com/<id> is a page for one image; /a/ and /gallery/ are albums that need imgur's API.
	if ((host === "imgur.com" || host === "m.imgur.com") && IMGUR_ID.test(url.pathname)) return `https://i.imgur.com${url.pathname}.jpg`;
	if (IMAGE_HOSTS.has(host) && (IMAGE_FILE.test(url.pathname) || host === "pbs.twimg.com")) return url.href;
	if (IMAGE_FILE.test(url.pathname)) return url.href;
	return undefined;
}

/** Image links in text, in order, without repeats. */
export function imageLinks(text: string): string[] {
	const found = (text.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? []).map((url) => imageLink(url.replace(/[.,;:!?]+$/, ""))).filter((url): url is string => !!url);
	return [...new Set(found)];
}

async function one(url: string, fetcher: Fetcher | undefined, signal: AbortSignal): Promise<ImageBlock | undefined> {
	const { response, url: final } = await request(sized(url), { agent: PLAIN_UA, headers: { Accept: "image/webp,image/jpeg,image/png,image/*;q=0.8" }, signal, fetcher });
	const type = response.headers.get("content-type") ?? "";
	// imgur answers a deleted image with a placeholder instead of an error.
	if (!response.ok || !TYPES.test(type) || /\/removed\.png$/.test(final)) {
		void response.body?.cancel();
		return undefined;
	}
	const bytes = await readBytes(response, MAX_IMAGE_BYTES);
	return { type: "image", data: bytes.toString("base64"), mimeType: type.split(";")[0].trim().toLowerCase() };
}

export async function fetchImages(urls: readonly string[], options: { fetcher?: Fetcher; signal?: AbortSignal; max?: number } = {}): Promise<ImageBlock[]> {
	const unique = [...new Set(urls)].slice(0, options.max ?? MAX_IMAGES);
	const signal = deadline(options.signal);
	const results = await Promise.allSettled(unique.map((url) => one(url, options.fetcher, signal)));
	return results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
}
