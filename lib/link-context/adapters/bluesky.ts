/**
 * Bluesky through the public AppView: `getPostThread` takes a handle or DID in
 * the AT URI and returns parents and the reply tree in one call, no login.
 */
import { agentsFor } from "../config.ts";
import { getJson, PLAIN_UA } from "../http.ts";
import { renderThread, type Post, type Reply } from "../post.ts";
import { isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const API = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread";
const MAX_PARENTS = 10;

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

export async function pullBluesky(actor: string, rkey: string, ctx: AdapterContext): Promise<Pulled> {
	const params = new URLSearchParams({ uri: `at://${actor}/app.bsky.feed.post/${rkey}`, depth: ctx.options.comments > 0 ? "6" : "0", parentHeight: String(MAX_PARENTS) });
	const data = await getJson<{ thread?: ThreadNode }>(`${API}?${params}`, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "bluesky", [PLAIN_UA]), accept: (r) => r.status === 200 || r.status === 400 });
	const thread = data.thread;
	if (!thread?.post) throw new Error("Bluesky found no post at that link. It may be deleted or the account may be private to logged-in users.");
	const parents: Post[] = [];
	for (let node = thread.parent; node?.post && parents.length < MAX_PARENTS; node = node.parent) parents.unshift(bskyPost(node.post));
	const post = bskyPost(thread.post);
	const replies = flattenReplies(thread.replies, ctx.options.comments);
	return {
		platform: "bluesky",
		title: `${post.author} on Bluesky`,
		url: post.url ?? `https://bsky.app/profile/${actor}/post/${rkey}`,
		markdown: renderThread(parents, post, replies, undefined, thread.post.replyCount),
		photos: post.images,
		videoUrl: post.videoUrl,
	};
}
