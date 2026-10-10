/**
 * X/Twitter through the public FxTwitter API: no login, no key. It returns one
 * status at a time with its quote; there is no replies endpoint, so context is
 * the chain of parents walked through `replying_to_status`.
 */
import { agentsFor } from "../config.ts";
import { getJson, PLAIN_UA } from "../http.ts";
import { renderThread, type Post } from "../post.ts";
import { isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const API = "https://api.fxtwitter.com/status/";
const MAX_PARENTS = 8;

interface FxVariant { url?: string; bitrate?: number; content_type?: string }
interface FxMedia { type?: string; url?: string; thumbnail_url?: string; duration?: number; altText?: string; variants?: FxVariant[] }

const MAX_VIDEO_HEIGHT = 720;

/** The sharpest MP4 at 720p or less: enough to read on-screen text, far smaller than the 4K original. */
export function videoFile(item: FxMedia): string | undefined {
	const sized = (item.variants ?? []).filter((v) => v.content_type === "video/mp4" && v.url).map((v) => ({ url: v.url as string, height: Number(/\/(\d+)x(\d+)\//.exec(v.url as string)?.[2] ?? 0), bitrate: v.bitrate ?? 0 }));
	const fit = sized.filter((v) => v.height > 0 && v.height <= MAX_VIDEO_HEIGHT).sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)[0];
	return fit?.url ?? sized.sort((a, b) => a.bitrate - b.bitrate)[0]?.url ?? item.url;
}
export interface FxTweet {
	url?: string;
	text?: string;
	author?: { name?: string; screen_name?: string };
	created_timestamp?: number;
	created_at?: string;
	likes?: number;
	retweets?: number;
	replies?: number;
	quotes?: number;
	views?: number | null;
	media?: { all?: FxMedia[]; photos?: FxMedia[]; videos?: FxMedia[]; external?: FxMedia };
	quote?: FxTweet;
	poll?: { choices?: { label?: string; percentage?: number }[]; total_votes?: number; time_left_en?: string };
	article?: { title?: string; preview_text?: string };
	community_note?: { text?: string } | null;
	replying_to_status?: string | null;
}

function media(tweet: FxTweet): string[] {
	const items = tweet.media?.all ?? [...(tweet.media?.photos ?? []), ...(tweet.media?.videos ?? [])];
	const lines = items.map((item) => {
		const kind = item.type === "gif" ? "gif" : item.type === "video" ? "video" : "photo";
		const length = item.duration ? ` (${Math.round(item.duration)}s)` : "";
		const alt = item.altText ? ` alt: ${item.altText}` : "";
		return `${kind}${length}: ${item.url ?? item.thumbnail_url ?? "?"}${alt}`;
	});
	if (tweet.media?.external?.url) lines.push(`embedded video: ${tweet.media.external.url}`);
	return lines;
}

export function tweetPost(tweet: FxTweet): Post {
	let text = tweet.text ?? "";
	if (tweet.article?.title) text = `${text}\n\nArticle: ${tweet.article.title}${tweet.article.preview_text ? `\n${tweet.article.preview_text}` : ""}`.trim();
	if (tweet.poll?.choices?.length) {
		const rows = tweet.poll.choices.map((choice) => `- ${choice.label}: ${choice.percentage ?? "?"}%`);
		text += `\n\nPoll (${tweet.poll.total_votes ?? "?"} votes${tweet.poll.time_left_en ? `, ${tweet.poll.time_left_en}` : ""}):\n${rows.join("\n")}`;
	}
	if (tweet.community_note?.text) text += `\n\nCommunity note: ${tweet.community_note.text}`;
	return {
		author: tweet.author?.name ?? tweet.author?.screen_name ?? "unknown",
		handle: tweet.author?.screen_name,
		date: isoDate(tweet.created_timestamp ?? tweet.created_at),
		url: tweet.url,
		text,
		stats: stats([["likes", tweet.likes], ["reposts", tweet.retweets], ["replies", tweet.replies], ["quotes", tweet.quotes], ["views", tweet.views]]),
		media: media(tweet),
		quoted: tweet.quote ? tweetPost(tweet.quote) : undefined,
	};
}

export function photoUrls(tweet: FxTweet): string[] {
	const items = tweet.media?.all ?? [...(tweet.media?.photos ?? []), ...(tweet.media?.videos ?? [])];
	return items.map((item) => (item.type === "photo" ? item.url : item.thumbnail_url)).filter((url): url is string => !!url);
}

export async function pullX(id: string, ctx: AdapterContext): Promise<Pulled> {
	const agents = agentsFor(ctx.config, "x", [PLAIN_UA]);
	const load = async (status: string) => (await getJson<{ tweet?: FxTweet; message?: string }>(`${API}${status}`, { signal: ctx.signal, fetcher: ctx.fetcher, agents, accept: (r) => r.status !== 429 && r.status < 500 })).tweet;
	const tweet = await load(id);
	if (!tweet) throw new Error("FxTwitter found no post with that id. It may be deleted, private, or age-restricted.");
	const parents: Post[] = [];
	let parentId = ctx.options.comments > 0 ? tweet.replying_to_status : undefined;
	while (parentId && parents.length < MAX_PARENTS) {
		const parent = await load(parentId).catch(() => undefined);
		if (!parent) break;
		parents.unshift(tweetPost(parent));
		parentId = parent.replying_to_status;
	}
	const post = tweetPost(tweet);
	const video = (tweet.media?.all ?? tweet.media?.videos ?? []).find((item) => item.type === "video");
	return {
		platform: "x",
		title: `${post.author} on X`,
		url: tweet.url ?? `https://x.com/i/status/${id}`,
		markdown: renderThread(parents, post, [], "Replies are not available without an X login; only the parent chain is shown."),
		photos: [...photoUrls(tweet), ...(tweet.quote ? photoUrls(tweet.quote) : [])],
		// The direct MP4: yt-dlp's X extractor needs a login more often than the file does.
		videoUrl: video ? videoFile(video) : undefined,
	};
}
