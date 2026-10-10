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
	const lines = [byline(post)];
	if (post.url) lines.push(post.url);
	lines.push("", post.text.trim() || "(no text)");
	if (post.media?.length) lines.push("", ...post.media.map((item) => `- ${item}`));
	if (post.quoted) lines.push("", "Quoted post:", quote(renderPost(post.quoted)));
	return lines.join("\n");
}

export function renderReplies(replies: readonly Reply[], total?: number): string {
	if (!replies.length) return "";
	const heading = total !== undefined && total > replies.length ? `## Replies (${replies.length} of ${total})` : `## Replies (${replies.length})`;
	const body = replies.map(({ post, depth }) => {
		const pad = "  ".repeat(Math.max(0, depth));
		const text = post.text.trim().split("\n").map((line) => `${pad}  ${line}`).join("\n");
		const media = post.media?.length ? `\n${post.media.map((item) => `${pad}  [${item}]`).join("\n")}` : "";
		return `${pad}- ${byline(post)}\n${text}${media}`;
	});
	return `${heading}\n\n${body.join("\n")}`;
}

/** The page for one post: parents first for context, the post, then replies. */
export function renderThread(parents: readonly Post[], post: Post, replies: readonly Reply[], note?: string, total?: number): string {
	const parts: string[] = [];
	if (parents.length) parts.push(`## Earlier in the thread\n\n${parents.map(renderPost).join("\n\n---\n\n")}`, "## Post");
	parts.push(renderPost(post));
	const rendered = renderReplies(replies, total);
	if (rendered) parts.push(rendered);
	if (note) parts.push(`_${note}_`);
	return parts.join("\n\n");
}
