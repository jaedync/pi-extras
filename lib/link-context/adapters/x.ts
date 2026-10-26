/**
 * X/Twitter through the public FxTwitter API: no login, no key. The v2 API
 * gives the whole conversation (x-conversation.ts): the posts above, nested
 * replies, the posts that quote it and the chain of quoted posts. When v2
 * fails, the v1 API gives the post with its quote, and the chain of parents
 * walked one `replying_to_status` at a time.
 */
import { agentsFor } from "../config.ts";
import { getJson, PLAIN_UA } from "../http.ts";
import { previewConversation, renderConversation, renderThread, type Conversation, type Post } from "../post.ts";
import { threadSummary } from "../summary.ts";
import { isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";
import { Calls, collectQuoteChain, collectQuoteReplies, collectQuotes, collectReplies, orderReplies, parentChain, readConversation, X_LIMITS, type QuoteLevel, type ReplyTree, type XLimits, type XThread } from "./x-conversation.ts";

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
	id?: string;
	url?: string;
	text?: string;
	author?: { name?: string; screen_name?: string };
	created_timestamp?: number;
	created_at?: string;
	likes?: number;
	retweets?: number;
	reposts?: number;
	replies?: number;
	quotes?: number;
	views?: number | null;
	media?: { all?: FxMedia[]; photos?: FxMedia[]; videos?: FxMedia[]; external?: FxMedia };
	quote?: FxTweet;
	poll?: { choices?: { label?: string; percentage?: number }[]; total_votes?: number; time_left_en?: string };
	article?: { title?: string; preview_text?: string };
	community_note?: { text?: string } | null;
	replying_to_status?: string | null;
	replying_to?: { status?: string } | null;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const obj = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const list = <T>(value: unknown, item: (entry: unknown) => T | undefined): T[] => (Array.isArray(value) ? value.map(item).filter((entry): entry is T => entry !== undefined) : []);

function cleanMedia(value: unknown): FxMedia | undefined {
	const m = obj(value);
	if (!m) return undefined;
	const variants = list(m.variants, (entry) => {
		const v = obj(entry);
		return v ? { url: str(v.url), bitrate: num(v.bitrate), content_type: str(v.content_type) } : undefined;
	});
	return { type: str(m.type), url: str(m.url), thumbnail_url: str(m.thumbnail_url), duration: num(m.duration), altText: str(m.altText), variants };
}

/** A quote with no id, text or author is noise from a malformed answer, not a post. */
const worthShowing = (tweet: FxTweet | undefined): FxTweet | undefined => (tweet && (tweet.id || tweet.text || tweet.author) ? tweet : undefined);

/**
 * The fields this adapter reads, each checked for its type: the API is a
 * third party, and one odd field must not stop the whole conversation.
 */
export function cleanTweet(value: unknown, depth = 0): FxTweet | undefined {
	const t = obj(value);
	if (!t) return undefined;
	const author = obj(t.author);
	const media = obj(t.media);
	const poll = obj(t.poll);
	const article = obj(t.article);
	const note = obj(t.community_note);
	const replyingTo = obj(t.replying_to);
	return {
		id: str(t.id),
		url: str(t.url),
		text: str(t.text),
		author: author ? { name: str(author.name), screen_name: str(author.screen_name) } : undefined,
		created_timestamp: num(t.created_timestamp),
		created_at: str(t.created_at),
		likes: num(t.likes),
		retweets: num(t.retweets) ?? num(t.reposts),
		replies: num(t.replies),
		quotes: num(t.quotes),
		views: num(t.views),
		media: media ? { all: Array.isArray(media.all) ? list(media.all, cleanMedia) : undefined, photos: list(media.photos, cleanMedia), videos: list(media.videos, cleanMedia), external: cleanMedia(media.external) } : undefined,
		// Two levels are enough for what a quote carries; the chain itself is read level by level.
		quote: depth < 2 ? worthShowing(cleanTweet(t.quote, depth + 1)) : undefined,
		poll: poll ? { choices: list(poll.choices, (entry) => { const c = obj(entry); return c ? { label: str(c.label), percentage: num(c.percentage) } : undefined; }), total_votes: num(poll.total_votes), time_left_en: str(poll.time_left_en) } : undefined,
		article: article ? { title: str(article.title), preview_text: str(article.preview_text) } : undefined,
		community_note: note ? { text: str(note.text) } : undefined,
		replying_to_status: str(t.replying_to_status),
		replying_to: replyingTo ? { status: str(replyingTo.status) } : undefined,
	};
}

const mediaItems = (tweet: FxTweet): FxMedia[] => tweet.media?.all ?? [...(tweet.media?.photos ?? []), ...(tweet.media?.videos ?? [])];

function media(tweet: FxTweet): string[] {
	const items = mediaItems(tweet);
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
	return mediaItems(tweet).map((item) => (item.type === "photo" ? item.url : item.thumbnail_url)).filter((url): url is string => !!url);
}

/** The chain of quoted posts as nested posts; the deepest level keeps the shallow quote it carried. */
function quotedPost(chain: readonly QuoteLevel[]): Post | undefined {
	return chain.reduceRight<Post | undefined>((inner, level) => {
		const tweet = cleanTweet(level.tweet) ?? {};
		const base = tweetPost(tweet);
		return { ...base, parents: level.parents.map((parent) => tweetPost(cleanTweet(parent) ?? {})), quoted: inner ?? base.quoted };
	}, undefined);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What the conversation lacks, in words, so a reader does not take a part for the whole. */
function gaps(status: FxTweet, tree: ReplyTree | undefined, shown: number, quotes: number | undefined, quoteUnread: number, calls: Calls, limits: XLimits): string[] {
	const notes: string[] = [];
	if (tree) {
		const reported = status.replies ?? 0;
		const direct = [...tree.nodes.values()].filter((node) => node.parent === status.id).length;
		if (reported > direct) notes.push(`X reports ${plural(reported, "reply", "replies")} to this post; ${plural(direct, "direct reply", "direct replies")} and ${plural(tree.nodes.size - direct, "nested reply", "nested replies")} came back. Without a login, X shows only the top replies.`);
		if (tree.nodes.size > shown) notes.push(`${plural(tree.nodes.size - shown, "more reply", "more replies")} came back than the comments limit shows.`);
		if (tree.unread) notes.push(`The replies to ${plural(tree.unread, "reply", "replies")} were not read.`);
	}
	if (quotes !== undefined && (status.quotes ?? 0) > quotes) notes.push(`X reports ${plural(status.quotes ?? 0, "quote post")}; ${quotes.toLocaleString("en-US")} came back.`);
	if (quoteUnread) notes.push(`The replies to ${plural(quoteUnread, "quote post")} were not read.`);
	if (calls.failed) notes.push(`${plural(calls.failed, "FxTwitter request")} failed.`);
	if (calls.stop.reason) notes.push(`Reading stopped at the ${calls.stop.reason === "requests" ? `limit of ${limits.requests} requests` : `time limit of ${limits.ms / 1000} s`}; the counts above say what is missing.`);
	return notes;
}

async function pullWhole(first: XThread, calls: Calls, ctx: AdapterContext, limits: XLimits): Promise<Pulled> {
	const comments = ctx.options.comments;
	const wanted = ctx.options.quotes ?? 0;
	const status = cleanTweet(first.status) ?? {};
	const [tree, quoting, chain] = await Promise.all([
		comments > 0 ? collectReplies(calls, first, comments, ctx.progress) : undefined,
		wanted > 0 && (status.quotes ?? 0) > 0 ? collectQuotes(calls, first.status.id, wanted, limits.quotePages, status.quotes) : undefined,
		collectQuoteChain(calls, first.status, limits),
	]);
	// Replies to the quote posts come after the post's own replies, so those get the requests first.
	const quoteReplies = quoting && comments > 0 ? await collectQuoteReplies(calls, quoting, comments, ctx.progress) : undefined;
	const ordered = tree ? orderReplies(tree, first.status, comments) : [];
	const replies = ordered.map(({ tweet, depth }) => ({ post: tweetPost(cleanTweet(tweet) ?? {}), depth }));
	const base = tweetPost(status);
	const post: Post = { ...base, quoted: quotedPost(chain) ?? base.quoted };
	const parents = comments > 0 ? parentChain(first.thread, first.status, limits.parents).map((tweet) => tweetPost(cleanTweet(tweet) ?? {})) : [];
	const notes = gaps(status, tree, replies.length, quoting?.length, quoteReplies?.unread ?? 0, calls, limits);
	if (comments > 0 && (status.replying_to?.status || status.replying_to_status) && !parents.length) notes.push("The posts above this one could not be read.");
	const quotes = (quoting ?? []).flatMap((quote) => {
		const tree = quoteReplies?.trees.get(quote.id);
		const below = tree ? orderReplies(tree, quote, comments).map(({ tweet, depth }) => ({ post: tweetPost(cleanTweet(tweet) ?? {}), depth: depth + 1 })) : [];
		return [{ post: tweetPost(cleanTweet(quote) ?? {}), depth: 0 }, ...below];
	});
	const conversation: Conversation = { parents, post, replies, quotes, quotesTotal: status.quotes, notes };
	const video = mediaItems(status).find((item) => item.type === "video");
	const quoted = chain[0] ? cleanTweet(chain[0].tweet) : status.quote;
	return {
		platform: "x",
		title: `${post.author} on X`,
		url: status.url ?? `https://x.com/i/status/${first.status.id}`,
		markdown: renderConversation(conversation),
		preview: previewConversation(conversation),
		summary: threadSummary(post, replies, status.replies),
		photos: [...photoUrls(status), ...(quoted ? photoUrls(quoted) : [])],
		videoUrl: video ? videoFile(video) : undefined,
		// Only auto-pull sets `readMs`; its reader keeps such a result apart, so a pull_link call reads the rest.
		...(ctx.options.readMs !== undefined && calls.stop.reason === "time" ? { timeLimited: true } : {}),
	};
}

/** The v1 API: the post with its quote, and its parents one request each. */
async function pullSingle(id: string, ctx: AdapterContext, note?: string): Promise<Pulled> {
	const agents = agentsFor(ctx.config, "x", [PLAIN_UA]);
	const load = async (status: string) => cleanTweet((await getJson<{ tweet?: unknown }>(`${API}${status}`, { signal: ctx.signal, fetcher: ctx.fetcher, agents, accept: (r) => r.status !== 429 && r.status < 500 })).tweet);
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
	const video = mediaItems(tweet).find((item) => item.type === "video");
	return {
		platform: "x",
		title: `${post.author} on X`,
		url: tweet.url ?? `https://x.com/i/status/${id}`,
		markdown: renderThread(parents, post, [], note),
		summary: threadSummary(post, []),
		photos: [...photoUrls(tweet), ...(tweet.quote ? photoUrls(tweet.quote) : [])],
		// The direct MP4: yt-dlp's X extractor needs a login more often than the file does.
		videoUrl: video ? videoFile(video) : undefined,
	};
}

export async function pullX(id: string, ctx: AdapterContext, limits: XLimits = X_LIMITS): Promise<Pulled> {
	if (ctx.options.comments <= 0 && (ctx.options.quotes ?? 0) <= 0) return pullSingle(id, ctx);
	const used = ctx.options.readMs !== undefined ? { ...limits, ms: Math.min(limits.ms, ctx.options.readMs) } : limits;
	const calls = new Calls(ctx, used);
	let failure = "FxTwitter gave no post";
	let first: XThread | undefined;
	// Only the first call falls back to v1; an error after it is a bug and must show as one.
	try {
		first = await readConversation(calls, id, undefined, true);
	} catch (error) {
		ctx.signal?.throwIfAborted();
		failure = (error as Error).message;
	}
	if (first) return pullWhole(first, calls, ctx, used);
	return pullSingle(id, ctx, `Replies and quote posts could not be read (${failure}); only the posts above are shown.`);
}
