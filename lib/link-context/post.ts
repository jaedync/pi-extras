/**
 * One markdown shape for every social post, so a tweet, a skeet, a toot and a
 * Reddit comment read the same way: who, when, the text, media, the quoted
 * post, then replies as an indented outline.
 */
import { quote } from "./text.ts";

export interface Post {
	readonly author: string;
	readonly handle?: string;
	readonly date?: string;
	readonly url?: string;
	readonly text: string;
	readonly stats?: string;
	/** One line per attachment, already in words: `photo: <url>`. */
	readonly media?: readonly string[];
	readonly quoted?: Post;
	/** The posts above a quoted post, oldest first, so a quote of a reply keeps its context. */
	readonly parents?: readonly Post[];
}

export interface Reply {
	readonly post: Post;
	readonly depth: number;
}

function byline(post: Post): string {
	const who = post.handle && post.handle !== post.author ? `**${post.author}** (@${post.handle.replace(/^@/, "")})` : `**${post.author}**`;
	return [who, post.date, post.stats].filter(Boolean).join(" · ");
}

export function renderPost(post: Post): string {
	const lines = post.parents?.length ? ["In reply to:", quote(post.parents.map(renderPost).join("\n\n---\n\n")), "", byline(post)] : [byline(post)];
	if (post.url) lines.push(post.url);
	lines.push("", post.text.trim() || "(no text)");
	if (post.media?.length) lines.push("", ...post.media.map((item) => `- ${item}`));
	if (post.quoted) lines.push("", "Quoted post:", quote(renderPost(post.quoted)));
	return lines.join("\n");
}

/** An outline under a heading; `top` counts only the items at depth 0 (quote posts, not their replies). */
function renderList(title: string, replies: readonly Reply[], total?: number, top = false): string {
	if (!replies.length) return "";
	const shown = top ? replies.filter((reply) => reply.depth === 0).length : replies.length;
	const heading = total !== undefined && total > shown ? `## ${title} (${shown} of ${total})` : `## ${title} (${shown})`;
	const body = replies.map(({ post, depth }) => {
		const pad = "  ".repeat(Math.max(0, depth));
		const text = post.text.trim().split("\n").map((line) => `${pad}  ${line}`).join("\n");
		const media = post.media?.length ? `\n${post.media.map((item) => `${pad}  [${item}]`).join("\n")}` : "";
		return `${pad}- ${byline(post)}\n${text}${media}`;
	});
	return `${heading}\n\n${body.join("\n")}`;
}

export function renderReplies(replies: readonly Reply[], total?: number): string {
	return renderList("Replies", replies, total);
}

/** A whole conversation: the posts above, the post, its replies as an outline, then the posts that quote it. */
export interface Conversation {
	readonly parents: readonly Post[];
	readonly post: Post;
	readonly replies: readonly Reply[];
	readonly repliesTotal?: number;
	/** Posts that quote the post at depth 0, each without the post itself as its quote, and their replies below them. */
	readonly quotes?: readonly Reply[];
	readonly quotesTotal?: number;
	/** What could not be read, in words. */
	readonly notes?: readonly string[];
}

export function renderConversation(c: Conversation): string {
	const parts: string[] = [];
	if (c.parents.length) parts.push(`## Earlier in the thread\n\n${c.parents.map(renderPost).join("\n\n---\n\n")}`, "## Post");
	parts.push(renderPost(c.post));
	const replies = renderReplies(c.replies, c.repliesTotal);
	if (replies) parts.push(replies);
	const quotes = renderList("Quote posts", c.quotes ?? [], c.quotesTotal, true);
	if (quotes) parts.push(quotes);
	for (const note of c.notes ?? []) parts.push(`_${note}_`);
	return parts.join("\n\n");
}

/** Parents, replies and quotes a preview starts from; it shows fewer when they do not fit. */
export const PREVIEW_PARENTS = 3;
export const PREVIEW_REPLIES = 20;
export const PREVIEW_QUOTES = 10;
export const PREVIEW_CHARS = 11_000;

function previewAt(c: Conversation, replies: number, quotes: number): string {
	const parents = c.parents.slice(-PREVIEW_PARENTS);
	const top = (c.quotes ?? []).filter((quote) => quote.depth === 0);
	const cut = c.parents.length - parents.length;
	return renderConversation({
		...c,
		parents,
		replies: c.replies.slice(0, replies),
		repliesTotal: c.replies.length,
		quotes: top.slice(0, quotes),
		quotesTotal: top.length,
		notes: [...(cut > 0 ? [`${cut} earlier ${cut === 1 ? "post" : "posts"} in the thread are in the full result.`] : []), ...(c.notes ?? [])],
	});
}

/**
 * The parts of a long conversation that a reader needs first: the nearest
 * parents, the post with its quotes, the top replies and the top quote posts
 * (without their replies), each list headed with the count it was cut from.
 * The lists get shorter until the preview fits in `max` characters, so the
 * notes at its end are not cut off.
 */
export function previewConversation(c: Conversation, max = PREVIEW_CHARS): string {
	let replies = PREVIEW_REPLIES;
	let quotes = PREVIEW_QUOTES;
	let text = previewAt(c, replies, quotes);
	while (text.length > max && (replies > 0 || quotes > 0)) {
		// Replies go first, two for each quote post: a quote is a whole take, a reply often one line.
		if (replies > 2 * quotes) replies--;
		else if (quotes > 0) quotes--;
		else replies--;
		text = previewAt(c, replies, quotes);
	}
	return text;
}

/** The page for one post: parents first for context, the post, then replies. */
export function renderThread(parents: readonly Post[], post: Post, replies: readonly Reply[], note?: string, total?: number): string {
	return renderConversation({ parents, post, replies, repliesTotal: total, notes: note ? [note] : [] });
}
