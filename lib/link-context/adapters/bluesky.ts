/**
 * Bluesky through the public AppView, no login: `getPostThread` takes a handle
 * or DID in the AT URI and returns parents and the whole reply tree in one
 * call; `getQuotes` pages through the posts that quote it, and the most liked
 * of those get their own reply trees.
 */
import { agentsFor } from "../config.ts";
import { getJson, PLAIN_UA } from "../http.ts";
import { previewConversation, renderConversation, type Conversation, type Post, type Reply } from "../post.ts";
import { threadSummary } from "../summary.ts";
import { isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const XRPC = "https://public.api.bsky.app/xrpc/";
const MAX_PARENTS = 100;
/** The AppView's largest depth. A tree too large to read falls back to its default depth. */
const FULL_DEPTH = 1000;
const FALLBACK_DEPTH = 6;
const QUOTE_PAGE = 100;
const MAX_QUOTE_PAGES = 10;
/** Quote posts whose replies are read, most liked first, and how many at once. */
const QUOTE_THREADS = 50;
const QUOTE_PARALLEL = 4;

interface Author { handle?: string; displayName?: string }
interface Embed {
	$type?: string;
	images?: { fullsize?: string; thumb?: string; alt?: string }[];
	external?: { uri?: string; title?: string; description?: string };
	record?: { $type?: string; uri?: string; author?: Author; value?: { text?: string; createdAt?: string }; record?: Embed["record"] };
	media?: Embed;
	playlist?: string;
	thumbnail?: string;
}
interface Facet { index?: { byteStart?: number; byteEnd?: number }; features?: { $type?: string; uri?: string }[] }
export interface BskyPost {
	uri?: string;
	author?: Author;
	record?: { text?: string; createdAt?: string; facets?: Facet[] };
	embed?: Embed;
	likeCount?: number;
	repostCount?: number;
	replyCount?: number;
	quoteCount?: number;
}
export interface ThreadNode { $type?: string; post?: BskyPost; parent?: ThreadNode; replies?: ThreadNode[] }

/** `at://did/app.bsky.feed.post/rkey` to the web URL people share. */
export function webUrl(uri: string | undefined, handle: string | undefined): string | undefined {
	const match = uri ? /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri) : null;
	return match ? `https://bsky.app/profile/${handle ?? match[1]}/post/${match[2]}` : undefined;
}

/**
 * Bluesky shortens link text in the post ("example.com/a-long-pa...") and
 * keeps the full URL in a facet, addressed by UTF-8 byte offsets.
 */
export function expandLinks(text: string, facets: readonly Facet[] | undefined): string {
	const links = (facets ?? [])
		.map((facet) => ({ start: facet.index?.byteStart ?? -1, end: facet.index?.byteEnd ?? -1, uri: facet.features?.find((f) => f.$type === "app.bsky.richtext.facet#link")?.uri }))
		.filter((link): link is { start: number; end: number; uri: string } => !!link.uri && link.start >= 0 && link.end > link.start)
		.sort((a, b) => a.start - b.start);
	if (!links.length) return text;
	const bytes = Buffer.from(text, "utf8");
	const parts: string[] = [];
	let at = 0;
	for (const link of links) {
		if (link.start < at || link.end > bytes.length) continue;
		parts.push(bytes.subarray(at, link.start).toString("utf8"));
		const shown = bytes.subarray(link.start, link.end).toString("utf8");
		const stem = shown.replace(/(?:\.{3}|…)$/, "");
		const shortened = /[./]/.test(stem) && link.uri.replace(/^https?:\/\/(?:www\.)?/, "").startsWith(stem.replace(/^(?:www\.)/, ""));
		parts.push(shortened ? link.uri : `[${shown}](${link.uri})`);
		at = link.end;
	}
	parts.push(bytes.subarray(at).toString("utf8"));
	return parts.join("");
}

function embedLines(embed: Embed | undefined): { lines: string[]; quoted?: Post; images: string[] } {
	if (!embed) return { lines: [], images: [] };
	const images = (embed.images ?? []).map((image) => image.fullsize ?? image.thumb).filter((url): url is string => !!url);
	const lines = (embed.images ?? []).map((image) => `photo: ${image.fullsize ?? image.thumb}${image.alt ? ` alt: ${image.alt}` : ""}`);
	if (embed.external?.uri) lines.push(`link: ${embed.external.title ? `${embed.external.title} ` : ""}${embed.external.uri}${embed.external.description ? ` (${embed.external.description})` : ""}`);
	if (embed.playlist) lines.push(`video: ${embed.playlist}`);
	if (embed.thumbnail) images.push(embed.thumbnail);
	let quoted: Post | undefined;
	const record = embed.record?.record ?? embed.record;
	if (record?.value || record?.author) {
		quoted = { author: record.author?.displayName || record.author?.handle || "unknown", handle: record.author?.handle, date: isoDate(record.value?.createdAt), url: webUrl(record.uri, record.author?.handle), text: record.value?.text ?? "" };
	}
	if (embed.media) {
		const inner = embedLines(embed.media);
		lines.push(...inner.lines);
		images.push(...inner.images);
	}
	return { lines, quoted, images };
}

export function bskyPost(post: BskyPost): Post & { images: string[]; videoUrl?: string } {
	const embed = embedLines(post.embed);
	return {
		author: post.author?.displayName || post.author?.handle || "unknown",
		handle: post.author?.handle,
		date: isoDate(post.record?.createdAt),
		url: webUrl(post.uri, post.author?.handle),
		text: expandLinks(post.record?.text ?? "", post.record?.facets),
		stats: stats([["likes", post.likeCount], ["reposts", post.repostCount], ["replies", post.replyCount], ["quotes", post.quoteCount]]),
		media: embed.lines,
		quoted: embed.quoted,
		images: embed.images,
		videoUrl: post.embed?.playlist ?? post.embed?.media?.playlist,
	};
}

/** Depth-first, highest-liked first, until `limit` replies are taken. */
export function flattenReplies(nodes: readonly ThreadNode[] | undefined, limit: number, depth = 0, out: Reply[] = []): Reply[] {
	const sorted = [...(nodes ?? [])].filter((node) => node.post).sort((a, b) => (b.post?.likeCount ?? 0) - (a.post?.likeCount ?? 0));
	for (const node of sorted) {
		if (out.length >= limit) break;
		out.push({ post: bskyPost(node.post as BskyPost), depth });
		flattenReplies(node.replies, limit, depth + 1, out);
	}
	return out;
}

const agents = (ctx: AdapterContext) => agentsFor(ctx.config, "bluesky", [PLAIN_UA]);

async function readThread(uri: string, depth: number, parents: number, ctx: AdapterContext): Promise<ThreadNode | undefined> {
	const params = new URLSearchParams({ uri, depth: String(depth), parentHeight: String(parents) });
	const data = await getJson<{ thread?: ThreadNode }>(`${XRPC}app.bsky.feed.getPostThread?${params}`, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agents(ctx), accept: (r) => r.status === 200 || r.status === 400 });
	return data?.thread?.post ? data.thread : undefined;
}

/** The posts that quote `uri`, page by page, most liked first. A failed page ends the list and is reported. */
async function readQuotes(uri: string, limit: number, ctx: AdapterContext): Promise<{ posts: BskyPost[]; failed: boolean }> {
	const posts = new Map<string, BskyPost>();
	let cursor: string | undefined;
	try {
		for (let page = 0; page < MAX_QUOTE_PAGES && posts.size < limit; page++) {
			const params = new URLSearchParams({ uri, limit: String(QUOTE_PAGE), ...(cursor ? { cursor } : {}) });
			const data = await getJson<{ posts?: unknown; cursor?: unknown }>(`${XRPC}app.bsky.feed.getQuotes?${params}`, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agents(ctx) });
			const fresh = (Array.isArray(data?.posts) ? data.posts : []).filter((post): post is BskyPost => !!post && typeof post === "object" && typeof (post as BskyPost).uri === "string" && !posts.has((post as BskyPost).uri!));
			if (!fresh.length) break;
			for (const post of fresh) posts.set(post.uri!, post);
			if (typeof data.cursor !== "string" || !data.cursor || data.cursor === cursor) break;
			cursor = data.cursor;
		}
	} catch (error) {
		ctx.signal?.throwIfAborted();
		return { posts: rank([...posts.values()]).slice(0, limit), failed: true };
	}
	return { posts: rank([...posts.values()]).slice(0, limit), failed: false };
}

const rank = (posts: BskyPost[]) => posts.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));

/** Each quote post with its own replies below it, without its quote of the post itself. */
async function quoteThreads(quotes: readonly BskyPost[], focalUrl: string | undefined, limit: number, ctx: AdapterContext): Promise<{ items: Reply[]; unread: number }> {
	const wanted = quotes.filter((post) => (post.replyCount ?? 0) > 0).slice(0, QUOTE_THREADS);
	const trees = new Map<string, ThreadNode>();
	let unread = quotes.filter((post) => (post.replyCount ?? 0) > 0).length - wanted.length;
	for (let start = 0; start < wanted.length; start += QUOTE_PARALLEL) {
		await Promise.all(wanted.slice(start, start + QUOTE_PARALLEL).map(async (post) => {
			const tree = await readThread(post.uri!, FULL_DEPTH, 0, ctx).catch(() => {
				ctx.signal?.throwIfAborted();
				return undefined;
			});
			if (tree) trees.set(post.uri!, tree);
			else unread++;
		}));
	}
	const items = quotes.flatMap((quote) => {
		const shown = bskyPost(quote);
		const own: Post = shown.quoted?.url && shown.quoted.url === focalUrl ? { ...shown, quoted: undefined } : shown;
		const below = flattenReplies(trees.get(quote.uri!)?.replies, limit).map((reply) => ({ ...reply, depth: reply.depth + 1 }));
		return [{ post: own, depth: 0 }, ...below];
	});
	return { items, unread };
}

export async function pullBluesky(actor: string, rkey: string, ctx: AdapterContext): Promise<Pulled> {
	const uri = `at://${actor}/app.bsky.feed.post/${rkey}`;
	const comments = ctx.options.comments;
	const notes: string[] = [];
	let thread: ThreadNode | undefined;
	try {
		thread = await readThread(uri, comments > 0 ? FULL_DEPTH : 0, MAX_PARENTS, ctx);
	} catch (error) {
		ctx.signal?.throwIfAborted();
		if (comments <= 0) throw error;
		// A whole tree can pass the size or time cap; the default depth still gives the top of it.
		thread = await readThread(uri, FALLBACK_DEPTH, MAX_PARENTS, ctx);
		notes.push(`The whole reply tree could not be read (${(error as Error).message}); replies up to ${FALLBACK_DEPTH} levels deep are shown.`);
	}
	if (!thread?.post) throw new Error("Bluesky found no post at that link. It may be deleted or the account may be private to logged-in users.");
	const parents: Post[] = [];
	for (let node = thread.parent; node?.post && parents.length < MAX_PARENTS; node = node.parent) parents.unshift(bskyPost(node.post));
	const post = bskyPost(thread.post);
	const replies = flattenReplies(thread.replies, comments);
	const direct = (thread.replies ?? []).filter((node) => node.post).length;
	if ((thread.post.replyCount ?? 0) > direct && comments > replies.length) notes.push(`Bluesky reports ${thread.post.replyCount} replies to this post; ${direct} came back. Replies that are deleted, blocked or hidden are not shown.`);
	const wanted = ctx.options.quotes ?? 0;
	let quotes: Reply[] = [];
	if (wanted > 0 && (thread.post.quoteCount ?? 0) > 0 && thread.post.uri) {
		const found = await readQuotes(thread.post.uri, wanted, ctx);
		if (found.failed) notes.push("Some quote posts could not be read.");
		const withReplies = await quoteThreads(found.posts, post.url, comments, ctx);
		quotes = withReplies.items;
		if (withReplies.unread) notes.push(`The replies to ${withReplies.unread} quote ${withReplies.unread === 1 ? "post were" : "posts were"} not read.`);
	}
	const conversation: Conversation = { parents, post, replies, repliesTotal: thread.post.replyCount, quotes, quotesTotal: thread.post.quoteCount, notes };
	return {
		platform: "bluesky",
		title: `${post.author} on Bluesky`,
		url: post.url ?? `https://bsky.app/profile/${actor}/post/${rkey}`,
		markdown: renderConversation(conversation),
		preview: previewConversation(conversation),
		summary: threadSummary(post, replies, thread.post.replyCount),
		photos: post.images,
		videoUrl: post.videoUrl,
	};
}
