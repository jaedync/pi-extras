/**
 * The few plain lines that say what a link is, for the transcript rows: who
 * wrote it and when, its first line, a first reply. Adapters give them as
 * `Pulled.summary`; a result without one gets the first prose lines of its
 * markdown. The model never sees these lines.
 */
import type { Post, Reply } from "./post.ts";

export const SUMMARY_LINES = 3;
const LINE_CHARS = 300;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
/** A reply's byline alone on its line, as renderReplies writes it: `name · 2007-04-04`. */
const BYLINE = /^(.+?) · \d{4}-\d{2}-\d{2}$/;

const day = (date: string | undefined) => date?.replace(/^(\d{4}-\d{2}-\d{2})T[\d:.]+Z$/, "$1");

/** One markdown line as words: no quote or list mark, links as their text, no emphasis, dates without the time. */
export function plainLine(line: string): string {
	const text = line.trim().replace(/^>\s*/, "").replace(/^[-*]\s+/, "").replace(LINK, "$1").replace(/\*\*|__|`/g, "")
		.replace(/(\d{4}-\d{2}-\d{2})T[\d:.]+Z/g, "$1").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
	return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text;
}

/** Most of the line is the markup of two or more links: a list of links or a notice box, not prose. */
function linkHeavy(line: string): boolean {
	const links = [...line.matchAll(LINK)];
	return links.length > 1 && links.reduce((sum, match) => sum + match[0].length, 0) > line.length / 2;
}

/**
 * The first `max` lines of prose in `markdown`: no headings, HTML, lines that
 * start with a link or are mostly links, or the title again. A reply's byline
 * joins the text after it, as `name: text`.
 */
export function proseLines(markdown: string, title: string, max: number): string[] {
	const out: string[] = [];
	let author = "";
	// The fence that opened the code block we are in; code is not prose.
	let fence = "";
	for (const raw of markdown.replace(/<\/?untrusted-content[^>]*>/g, "").split("\n")) {
		if (out.length >= max) break;
		const trimmed = raw.trim();
		const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker) fence = "";
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		if (!trimmed || trimmed.startsWith("#") || /^<\/?[a-z!]/i.test(trimmed) || /^https?:\/\//i.test(trimmed) || linkHeavy(trimmed)) continue;
		const line = plainLine(trimmed);
		// A line that is only `[edit]` or `[1]` is page furniture, not prose.
		if (!line || line === title || /^\[[^\]]*\]$/.test(line)) continue;
		const byline = /^[-*]\s/.test(trimmed) ? BYLINE.exec(line) : null;
		if (byline) {
			author = byline[1]!;
			continue;
		}
		out.push(author ? `${author}: ${line}` : line);
		author = "";
	}
	return out;
}

const replies = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "reply" : "replies"}`;

/** A post with its thread: who, when, stats and the reply count; the post's first line; the first reply. */
export function threadSummary(post: Post, thread: readonly Reply[], total?: number): string[] {
	const who = post.handle && post.handle.replace(/^@/, "") !== post.author ? `${post.author} (@${post.handle.replace(/^@/, "")})` : post.author;
	const count = total ?? thread.length;
	const head = plainLine([who, day(post.date), post.stats, count > 0 ? replies(count) : ""].filter(Boolean).join(" · "));
	const first = thread[0];
	const reply = first ? proseLines(first.post.text, "", 1)[0] : undefined;
	return [head, proseLines(post.text, "", 1)[0], reply ? plainLine(`${first!.post.author}: ${reply}`) : undefined]
		.filter((line): line is string => !!line).slice(0, SUMMARY_LINES);
}
