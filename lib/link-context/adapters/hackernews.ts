/** Hacker News through the Algolia items API: the item and its whole comment tree in one call. */
import { agentsFor } from "../config.ts";
import { getJson, PLAIN_UA } from "../http.ts";
import { renderThread, type Reply } from "../post.ts";
import { htmlToText, isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

export interface HnItem {
	id?: number;
	type?: string;
	author?: string | null;
	title?: string | null;
	url?: string | null;
	text?: string | null;
	points?: number | null;
	created_at?: string;
	children?: HnItem[];
}

function countAll(items: readonly HnItem[] | undefined): number {
	return (items ?? []).reduce((sum, item) => sum + 1 + countAll(item.children), 0);
}

export function hnReplies(items: readonly HnItem[] | undefined, limit: number, depth = 0, out: Reply[] = []): Reply[] {
	for (const item of items ?? []) {
		if (out.length >= limit) break;
		if (!item.text && !item.author) continue;
		out.push({ post: { author: item.author ?? "[deleted]", date: isoDate(item.created_at), text: htmlToText(item.text ?? "") }, depth });
		hnReplies(item.children, limit, depth + 1, out);
	}
	return out;
}

export async function pullHackerNews(id: string, ctx: AdapterContext): Promise<Pulled> {
	const item = await getJson<HnItem>(`https://hn.algolia.com/api/v1/items/${id}`, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "hackernews", [PLAIN_UA]) });
	const link = `https://news.ycombinator.com/item?id=${id}`;
	const head = item.title ? `# ${item.title}${item.url ? `\n${item.url}` : ""}` : "";
	const body = htmlToText(item.text ?? "");
	const post = { author: item.author ?? "[deleted]", date: isoDate(item.created_at), url: link, text: [head, body].filter(Boolean).join("\n\n"), stats: stats([["points", item.points]]) };
	const replies = ctx.options.comments > 0 ? hnReplies(item.children, ctx.options.comments) : [];
	return { platform: "hackernews", title: item.title ?? `HN comment by ${item.author}`, url: link, markdown: renderThread([], post, replies, undefined, countAll(item.children)) };
}
