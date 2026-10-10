/**
 * Reddit through the JSON view of old.reddit.com. Reddit answers that view for
 * link-preview crawlers but sends other clients to a login page, and www's
 * JSON is refused outright, hence the host and the user-agent chain.
 */
import { agentsFor } from "../config.ts";
import { get, getJson, PLAIN_UA, PREVIEW_UA } from "../http.ts";
import { renderThread, type Post, type Reply } from "../post.ts";
import { decodeEntities, isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const ORIGIN = "https://old.reddit.com";

interface Thing<T> { kind?: string; data?: T }
interface Listing<T> { data?: { children?: Thing<T>[] } }
export interface LinkData {
	title?: string;
	selftext?: string;
	author?: string;
	subreddit_name_prefixed?: string;
	created_utc?: number;
	score?: number;
	upvote_ratio?: number;
	num_comments?: number;
	url?: string;
	permalink?: string;
	is_self?: boolean;
	is_video?: boolean;
	media?: { reddit_video?: { fallback_url?: string; duration?: number } } | null;
	preview?: { images?: { source?: { url?: string } }[] };
	gallery_data?: { items?: { media_id?: string; caption?: string }[] };
	media_metadata?: Record<string, { s?: { u?: string; gif?: string } }>;
	crosspost_parent_list?: LinkData[];
}
export interface CommentData {
	author?: string;
	body?: string;
	score?: number;
	created_utc?: number;
	permalink?: string;
	replies?: Listing<CommentData> | "";
}

function galleryUrls(link: LinkData): string[] {
	return (link.gallery_data?.items ?? []).map((item) => link.media_metadata?.[item.media_id ?? ""]?.s).map((source) => source?.u ?? source?.gif).filter((url): url is string => !!url).map(decodeEntities);
}

export function linkPost(link: LinkData): Post & { images: string[]; videoUrl?: string } {
	const images = galleryUrls(link);
	const preview = link.preview?.images?.[0]?.source?.url;
	if (!images.length && preview) images.push(decodeEntities(preview));
	const media: string[] = [];
	const video = link.media?.reddit_video;
	if (video?.fallback_url) media.push(`video${video.duration ? ` (${video.duration}s)` : ""}: ${video.fallback_url}`);
	media.push(...images.map((url) => `image: ${url}`));
	if (!link.is_self && link.url && !link.url.includes("/comments/") && !images.includes(link.url)) media.push(`link: ${link.url}`);
	const crosspost = link.crosspost_parent_list?.[0];
	return {
		author: `u/${link.author ?? "[deleted]"}`,
		date: isoDate(link.created_utc),
		url: link.permalink ? `https://www.reddit.com${link.permalink}` : undefined,
		text: `# ${link.title ?? "(untitled)"}\n${link.subreddit_name_prefixed ?? ""}\n\n${link.selftext ?? ""}`.trim(),
		stats: stats([["points", link.score], ["comments", link.num_comments]]) + (link.upvote_ratio ? ` · ${Math.round(link.upvote_ratio * 100)}% upvoted` : ""),
		media,
		quoted: crosspost ? linkPost(crosspost) : undefined,
		images,
		videoUrl: video?.fallback_url && link.permalink ? `https://www.reddit.com${link.permalink}` : undefined,
	};
}

/** Reddit's own order (best first), depth-first, skipping "load more" stubs. */
export function commentReplies(listing: Listing<CommentData> | "" | undefined, limit: number, depth = 0, out: Reply[] = []): Reply[] {
	if (!listing) return out;
	for (const child of listing.data?.children ?? []) {
		if (out.length >= limit) break;
		if (child.kind !== "t1" || !child.data) continue;
		const data = child.data;
		out.push({ post: { author: `u/${data.author ?? "[deleted]"}`, date: isoDate(data.created_utc), text: data.body ?? "", stats: stats([["points", data.score]]) }, depth });
		commentReplies(data.replies, limit, depth + 1, out);
	}
	return out;
}

/** Share links (`/r/x/s/abc`) only redirect to the real permalink. */
async function resolveShare(url: string, ctx: AdapterContext): Promise<string> {
	const result = await get(url, { signal: ctx.signal, fetcher: ctx.fetcher, agents: [PLAIN_UA], accept: () => true, maxBytes: 4_000_000 });
	const path = new URL(result.url).pathname;
	if (!path.includes("/comments/")) throw new Error("This Reddit share link did not lead to a post.");
	return path;
}

export async function pullReddit(target: { path?: string; share?: string }, ctx: AdapterContext): Promise<Pulled> {
	const path = target.share ? await resolveShare(target.share, ctx) : (target.path as string);
	const limit = Math.max(1, ctx.options.comments);
	const url = `${ORIGIN}${path.replace(/\/$/, "")}/.json?raw_json=1&limit=${Math.min(500, limit * 2)}&depth=6`;
	const data = await getJson<[Listing<LinkData>, Listing<CommentData>]>(url, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "reddit", [PREVIEW_UA, PLAIN_UA]) });
	const link = data[0]?.data?.children?.[0]?.data;
	if (!link) throw new Error("Reddit returned no post for that link.");
	const post = linkPost(link);
	const replies = ctx.options.comments > 0 ? commentReplies(data[1], ctx.options.comments) : [];
	return {
		platform: "reddit",
		title: link.title ?? "Reddit post",
		url: post.url ?? `https://www.reddit.com${path}`,
		markdown: renderThread([], post, replies, undefined, link.num_comments),
		photos: post.images,
		videoUrl: post.videoUrl,
	};
}
