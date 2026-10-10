/**
 * Threads and LinkedIn have no public API. Their post pages still carry the
 * post for link previews: Threads in Open Graph tags, LinkedIn in a JSON-LD
 * `SocialMediaPosting` that also holds the top comments.
 */
import { agentsFor } from "../config.ts";
import { get, PLAIN_UA, PREVIEW_UA } from "../http.ts";
import { renderThread, type Post, type Reply } from "../post.ts";
import { decodeEntities, isoDate, jsonLd, metaTags, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

export function threadsFromHtml(html: string, url: string): Pulled {
	const meta = metaTags(html);
	const text = meta.get("og:description");
	if (!text) throw new Error("Threads did not include the post in the page. The post may be private or deleted.");
	// "Name (@handle) on Threads"
	const title = meta.get("og:title") ?? "";
	const named = /^(.*?)\s*\(@([\w.]+)\)/.exec(title);
	const image = meta.get("og:image");
	const isAvatar = !!image && /\/t51\.2885-19\//.test(image);
	const post: Post = { author: named?.[1] || title || "unknown", handle: named?.[2], url: meta.get("og:url") ?? url, text, media: image && !isAvatar ? [`image: ${image}`] : [] };
	return {
		platform: "threads",
		title: title || "Threads post",
		url: post.url ?? url,
		markdown: renderThread([], post, [], "Threads shows replies only to signed-in users; the post text comes from the page's preview tags."),
		photos: image && !isAvatar ? [image] : [],
	};
}

interface LdPerson { name?: string; url?: string }
interface LdStat { interactionType?: string; userInteractionCount?: number }
interface LdComment { text?: string; author?: LdPerson | LdPerson[]; datePublished?: string; interactionStatistic?: LdStat | LdStat[] }
interface LdPosting {
	"@type"?: string | string[];
	headline?: string;
	articleBody?: string;
	text?: string;
	datePublished?: string;
	author?: LdPerson | LdPerson[];
	image?: string | { url?: string } | (string | { url?: string })[];
	comment?: LdComment[];
	commentCount?: number;
	interactionStatistic?: LdStat | LdStat[];
	sharedContent?: { url?: string; headline?: string };
}

const first = <T>(value: T | T[] | undefined): T | undefined => (Array.isArray(value) ? value[0] : value);

function interactions(value: LdStat | LdStat[] | undefined): string {
	const list = Array.isArray(value) ? value : value ? [value] : [];
	return stats(list.map((item) => [(item.interactionType ?? "").replace(/^https?:\/\/schema\.org\//, "").replace(/Action$/, "").toLowerCase() + "s", item.userInteractionCount]));
}

function isPosting(block: unknown): block is LdPosting {
	const type = (block as LdPosting | undefined)?.["@type"];
	const types = Array.isArray(type) ? type : [type];
	return types.some((t) => t === "SocialMediaPosting" || t === "Article" || t === "NewsArticle" || t === "BlogPosting" || t === "DiscussionForumPosting");
}

export function linkedinFromHtml(html: string, url: string, limit: number): Pulled {
	const posting = jsonLd(html).find(isPosting);
	const meta = metaTags(html);
	if (!posting && !meta.get("og:description")) throw new Error("LinkedIn did not include the post in the page. It may need a sign-in to view.");
	const author = first(posting?.author);
	const images = [first(posting?.image)].map((image) => (typeof image === "string" ? image : image?.url)).filter((u): u is string => !!u);
	const media = images.map((image) => `image: ${image}`);
	if (posting?.sharedContent?.url) media.push(`link: ${posting.sharedContent.headline ? `${posting.sharedContent.headline} ` : ""}${posting.sharedContent.url}`);
	const post: Post = {
		author: author?.name ?? meta.get("og:title") ?? "unknown",
		date: isoDate(posting?.datePublished),
		url: meta.get("og:url") ?? url,
		text: decodeEntities(posting?.articleBody ?? posting?.text ?? meta.get("og:description") ?? ""),
		stats: interactions(posting?.interactionStatistic),
		media,
	};
	const replies: Reply[] = (posting?.comment ?? []).slice(0, limit).map((comment) => ({
		post: { author: first(comment.author)?.name ?? "unknown", date: isoDate(comment.datePublished), text: decodeEntities(comment.text ?? ""), stats: interactions(comment.interactionStatistic) },
		depth: 0,
	}));
	const title = posting?.headline ? `${post.author}: ${posting.headline}` : `${post.author} on LinkedIn`;
	return { platform: "linkedin", title: title.slice(0, 200), url: post.url ?? url, markdown: renderThread([], post, replies, undefined, posting?.commentCount), photos: images };
}

export async function pullThreads(url: string, ctx: AdapterContext): Promise<Pulled> {
	const page = await get(url, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "threads", [PLAIN_UA, PREVIEW_UA]), accept: (r) => r.status === 200 && metaTags(r.body).get("og:type") === "article" });
	return threadsFromHtml(page.body, page.url);
}

export async function pullLinkedin(url: string, ctx: AdapterContext): Promise<Pulled> {
	const page = await get(url, { signal: ctx.signal, fetcher: ctx.fetcher, agents: agentsFor(ctx.config, "linkedin", [PLAIN_UA, PREVIEW_UA]), accept: (r) => r.status === 200 && (jsonLd(r.body).some(isPosting) || metaTags(r.body).has("og:description")) });
	return linkedinFromHtml(page.body, page.url, ctx.options.comments);
}
