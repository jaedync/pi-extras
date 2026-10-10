/**
 * Mastodon and compatible servers (any host with `/@user/<id>`): the public
 * status and context APIs. A server that requires sign-in for its API, or a
 * host that is not Mastodon at all, falls back to the web adapter.
 */
import { agentsFor } from "../config.ts";
import { getJson, PLAIN_UA } from "../http.ts";
import { renderThread, type Post, type Reply } from "../post.ts";
import { htmlToText, isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

export interface Status {
	id?: string;
	url?: string;
	content?: string;
	spoiler_text?: string;
	created_at?: string;
	in_reply_to_id?: string | null;
	account?: { display_name?: string; acct?: string };
	media_attachments?: { type?: string; url?: string; preview_url?: string; description?: string | null }[];
	card?: { url?: string; title?: string } | null;
	favourites_count?: number;
	reblogs_count?: number;
	replies_count?: number;
	reblog?: Status | null;
	quote?: { quoted_status?: Status | null } | Status | null;
}

export function statusPost(status: Status): Post & { images: string[] } {
	const source = status.reblog ?? status;
	const quoted = source.quote && "quoted_status" in source.quote ? source.quote.quoted_status : (source.quote as Status | null | undefined);
	const media = (source.media_attachments ?? []).map((item) => `${item.type ?? "file"}: ${item.url ?? item.preview_url}${item.description ? ` alt: ${item.description}` : ""}`);
	if (source.card?.url) media.push(`link: ${source.card.title ? `${source.card.title} ` : ""}${source.card.url}`);
	const body = htmlToText(source.content ?? "");
	return {
		author: source.account?.display_name || source.account?.acct || "unknown",
		handle: source.account?.acct,
		date: isoDate(source.created_at),
		url: source.url,
		text: source.spoiler_text ? `CW: ${source.spoiler_text}\n\n${body}` : body,
		stats: stats([["favourites", source.favourites_count], ["boosts", source.reblogs_count], ["replies", source.replies_count]]),
		media,
		quoted: quoted?.content !== undefined ? statusPost(quoted) : undefined,
		images: (source.media_attachments ?? []).filter((item) => item.type === "image").map((item) => item.url ?? item.preview_url).filter((url): url is string => !!url),
	};
}

/** Descendants arrive flat in thread order; depth comes from following `in_reply_to_id`. */
export function nestReplies(rootId: string, descendants: readonly Status[], limit: number): Reply[] {
	const depth = new Map<string, number>([[rootId, -1]]);
	const out: Reply[] = [];
	for (const status of descendants) {
		const level = (depth.get(status.in_reply_to_id ?? "") ?? -1) + 1;
		if (status.id) depth.set(status.id, level);
		if (out.length < limit) out.push({ post: statusPost(status), depth: level });
	}
	return out;
}

export async function pullMastodon(origin: string, id: string, ctx: AdapterContext): Promise<Pulled> {
	const options = { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "mastodon", [PLAIN_UA]) };
	const status = await getJson<Status>(`${origin}/api/v1/statuses/${id}`, options);
	if (!status.account || status.content === undefined) throw new Error("Not a Mastodon status");
	const context = ctx.options.comments > 0
		? await getJson<{ ancestors?: Status[]; descendants?: Status[] }>(`${origin}/api/v1/statuses/${id}/context`, options).catch(() => ({ ancestors: [], descendants: [] }))
		: { ancestors: [], descendants: [] };
	const post = statusPost(status);
	const parents = (context.ancestors ?? []).map(statusPost);
	const replies = nestReplies(id, context.descendants ?? [], ctx.options.comments);
	return {
		platform: "mastodon",
		title: `${post.author} on ${new URL(origin).hostname}`,
		url: post.url ?? `${origin}/statuses/${id}`,
		markdown: renderThread(parents, post, replies, undefined, context.descendants?.length),
		photos: post.images,
		videoUrl: (status.reblog ?? status).media_attachments?.find((item) => item.type === "video" || item.type === "gifv")?.url,
	};
}
