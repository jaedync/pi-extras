import assert from "node:assert/strict";
import test from "node:test";
import { expandLinks, pullBluesky } from "../lib/link-context/adapters/bluesky.ts";
import { NotHandled, pullGithub } from "../lib/link-context/adapters/github.ts";
import { pullHackerNews } from "../lib/link-context/adapters/hackernews.ts";
import { nestReplies, pullMastodon } from "../lib/link-context/adapters/mastodon.ts";
import { pullReddit } from "../lib/link-context/adapters/reddit.ts";
import { linkedinFromHtml, threadsFromHtml } from "../lib/link-context/adapters/social-pages.ts";
import { mainText, webFromHtml } from "../lib/link-context/adapters/web.ts";
import { pullX, videoFile } from "../lib/link-context/adapters/x.ts";
import { PLAIN_UA, PREVIEW_UA } from "../lib/link-context/http.ts";
import { context, fakeFetch, json } from "./support/link-fetch.ts";

const author = (name: string) => ({ name, screen_name: name.toLowerCase() });

test("X: the post, its quote, media and the chain of parents", async () => {
	const { fetcher, calls } = fakeFetch(
		json("/status/3", { tweet: { url: "https://x.com/c/status/3", text: "third", author: author("Cee"), created_timestamp: 1_700_000_200, likes: 12, replying_to_status: "2", quote: { text: "quoted", author: author("Q") }, media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/abc.jpg", altText: "a chart" }, { type: "video", url: "https://video.twimg.com/v/3840x2160/big.mp4", duration: 9.6, thumbnail_url: "https://pbs.twimg.com/t.jpg", variants: [{ url: "https://video.twimg.com/v/480x270/s.mp4", content_type: "video/mp4", bitrate: 1 }, { url: "https://video.twimg.com/v/1280x720/m.mp4", content_type: "video/mp4", bitrate: 2 }, { url: "https://video.twimg.com/v/pl.m3u8", content_type: "application/x-mpegURL" }] }] } } }),
		json("/status/2", { tweet: { text: "second", author: author("Bee"), replying_to_status: "1" } }),
		json("/status/1", { tweet: { text: "first", author: author("Ay"), replying_to_status: null } }),
	);
	const pulled = await pullX("3", context(fetcher));
	assert.match(pulled.markdown, /^## Earlier in the thread\n\n\*\*Ay\*\* \(@ay\)\n\nfirst\n\n---\n\n\*\*Bee\*\* \(@bee\)\n\nsecond\n\n## Post\n\n\*\*Cee\*\* \(@cee\) · 2023-11-14T22:\d\d:\d\dZ · 12 likes/);
	assert.match(pulled.markdown, /- photo: https:\/\/pbs\.twimg\.com\/media\/abc\.jpg alt: a chart\n- video \(10s\): https:\/\/video\.twimg\.com\/v\/3840x2160\/big\.mp4/);
	assert.match(pulled.markdown, /Quoted post:\n> \*\*Q\*\* \(@q\)/);
	assert.deepEqual(pulled.photos, ["https://pbs.twimg.com/media/abc.jpg", "https://pbs.twimg.com/t.jpg"]);
	assert.equal(pulled.videoUrl, "https://video.twimg.com/v/1280x720/m.mp4");
	assert.ok(calls.every((c) => c.agent === PLAIN_UA));
	// Without replies requested, no parent requests are made.
	const single = fakeFetch(json("/status/3", { tweet: { text: "x", author: author("Cee"), replying_to_status: "2" } }));
	await pullX("3", context(single.fetcher, { comments: 0 }));
	assert.equal(single.calls.length, 1);
	await assert.rejects(pullX("9", context(fakeFetch(json("/status/9", { code: 404, message: "NOT_FOUND" }, 404)).fetcher)), /no post with that id/);
	assert.equal(videoFile({ url: "https://v/orig.mp4" }), "https://v/orig.mp4");
});

test("Bluesky: parents, the post with embeds, and replies by likes", async () => {
	const post = (rkey: string, text: string, likes = 0, extra = {}) => ({ uri: `at://did:plc:a/app.bsky.feed.post/${rkey}`, author: { handle: "a.test", displayName: "A" }, record: { text, createdAt: "2026-01-01T00:00:00Z" }, likeCount: likes, ...extra });
	const thread = {
		post: post("p", "the post", 9, { replyCount: 7, embed: { $type: "app.bsky.embed.recordWithMedia#view", record: { record: { uri: "at://did:plc:q/app.bsky.feed.post/q", author: { handle: "q.test" }, value: { text: "quoted text" } } }, media: { images: [{ fullsize: "https://cdn.test/full.jpg", alt: "pic" }] } } }),
		parent: { post: post("root", "root post") },
		replies: [{ post: post("r1", "low", 1) }, { post: post("r2", "high", 5), replies: [{ post: post("r3", "nested", 0) }] }],
	};
	const { fetcher, calls } = fakeFetch(json("getPostThread", { thread }));
	const pulled = await pullBluesky("a.test", "p", context(fetcher, { comments: 2 }));
	assert.match(calls[0].url, /uri=at%3A%2F%2Fa\.test%2Fapp\.bsky\.feed\.post%2Fp&depth=6/);
	assert.match(pulled.markdown, /root post[\s\S]*## Post[\s\S]*the post\n\n- photo: https:\/\/cdn\.test\/full\.jpg alt: pic\n\nQuoted post:\n> \*\*q\.test\*\*/);
	assert.match(pulled.markdown, /## Replies \(2 of 7\)\n\n- \*\*A\*\* \(@a\.test\)[^\n]*5 likes\n  high\n  - \*\*A\*\*[^\n]*\n    nested/);
	assert.equal(pulled.url, "https://bsky.app/profile/a.test/post/p");
	assert.deepEqual(pulled.photos, ["https://cdn.test/full.jpg"]);
});

test("Reddit: old.reddit JSON, link-preview agent first, comments nested", async () => {
	const listing = [
		{ data: { children: [{ kind: "t3", data: { title: "A title", selftext: "body text", author: "op", subreddit_name_prefixed: "r/test", score: 10, num_comments: 3, upvote_ratio: 0.9, permalink: "/r/test/comments/abc/a_title/", is_self: true } }] } },
		{ data: { children: [{ kind: "t1", data: { author: "c1", body: "first", score: 4, replies: { data: { children: [{ kind: "t1", data: { author: "c2", body: "reply", score: 1, replies: "" } }, { kind: "more", data: {} }] } } } }] } },
	];
	const { fetcher, calls } = fakeFetch((url, init) => ((init.headers as Record<string, string>)["User-Agent"] === PREVIEW_UA && url.startsWith("https://old.reddit.com/r/test/comments/abc/a_title/.json") ? Response.json(listing) : new Response("<html>login</html>", { headers: { "content-type": "text/html" } })));
	const pulled = await pullReddit({ path: "/r/test/comments/abc/a_title" }, context(fetcher));
	assert.equal(calls[0].agent, PREVIEW_UA);
	assert.match(pulled.markdown, /^\*\*u\/op\*\* · 10 points · 3 comments · 90% upvoted\nhttps:\/\/www\.reddit\.com\/r\/test\/comments\/abc\/a_title\/\n\n# A title\nr\/test\n\nbody text/);
	assert.match(pulled.markdown, /## Replies \(2 of 3\)\n\n- \*\*u\/c1\*\* · 4 points\n  first\n  - \*\*u\/c2\*\* · 1 points\n    reply/);
});

test("Reddit share links resolve to the permalink first", async () => {
	const listing = [{ data: { children: [{ data: { title: "T", permalink: "/r/x/comments/zz/t/" } }] } }, { data: { children: [] } }];
	const { fetcher, calls } = fakeFetch(
		(url) => (url === "https://www.reddit.com/r/x/s/Share1" ? new Response(null, { status: 301, headers: { location: "https://www.reddit.com/r/x/comments/zz/t/?share_id=1" } }) : undefined),
		(url) => (url.startsWith("https://www.reddit.com/r/x/comments/zz/t/") ? new Response("page", { headers: { "content-type": "text/html" } }) : undefined),
		json("old.reddit.com/r/x/comments/zz/t/.json", listing),
	);
	const pulled = await pullReddit({ share: "https://www.reddit.com/r/x/s/Share1" }, context(fetcher));
	assert.equal(pulled.title, "T");
	assert.ok(calls.some((c) => c.url.startsWith("https://old.reddit.com/r/x/comments/zz/t/.json")));
});

test("Hacker News: story, comment tree, deleted comments skipped", async () => {
	const item = { id: 1, title: "Story", url: "https://e.test/", author: "pg", points: 5, created_at: "2006-10-09T18:21:51.000Z", children: [{ author: "a", text: "<p>hi &amp; bye</p>", children: [{ author: "b", text: "deep", children: [] }] }, { author: null, text: null, children: [] }] };
	const pulled = await pullHackerNews("1", context(fakeFetch(json("/items/1", item)).fetcher));
	assert.match(pulled.markdown, /# Story\nhttps:\/\/e\.test\/[\s\S]*## Replies \(2 of 3\)\n\n- \*\*a\*\*[^\n]*\n  hi & bye\n  - \*\*b\*\*/);
});

test("Mastodon: status HTML to text, context nested by reply id", async () => {
	const status = (id: string, reply: string | null, content: string) => ({ id, in_reply_to_id: reply, content, account: { display_name: `U${id}`, acct: `u${id}@x.test` }, created_at: "2026-01-01T00:00:00Z", url: `https://x.test/@u/${id}`, media_attachments: [] });
	const { fetcher } = fakeFetch(
		json("/api/v1/statuses/10/context", { ancestors: [status("9", null, "<p>before</p>")], descendants: [status("11", "10", "<p>r1</p>"), status("12", "11", "<p>r2</p>"), status("13", "10", "<p>r3</p>")] }),
		json("/api/v1/statuses/10", { ...status("10", "9", "<p>main <a href=\"https://e.test/\">link</a></p>"), spoiler_text: "spoilers", media_attachments: [{ type: "image", url: "https://x.test/i.png", description: "img" }] }),
	);
	const pulled = await pullMastodon("https://x.test", "10", context(fetcher));
	assert.match(pulled.markdown, /before[\s\S]*CW: spoilers\n\nmain \[link\]\(https:\/\/e\.test\/\)\n\n- image: https:\/\/x\.test\/i\.png alt: img/);
	assert.deepEqual(nestReplies("10", [status("11", "10", "a"), status("12", "11", "b"), status("13", "10", "c")], 5).map((r) => r.depth), [0, 1, 0]);
	assert.deepEqual(pulled.photos, ["https://x.test/i.png"]);
	await assert.rejects(pullMastodon("https://x.test", "77", context(fakeFetch(json("/statuses/77", { error: "nope" })).fetcher)), /Not a Mastodon status/);
});

test("Threads and LinkedIn read the preview data their pages carry", () => {
	const threads = threadsFromHtml(`<meta property="og:type" content="article"><meta property="og:title" content="Jo (&#064;jo.x) on Threads"><meta property="og:description" content="Full post text"><meta property="og:image" content="https://cdn.test/t51.2885-19/avatar.jpg">`, "https://www.threads.com/@jo.x/post/1");
	assert.match(threads.markdown, /^\*\*Jo\*\* \(@jo\.x\)\nhttps:\/\/www\.threads\.com\/@jo\.x\/post\/1\n\nFull post text\n/);
	assert.deepEqual(threads.photos, []);
	assert.throws(() => threadsFromHtml("<html></html>", "https://www.threads.com/@a/post/1"), /did not include the post/);
	const ld = { "@type": "SocialMediaPosting", articleBody: "Post body &amp; more", datePublished: "2026-01-02T03:04:05Z", author: { name: "Lee" }, commentCount: 40, interactionStatistic: [{ interactionType: "http://schema.org/LikeAction", userInteractionCount: 7 }], comment: [{ text: "Nice", author: { name: "Cam" } }, { text: "Two", author: [{ name: "Dee" }] }] };
	const linkedin = linkedinFromHtml(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`, "https://www.linkedin.com/posts/x", 1);
	assert.match(linkedin.markdown, /^\*\*Lee\*\* · 2026-01-02T03:04:05Z · 7 likes\nhttps:\/\/www\.linkedin\.com\/posts\/x\n\nPost body & more\n\n## Replies \(1 of 40\)\n\n- \*\*Cam\*\*\n  Nice/);
});

test("GitHub: issues with comments, and unknown pages left to the web adapter", async () => {
	const { fetcher, calls } = fakeFetch(
		json("/repos/o/r/issues/5/comments", [{ body: "a comment", user: { login: "c" }, created_at: "2026-01-01T00:00:00Z" }]),
		json("/repos/o/r/issues/5", { title: "Bug", body: "it broke", user: { login: "u" }, state: "open", comments: 1, html_url: "https://github.com/o/r/issues/5", labels: [{ name: "bug" }] }),
	);
	const pulled = await pullGithub("o", "r", ["issues", "5"], context(fetcher));
	assert.match(pulled.markdown, /# Bug\nstate: open · labels: bug\n\nit broke[\s\S]*## Replies \(1\)\n\n- \*\*c\*\*/);
	assert.equal(pulled.title, "o/r#5: Bug");
	assert.ok(calls.every((c) => c.url.startsWith("https://api.github.com/")));
	await assert.rejects(pullGithub("o", "r", ["pulls"], context(fetcher)), NotHandled);
	await assert.rejects(pullGithub("..", "r", [], context(fetcher)), NotHandled);
	await assert.rejects(pullGithub("o", "r?x=1", [], context(fetcher)), NotHandled);
	const tree = fakeFetch(json("/repos/o/r/contents/", []));
	await pullGithub("o", "r", ["tree", "main", "..", "..", "user?x"], context(tree.fetcher));
	assert.equal(tree.calls[0].url, "https://api.github.com/repos/o/r/contents/user%3Fx?ref=main", "dot segments are dropped and the rest encoded");
});

test("web pages: main text without navigation, metadata on top", () => {
	const page = `<html><head><title>T</title><meta property="og:site_name" content="Site"><meta name="author" content="Ann"><meta property="og:description" content="Summary here"></head><body><nav>Menu</nav><article><h1>Head</h1><p>Body text.</p><aside>ad</aside></article><footer>foot</footer></body></html>`;
	assert.equal(mainText(page), "# Head\n\nBody text.");
	const pulled = webFromHtml(page, "https://e.test/a");
	assert.equal(pulled.markdown, "# T\nSite · Ann\nhttps://e.test/a\n> Summary here\n\n# Head\n\nBody text.");
});

test("Bluesky: shortened link text becomes the full URL from its facet", () => {
	const text = "café see example.com/a-long-pa... and docs";
	const at = (part: string) => Buffer.byteLength(text.slice(0, text.indexOf(part)), "utf8");
	const facets = [
		{ index: { byteStart: at("example"), byteEnd: at(" and") }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a-long-path" }] },
		{ index: { byteStart: at("docs"), byteEnd: Buffer.byteLength(text) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://docs.test/" }] },
		{ index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: "app.bsky.richtext.facet#mention" }] },
	];
	assert.equal(expandLinks(text, facets), "café see https://example.com/a-long-path and [docs](https://docs.test/)");
	assert.equal(expandLinks(text, undefined), text);
});
