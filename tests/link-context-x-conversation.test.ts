import assert from "node:assert/strict";
import test from "node:test";
import { pullX } from "../lib/link-context/adapters/x.ts";
import { olderFirst, parentChain, X_LIMITS, type XLimits } from "../lib/link-context/adapters/x-conversation.ts";
import { context, fakeFetch, json, type Route } from "./support/link-fetch.ts";

const tweet = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, url: `https://x.com/${name}/status/${id}`, text: `text of ${id}`, author: { name, screen_name: name }, likes: 0, replies: 0, quotes: 0, ...extra });
const reply = (id: string, name: string, to: string, extra: Record<string, unknown> = {}) => tweet(id, name, { replying_to: { screen_name: "someone", status: to }, ...extra });
/** One endpoint and id exactly: `/2/conversation/10` must not answer `/2/conversation/100`. */
const at = (path: string, body: unknown, status = 200): Route => json(new RegExp(`api\\.fxtwitter\\.com/2/${path.replace(/[?]/g, "\\?")}(?:[?&]|$)`), body, status);
const conversation = (status: unknown, replies: unknown[] = [], thread: unknown[] = [status]) => ({ code: 200, status, thread, replies, cursor: { bottom: "never-works" } });
const limits = (over: Partial<XLimits> = {}): XLimits => ({ ...X_LIMITS, ...over });
const whole = { comments: 2000, quotes: 1000 };

test("X: the whole conversation: parents from an unordered thread, nested replies, quotes with their replies, the quote chain", async () => {
	const focal = tweet("100", "op", { replies: 5, quotes: 2, likes: 40, replying_to: { status: "90" }, quote: tweet("50", "q1") });
	const routes = fakeFetch(
		// The API's thread list is out of order; the chain comes from the links.
		at("conversation/100", conversation(focal, [
			reply("101", "a", "100", { likes: 3, replies: 1 }),
			reply("102", "op", "100"),
			reply("103", "b", "100", { likes: 9 }),
			reply("104", "c", "999"),
			reply("90", "mid", "80"),
		], [focal, tweet("80", "root"), reply("90", "mid", "80")])),
		at("conversation/101", conversation(reply("101", "a", "100"), [reply("111", "d", "101")])),
		at("status/100/quotes", { code: 200, results: [tweet("201", "qa", { likes: 1, quote: tweet("100", "op") }), tweet("202", "qb", { likes: 7, replies: 1, quote: tweet("100", "op") })], cursor: { bottom: "c1" } }),
		json(/quotes\?count=100&cursor=c1/, { code: 200, results: [], cursor: { bottom: "c2" } }),
		at("conversation/202", conversation(tweet("202", "qb"), [reply("212", "e", "202")])),
		at("thread/50", { code: 200, status: tweet("50", "q1", { replying_to: { status: "45" }, quote: tweet("40", "q2") }), thread: [tweet("50", "q1"), tweet("45", "q0")] }),
		at("thread/40", { code: 200, status: tweet("40", "q2"), thread: [] }),
	);
	const pulled = await pullX("100", context(routes.fetcher, whole));
	const md = pulled.markdown;
	assert.match(md, /^## Earlier in the thread\n\n\*\*root\*\*[\s\S]*text of 80\n\n---\n\n\*\*mid\*\*[\s\S]*text of 90\n\n## Post\n\n\*\*op\*\*/);
	assert.match(md, /Quoted post:\n> In reply to:\n> > \*\*q0\*\*[\s\S]*> \*\*q1\*\*[\s\S]*> text of 50\n>\n> Quoted post:\n> > \*\*q2\*\*/);
	const order = ["text of 102", "text of 103", "text of 101", "    text of 111", "text of 104"].map((text) => md.indexOf(text));
	assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]!)), `replies in order: author first, then likes, nested under their parent: ${order}`);
	assert.match(md, /## Replies \(5\)/);
	assert.doesNotMatch(md.slice(md.indexOf("## Replies")), /text of 90/, "a post above is not also a reply");
	assert.match(md, /## Quote posts \(2\)\n\n- \*\*qb\*\*[^\n]*\n  text of 202\n  - \*\*e\*\*[^\n]*\n    text of 212\n- \*\*qa\*\*[^\n]*\n  text of 201/);
	assert.doesNotMatch(md.slice(md.indexOf("## Quote posts")), /Quoted post|text of 100/, "a quote post does not repeat the post it quotes");
	assert.ok(pulled.preview && pulled.preview.length <= md.length);
	assert.match(pulled.summary?.[0] ?? "", /^op · 40 likes · 5 replies · 2 quotes · 5 replies$/);
	assert.equal(pulled.summary?.[2], "op: text of 102", "the first reply in the summary is the first reply shown");
	const asked = routes.calls.map((call) => call.url.replace("https://api.fxtwitter.com/2", ""));
	assert.deepEqual(asked.sort(), ["/conversation/100", "/conversation/101", "/conversation/202", "/status/100/quotes?count=100", "/status/100/quotes?count=100&cursor=c1", "/thread/40", "/thread/50"].sort());
});

test("X: quote posts short of the reported count also come from the top ranking, merged by id", async () => {
	const focal = tweet("300", "op", { quotes: 5 });
	const { fetcher, calls } = fakeFetch(
		at("conversation/300", conversation(focal)),
		json(/status\/300\/quotes\?count=100$/, { code: 200, results: [tweet("301", "a", { likes: 1 }), tweet("302", "b")], cursor: { bottom: "dry" } }),
		json(/status\/300\/quotes\?count=100&cursor=dry/, { code: 200, results: [], cursor: { bottom: "dry2" } }),
		json(/\/2\/search\?q=quoted_tweet_id%3A300&feed=top&count=100$/, { code: 200, results: [tweet("302", "b"), tweet("303", "c", { likes: 9 })], cursor: { bottom: "t1" } }),
		json(/\/2\/search\?.*cursor=t1/, { code: 200, results: [tweet("303", "c")], cursor: { bottom: "t2" } }),
	);
	const pulled = await pullX("300", context(fetcher, whole));
	assert.match(pulled.markdown, /## Quote posts \(3 of 5\)\n\n- \*\*c\*\*[\s\S]*- \*\*a\*\*[\s\S]*- \*\*b\*\*/);
	assert.match(pulled.markdown, /X reports 5 quote posts; 3 came back\./);
	assert.equal(calls.filter((call) => call.url.includes("/search")).length, 2);
});

test("X: a full first page of replies also reads the newest replies; ids sort as numbers", async () => {
	const focal = tweet("500", "op", { replies: 30 });
	const top = Array.from({ length: 20 }, (_, i) => reply(String(600 + i), `u${i}`, "500", { likes: 20 - i }));
	const { fetcher, calls } = fakeFetch(
		json(/conversation\/500\?ranking_mode=recency/, conversation(focal, [top[0], reply("700", "new1", "500"), reply("701", "new2", "500")])),
		at("conversation/500", conversation(focal, top)),
	);
	const pulled = await pullX("500", context(fetcher, whole));
	assert.match(pulled.markdown, /## Replies \(22\)/);
	assert.match(pulled.markdown, /X reports 30 replies to this post; 22 direct replies and 0 nested replies came back/);
	assert.equal(calls.filter((call) => call.url.includes("recency")).length, 1);
	assert.equal(olderFirst("99", "100"), -1);
	assert.equal(olderFirst("2114579807577194499", "2114579807577194500"), -1);
});

test("X: the request cap and the time limit stop the optional reads and say so", async () => {
	const focal = tweet("1", "op", { replies: 4 });
	const branchy = [2, 3, 4, 5].map((n) => reply(String(n), `r${n}`, "1", { replies: 3, likes: n }));
	const capped = fakeFetch(at("conversation/1", conversation(focal, branchy)), json(/conversation\/\d$/, conversation(tweet("9", "x"), [])));
	const pulled = await pullX("1", context(capped.fetcher, whole), limits({ requests: 3, parallel: 6 }));
	assert.equal(capped.calls.length, 3);
	assert.match(pulled.markdown, /The replies to 2 replies were not read\./);
	assert.match(pulled.markdown, /Reading stopped at the limit of 3 requests/);

	// A nested read that never answers ends at the time limit; the pull keeps the first page.
	const hanging = fakeFetch(at("conversation/1", conversation(focal, branchy)));
	const slow = (async (input: string | URL | Request, init: RequestInit = {}) => {
		if (String(input).endsWith("/conversation/1")) return hanging.fetcher(input, init);
		return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
	}) as typeof fetch;
	const timed = await pullX("1", context(slow, whole), limits({ ms: 50 }));
	assert.match(timed.markdown, /## Replies \(4\)/);
	assert.match(timed.markdown, /Reading stopped at the time limit of 0\.05 s/);
});

test("X: the caller's abort ends the pull and is not read as a failure", async () => {
	const controller = new AbortController();
	const focal = tweet("1", "op", { replies: 1 });
	const { fetcher: first } = fakeFetch(at("conversation/1", conversation(focal, [reply("2", "r", "1", { replies: 1 })])));
	const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
		if (String(input).endsWith("/conversation/1")) return first(input, init);
		controller.abort(new Error("stopped by the user"));
		throw init.signal?.reason;
	}) as typeof fetch;
	await assert.rejects(pullX("1", { ...context(fetcher, whole), signal: controller.signal }), /stopped by the user/);
});

test("X: odd fields from the API do not stop the conversation", async () => {
	const focal = { id: "1", text: 42, author: "nobody", media: { all: "none" }, replies: "many", quote: { id: 7 }, likes: Number.NaN };
	const { fetcher } = fakeFetch(at("conversation/1", { code: 200, status: focal, thread: [null, 5, { id: 7 }], replies: [reply("2", "ok", "1"), { id: "not-a-number" }, "text"] }));
	const pulled = await pullX("1", context(fetcher, whole));
	assert.match(pulled.markdown, /^\*\*unknown\*\*\n\n\(no text\)/);
	assert.match(pulled.markdown, /## Replies \(1\)\n\n- \*\*ok\*\*/);
	assert.equal(pulled.url, "https://x.com/i/status/1");
	assert.deepEqual(parentChain([], { id: "1", replying_to: { status: "1" } }, 5), [], "a post that answers itself is not its own parent");
});

test("X: when v2 fails, the v1 post and its parents come back with a note", async () => {
	const { fetcher, calls } = fakeFetch(
		at("conversation/3", { code: 500 }, 500),
		json("/status/3", { tweet: { text: "third", author: { name: "Cee", screen_name: "cee" }, replying_to_status: "2" } }),
		json("/status/2", { tweet: { text: "second", author: { name: "Bee", screen_name: "bee" } } }),
	);
	const pulled = await pullX("3", context(fetcher, whole));
	assert.match(pulled.markdown, /second[\s\S]*## Post[\s\S]*third/);
	assert.match(pulled.markdown, /_Replies and quote posts could not be read \(api\.fxtwitter\.com answered HTTP 500\); only the posts above are shown\._$/);
	assert.equal(calls.filter((call) => call.url.includes("/2/")).length, 1, "a failed first v2 read is not retried as a whole");
	// v2 has no post and v1 has none either: the error names the likely reasons.
	const gone = fakeFetch(at("conversation/9", { code: 404, status: null }, 404), json("/status/9", { code: 404, message: "NOT_FOUND" }, 404));
	await assert.rejects(pullX("9", context(gone.fetcher, whole)), /no post with that id/);
});
