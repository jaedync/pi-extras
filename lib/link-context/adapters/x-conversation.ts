/**
 * A whole X conversation through FxTwitter's public v2 API, no login:
 * `/2/conversation/{id}` gives the posts above a post and its first page of
 * replies; each reply that has replies of its own is read the same way, most
 * liked first; `/2/status/{id}/quotes` pages through the posts that quote it;
 * `/2/thread/{id}` follows a chain of quoted posts. X serves only the first
 * page of replies without a login (a cursor answers 404), so the second
 * ranking (`recency`) adds the replies the first one left out.
 *
 * Every call past the first is optional: a request cap and a time limit stop
 * them, a failed one is counted, and the result says what is missing.
 */
import { agentsFor } from "../config.ts";
import { deadline, getJson, PLAIN_UA } from "../http.ts";
import type { AdapterContext } from "../types.ts";

const API = "https://api.fxtwitter.com/2";

export interface XLimits {
	/** Requests for one pull. FxTwitter allows 1000 a minute from one address. */
	readonly requests: number;
	/** Time for the optional requests; the pull keeps what came back by then. */
	readonly ms: number;
	/** Requests in flight at once. */
	readonly parallel: number;
	readonly quotePages: number;
	readonly quoteDepth: number;
	readonly parents: number;
}

/** 300 requests in 90 s is under half of FxTwitter's 1000 a minute. Quote pages hold 20 posts whatever `count` asks (measured 2026-10-26). */
export const X_LIMITS: XLimits = { requests: 300, ms: 90_000, parallel: 6, quotePages: 50, quoteDepth: 4, parents: 100 };

/** A reply page this long may be cut short, so the other ranking can add replies. */
const FULL_PAGE = 20;
const QUOTE_PAGE = 100;  // the most the API takes; it sends 20

export interface V2Tweet {
	readonly id: string;
	readonly url?: string;
	readonly text?: unknown;
	readonly author?: { name?: unknown; screen_name?: unknown };
	readonly likes?: unknown;
	readonly replies?: unknown;
	readonly quote?: unknown;
	readonly replying_to?: { status?: unknown } | null;
	readonly replying_to_status?: unknown;
	readonly [key: string]: unknown;
}

/** A tweet object with a numeric id, or nothing: the API is a third party, so no field is trusted. */
export function asTweet(value: unknown): V2Tweet | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const id = (value as { id?: unknown }).id;
	return typeof id === "string" && /^\d{1,25}$/.test(id) ? (value as V2Tweet) : undefined;
}

const asTweets = (value: unknown): V2Tweet[] => (Array.isArray(value) ? value.map(asTweet).filter((tweet): tweet is V2Tweet => !!tweet) : []);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const handle = (tweet: V2Tweet): string => (typeof tweet.author?.screen_name === "string" ? tweet.author.screen_name.toLowerCase() : "");

/** The post a tweet answers: v2 names it in `replying_to.status`, v1 in `replying_to_status`. */
export function parentOf(tweet: V2Tweet): string | undefined {
	const id = tweet.replying_to?.status ?? tweet.replying_to_status;
	return typeof id === "string" && /^\d{1,25}$/.test(id) ? id : undefined;
}

/** Snowflake ids grow with time; compared as decimal strings without loss. */
export function olderFirst(a: string, b: string): number {
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The posts above `post`, oldest first, linked by `replying_to` through the
 * API's `thread` list. The list's order is not reliable (measured 2026-10-26),
 * so the chain is rebuilt from the links and not from the order.
 */
export function parentChain(thread: readonly V2Tweet[], post: V2Tweet, max: number): V2Tweet[] {
	const byId = new Map(thread.map((tweet) => [tweet.id, tweet]));
	const chain: V2Tweet[] = [];
	const seen = new Set([post.id]);
	for (let id = parentOf(post); id && !seen.has(id) && chain.length < max; ) {
		const parent = byId.get(id);
		if (!parent) break;
		seen.add(id);
		chain.unshift(parent);
		id = parentOf(parent);
	}
	return chain;
}

interface Stop { reason?: "requests" | "time" }

/**
 * The calls of one pull: a shared request count, a shared time limit, at
 * most `parallel` requests in flight across all the readers, and the
 * caller's abort, which always throws and is never counted as a stop.
 */
export class Calls {
	used = 0;
	failed = 0;
	readonly stop: Stop = {};
	readonly limits: XLimits;
	private readonly ctx: AdapterContext;
	private readonly optional: AbortSignal;
	private active = 0;
	private readonly queue: (() => void)[] = [];

	constructor(ctx: AdapterContext, limits: XLimits) {
		this.ctx = ctx;
		this.limits = limits;
		this.optional = deadline(ctx.signal, limits.ms);
	}

	/** Whether optional calls may still go out; the first reason they may not is recorded. */
	private open(): boolean {
		if (this.optional.aborted) this.stop.reason ??= "time";
		if (this.used >= this.limits.requests) this.stop.reason ??= "requests";
		return !this.stop.reason;
	}

	/** Requests left; at none, the stop is recorded. */
	room(): number {
		this.ctx.signal?.throwIfAborted();
		return this.open() ? this.limits.requests - this.used : 0;
	}

	private async slot(): Promise<void> {
		if (this.active < this.limits.parallel) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve) => this.queue.push(resolve));
	}

	/** Hands the slot to the next waiter, so `active` counts the requests in flight. */
	private release(): void {
		const next = this.queue.shift();
		if (next) next();
		else this.active--;
	}

	/** One GET; undefined when the cap or time ran out or the call failed. 404 is an empty answer, not a failure. */
	async get(path: string, required = false): Promise<Record<string, unknown> | undefined> {
		this.ctx.signal?.throwIfAborted();
		if (!required && !this.open()) return undefined;
		// Counted before the wait for a slot, so `room()` never offers a request that is already queued.
		this.used++;
		await this.slot();
		try {
			return await this.send(path, required);
		} finally {
			this.release();
		}
	}

	private async send(path: string, required: boolean): Promise<Record<string, unknown> | undefined> {
		this.ctx.signal?.throwIfAborted();
		if (!required && this.optional.aborted) {
			this.stop.reason ??= "time";
			return undefined;
		}
		try {
			const body = await getJson<unknown>(`${API}${path}`, {
				signal: required ? this.ctx.signal : this.optional,
				fetcher: this.ctx.fetcher,
				agents: agentsFor(this.ctx.config, "x", [PLAIN_UA]),
				accept: (r) => r.status === 200 || r.status === 404,
			});
			return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
		} catch (error) {
			this.ctx.signal?.throwIfAborted();
			if (required) throw error;
			if (this.optional.aborted) this.stop.reason ??= "time";
			else this.failed++;
			return undefined;
		}
	}
}

export interface XThread {
	readonly status: V2Tweet;
	readonly thread: V2Tweet[];
	readonly replies: V2Tweet[];
}

export async function readConversation(calls: Calls, id: string, ranking?: "recency", required = false): Promise<XThread | undefined> {
	const body = await calls.get(`/conversation/${id}${ranking ? `?ranking_mode=${ranking}` : ""}`, required);
	const status = asTweet(body?.status);
	return status ? { status, thread: asTweets(body?.thread), replies: asTweets(body?.replies) } : undefined;
}

export interface ReplyNode {
	readonly tweet: V2Tweet;
	/** The post it answers; a reply whose parent never came back hangs under the post whose page listed it. */
	readonly parent: string;
}

export interface ReplyTree {
	readonly nodes: ReadonlyMap<string, ReplyNode>;
	/** Replies whose own replies were not read, because of the cap, the time limit or a failure. */
	readonly unread: number;
}

/**
 * Reads replies, then the replies of replies, most liked first, until the
 * tree has `limit` replies, nothing is left to read, or the calls stop.
 */
export async function collectReplies(calls: Calls, focal: XThread, limit: number, progress: (text: string) => void): Promise<ReplyTree> {
	const root = focal.status.id;
	const above = new Set(focal.thread.map((tweet) => tweet.id));
	const listed = new Map<string, { tweet: V2Tweet; via: string }>();
	const add = (tweets: readonly V2Tweet[], via: string) => {
		for (const tweet of tweets) if (tweet.id !== root && !above.has(tweet.id) && !listed.has(tweet.id)) listed.set(tweet.id, { tweet, via });
	};
	const parentIn = (entry: { tweet: V2Tweet; via: string }) => {
		const id = parentOf(entry.tweet);
		return id && (id === root || listed.has(id)) ? id : entry.via;
	};
	add(focal.replies, root);
	// `tried` keeps a failed page from being asked again; only `read` pages count as read.
	const tried = new Set([root]);
	const read = new Set([root]);
	if (focal.replies.length >= FULL_PAGE && focal.replies.length < count(focal.status.replies)) add((await readConversation(calls, root, "recency"))?.replies ?? [], root);
	while (listed.size < limit) {
		const children = new Map<string, number>();
		for (const entry of listed.values()) children.set(parentIn(entry), (children.get(parentIn(entry)) ?? 0) + 1);
		const waiting = [...listed.values()]
			.filter(({ tweet }) => !tried.has(tweet.id) && count(tweet.replies) > (children.get(tweet.id) ?? 0))
			.sort((a, b) => count(b.tweet.likes) - count(a.tweet.likes) || olderFirst(a.tweet.id, b.tweet.id));
		if (!waiting.length) break;
		const next = waiting.slice(0, Math.min(calls.limits.parallel, calls.room()));
		if (!next.length) break;
		for (const { tweet } of next) tried.add(tweet.id);
		const pages = await Promise.all(next.map(({ tweet }) => readConversation(calls, tweet.id)));
		pages.forEach((page, index) => {
			if (!page) return;
			read.add(next[index]!.tweet.id);
			add(page.replies, next[index]!.tweet.id);
		});
		progress(`reading X replies (${listed.size} so far)`);
	}
	const nodes = rooted(new Map([...listed].map(([id, entry]) => [id, { tweet: entry.tweet, parent: parentIn(entry) }])), root);
	const children = new Map<string, number>();
	for (const node of nodes.values()) children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
	const unread = [...nodes.values()].filter(({ tweet }) => !read.has(tweet.id) && count(tweet.replies) > (children.get(tweet.id) ?? 0)).length;
	return { nodes, unread };
}

/**
 * The nodes with every chain of parents ending at `root`: a reply whose
 * chain loops (bad data: two posts that answer each other) hangs under the
 * post itself, so the outline shows it and the counts stay true.
 */
function rooted(nodes: ReadonlyMap<string, ReplyNode>, root: string): Map<string, ReplyNode> {
	const out = new Map(nodes);
	for (const [id, node] of nodes) {
		const seen = new Set([id]);
		let parent = node.parent;
		while (parent !== root && !seen.has(parent) && nodes.has(parent)) {
			seen.add(parent);
			parent = nodes.get(parent)!.parent;
		}
		if (parent !== root) out.set(id, { ...node, parent: root });
	}
	return out;
}

/**
 * The replies depth first: the post author's own replies first (a thread
 * they continue), then most liked, then oldest; at most `limit` of them.
 */
export function orderReplies(tree: ReplyTree, root: V2Tweet, limit: number): { tweet: V2Tweet; depth: number }[] {
	const byParent = new Map<string, V2Tweet[]>();
	for (const node of tree.nodes.values()) {
		const siblings = byParent.get(node.parent);
		if (siblings) siblings.push(node.tweet);
		else byParent.set(node.parent, [node.tweet]);
	}
	const author = handle(root);
	const rank = (a: V2Tweet, b: V2Tweet) => Number(handle(b) === author) - Number(handle(a) === author) || count(b.likes) - count(a.likes) || olderFirst(a.id, b.id);
	const out: { tweet: V2Tweet; depth: number }[] = [];
	const seen = new Set<string>();
	const walk = (id: string, depth: number) => {
		for (const tweet of [...(byParent.get(id) ?? [])].sort(rank)) {
			if (out.length >= limit) return;
			if (seen.has(tweet.id)) continue;
			seen.add(tweet.id);
			out.push({ tweet, depth });
			walk(tweet.id, depth + 1);
		}
	};
	walk(root.id, 0);
	return out;
}

/** One search ranking's pages into `found`, until a page brings nothing new, the cursor ends or the limits stop it. */
async function pageQuotes(calls: Calls, id: string, path: (cursor: string | undefined) => string, found: Map<string, V2Tweet>, limit: number, pages: number): Promise<void> {
	let cursor: string | undefined;
	for (let page = 0; page < pages && found.size < limit; page++) {
		const body = await calls.get(path(cursor));
		// A result that quotes some other post is a search miss, not a quote of this one.
		const fresh = asTweets(body?.results).filter((tweet) => tweet.id !== id && !found.has(tweet.id) && (asTweet(tweet.quote)?.id ?? id) === id);
		// X keeps giving a cursor after its search runs dry, with empty pages; the first page with nothing new ends it.
		if (!fresh.length) break;
		for (const tweet of fresh) found.set(tweet.id, asTweet(tweet.quote)?.id === id ? { ...tweet, quote: undefined } : tweet);
		const next = (body?.cursor as { bottom?: unknown } | undefined)?.bottom;
		if (typeof next !== "string" || !next || next === cursor) break;
		cursor = next;
	}
}

/**
 * The posts that quote `id`, most liked first, each without its quote of
 * `id`. X's search gives only part of them without a login, and its two
 * rankings give different parts: the newest (`/quotes`) first, then the top
 * ones when the count is still short (measured 2026-10-26: 37 newest and 55
 * top of 247 reported, 55 together).
 */
export async function collectQuotes(calls: Calls, id: string, limit: number, pages: number, reported = 0): Promise<V2Tweet[]> {
	const found = new Map<string, V2Tweet>();
	const query = (extra: Record<string, string>) => (cursor: string | undefined) => `?${new URLSearchParams({ ...extra, count: String(QUOTE_PAGE), ...(cursor ? { cursor } : {}) })}`;
	const newest = query({});
	await pageQuotes(calls, id, (cursor) => `/status/${id}/quotes${newest(cursor)}`, found, limit, pages);
	if (found.size < Math.min(limit, reported)) {
		const top = query({ q: `quoted_tweet_id:${id}`, feed: "top" });
		await pageQuotes(calls, id, (cursor) => `/search${top(cursor)}`, found, limit, pages);
	}
	return [...found.values()].sort((a, b) => count(b.likes) - count(a.likes) || olderFirst(a.id, b.id)).slice(0, limit);
}

/**
 * The replies under each quote post, most liked quotes first, a few quotes
 * at a time (each reads its own replies in parallel too). The caller runs
 * this after the post's own replies, so those get the requests first. A
 * quote whose page cannot be read is counted as unread.
 */
export async function collectQuoteReplies(calls: Calls, quotes: readonly V2Tweet[], limit: number, progress: (text: string) => void): Promise<{ trees: Map<string, ReplyTree>; unread: number }> {
	const trees = new Map<string, ReplyTree>();
	const wanted = quotes.filter((quote) => count(quote.replies) > 0);
	const batch = Math.max(1, Math.floor(calls.limits.parallel / 2));
	for (let start = 0; start < wanted.length && !calls.stop.reason; start += batch) {
		await Promise.all(wanted.slice(start, start + batch).map(async (quote) => {
			const thread = await readConversation(calls, quote.id);
			if (thread) trees.set(quote.id, await collectReplies(calls, thread, limit, progress));
		}));
	}
	return { trees, unread: wanted.length - trees.size };
}

export interface QuoteLevel {
	readonly tweet: V2Tweet;
	readonly parents: V2Tweet[];
}

/**
 * The chain of quoted posts below `status`: each level read with
 * `/2/thread`, which gives the quoted post's own quote and the posts above
 * it. A level that cannot be read keeps the shallow copy its quoter carried.
 */
export async function collectQuoteChain(calls: Calls, status: V2Tweet, limits: XLimits): Promise<QuoteLevel[]> {
	const chain: QuoteLevel[] = [];
	const seen = new Set([status.id]);
	for (let shallow = asTweet(status.quote); shallow && !seen.has(shallow.id) && chain.length < limits.quoteDepth; ) {
		seen.add(shallow.id);
		const body = await calls.get(`/thread/${shallow.id}`);
		const full = asTweet(body?.status);
		if (!full) {
			chain.push({ tweet: shallow, parents: [] });
			break;
		}
		chain.push({ tweet: full, parents: parentChain(asTweets(body?.thread), full, limits.parents) });
		shallow = asTweet(full.quote);
	}
	return chain;
}
