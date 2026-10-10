/**
 * One link in, one result out: route to the adapter, fall back to the web
 * page when an adapter cannot read the link, then attach photos and, when a
 * post carries a video and the caller asked for it, the video's transcript
 * and frames.
 */
import { pullBluesky } from "./adapters/bluesky.ts";
import { NotHandled, pullGist, pullGithub } from "./adapters/github.ts";
import { pullHackerNews } from "./adapters/hackernews.ts";
import { pullMastodon } from "./adapters/mastodon.ts";
import { pullReddit } from "./adapters/reddit.ts";
import { pullLinkedin, pullThreads } from "./adapters/social-pages.ts";
import { pullWeb } from "./adapters/web.ts";
import { pullX } from "./adapters/x.ts";
import { fetchImages, imageLinks } from "./media/images.ts";
import { pullVideo } from "./media/video.ts";
import type { AdapterContext, Pulled } from "./types.ts";
import { classify, parseUrl, type Target } from "./url.ts";

/** Posts and comments, where an image link is part of what was said; pages and READMEs link images for decoration. */
const LINKED_IMAGES = new Set(["x", "bluesky", "threads", "mastodon", "reddit", "hackernews", "linkedin"]);

export interface PullDeps {
	readonly video: typeof pullVideo;
	readonly images: typeof fetchImages;
}

const DEFAULT_DEPS: PullDeps = { video: pullVideo, images: fetchImages };

async function route(target: Target, url: string, ctx: AdapterContext, deps: PullDeps): Promise<Pulled> {
	switch (target.kind) {
		case "x": return pullX(target.id, ctx);
		case "bluesky": return pullBluesky(target.actor, target.rkey, ctx);
		case "threads": return pullThreads(target.url, ctx);
		case "reddit": return pullReddit({ path: target.path }, ctx);
		case "reddit-share": return pullReddit({ share: target.url }, ctx);
		case "hackernews": return pullHackerNews(target.id, ctx);
		case "github": return pullGithub(target.owner, target.repo, target.rest, ctx);
		case "gist": return pullGist(target.id, ctx);
		case "linkedin": return pullLinkedin(target.url, ctx);
		case "mastodon": return pullMastodon(target.origin, target.id, ctx);
		case "video": return deps.video(target.url, target.site, ctx);
		case "image": return { platform: "image", title: target.url, url: target.url, markdown: `Image: ${target.url}`, photos: [target.url] };
		case "web": return pullWeb(target.url, ctx);
		default: return pullWeb(url, ctx);
	}
}

/** Adapters whose failure means "not this kind of page" rather than "the site refused". */
function fallsBack(target: Target, error: unknown): boolean {
	if (error instanceof NotHandled) return true;
	if (target.kind === "mastodon") return true;
	// Instagram photo posts and other pages yt-dlp has no video for.
	return target.kind === "video" && target.site !== "file" && /unsupported url|no video|no media|not a video|there is no video/i.test(String((error as Error)?.message));
}

/** Transcript and frames of a video inside a post, with the video's own heading dropped. */
async function attachVideo(pulled: Pulled, ctx: AdapterContext, deps: PullDeps): Promise<Pulled> {
	if (!pulled.videoUrl) return pulled;
	try {
		// The URL comes from the post's third-party JSON, so it gets the same check as a link the user gave.
		const video = await deps.video(parseUrl(pulled.videoUrl).href, "file", { ...ctx, options: { ...ctx.options, comments: 0, images: false } });
		const sections = video.markdown.split(/\n(?=## )/).filter((part) => /^## (Transcript|Frames)/.test(part)).map((part) => part.trim());
		return { ...pulled, markdown: [pulled.markdown, "# Attached video", ...sections].join("\n\n"), images: [...(pulled.images ?? []), ...(video.images ?? [])], files: video.files };
	} catch (error) {
		return { ...pulled, markdown: `${pulled.markdown}\n\n_The attached video could not be read: ${(error as Error).message}_` };
	}
}

export async function pull(raw: string, ctx: AdapterContext, deps: PullDeps = DEFAULT_DEPS, wantsVideo = false): Promise<Pulled> {
	const url = parseUrl(raw);
	const target = classify(url);
	let pulled: Pulled;
	try {
		pulled = await route(target, url.href, ctx, deps);
	} catch (error) {
		ctx.signal?.throwIfAborted();
		if (!fallsBack(target, error)) throw error;
		pulled = await pullWeb(url.href, ctx);
	}
	const photos = [...new Set([...(pulled.photos ?? []), ...(LINKED_IMAGES.has(pulled.platform) ? imageLinks(pulled.markdown) : [])])];
	if (ctx.options.images && photos.length) {
		const images = await deps.images(photos, { fetcher: ctx.fetcher, signal: ctx.signal });
		if (target.kind === "image" && !images.length) throw new Error("The image could not be loaded: it is missing, too large (over 3.7 MB), or not a JPEG, PNG, WebP or GIF.");
		if (images.length) pulled = { ...pulled, images: [...images, ...(pulled.images ?? [])] };
	}
	if (target.kind !== "video" && wantsVideo) pulled = await attachVideo(pulled, ctx, deps);
	return pulled;
}
