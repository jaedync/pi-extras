import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, agentsFor } from "../lib/link-context/config.ts";
import { get, getJson, PLAIN_UA, PREVIEW_UA } from "../lib/link-context/http.ts";
import { classify, isPrivateHost, parseUrl } from "../lib/link-context/url.ts";
import { fakeFetch } from "./support/link-fetch.ts";
import { clock, decodeEntities, htmlToText, jsonLd, metaTags, parseClock, parseRange } from "../lib/link-context/text.ts";

const kind = (url: string) => classify(parseUrl(url));

test("links route to the adapter for their site", () => {
	assert.deepEqual(kind("https://x.com/jack/status/20"), { kind: "x", id: "20" });
	assert.deepEqual(kind("twitter.com/i/web/status/123456"), { kind: "x", id: "123456" });
	assert.deepEqual(kind("https://fxtwitter.com/a/status/9?s=20"), { kind: "x", id: "9" });
	assert.deepEqual(kind("https://bsky.app/profile/alice.test/post/3abc"), { kind: "bluesky", actor: "alice.test", rkey: "3abc" });
	assert.equal(kind("https://www.threads.com/@someone/post/C0zaX").kind, "threads");
	assert.deepEqual(kind("https://www.reddit.com/r/test/comments/abc123/a_title/"), { kind: "reddit", path: "/r/test/comments/abc123/a_title" });
	assert.deepEqual(kind("https://old.reddit.com/r/test/comments/abc123/a_title/c0mm3nt/?context=3"), { kind: "reddit", path: "/r/test/comments/abc123/a_title/c0mm3nt" });
	assert.deepEqual(kind("https://redd.it/abc123"), { kind: "reddit", path: "/comments/abc123" });
	assert.equal(kind("https://www.reddit.com/r/test/s/AbCdEf").kind, "reddit-share");
	assert.deepEqual(kind("https://news.ycombinator.com/item?id=42"), { kind: "hackernews", id: "42" });
	assert.deepEqual(kind("https://github.com/o/r/issues/7"), { kind: "github", owner: "o", repo: "r", rest: ["issues", "7"] });
	assert.deepEqual(kind("https://gist.github.com/u/abcdef0123"), { kind: "gist", id: "abcdef0123" });
	assert.equal(kind("https://www.linkedin.com/posts/someone_activity-1-x").kind, "linkedin");
	assert.deepEqual(kind("https://www.youtube.com/watch?v=abc"), { kind: "video", url: "https://www.youtube.com/watch?v=abc", site: "youtube" });
	assert.equal((kind("https://youtu.be/abc") as { site: string }).site, "youtube");
	assert.equal((kind("https://www.tiktok.com/@a/video/1") as { site: string }).site, "tiktok");
	assert.equal((kind("https://www.instagram.com/reel/xyz/") as { site: string }).site, "instagram");
	assert.equal((kind("https://cdn.example.com/clip.mp4") as { site: string }).site, "file");
	assert.deepEqual(kind("https://fosstodon.org/@someone/113439993286318052"), { kind: "mastodon", origin: "https://fosstodon.org", id: "113439993286318052" });
	assert.deepEqual(kind("https://example.com/blog/post"), { kind: "web", url: "https://example.com/blog/post" });
	// A profile is not a post.
	assert.equal(kind("https://x.com/jack").kind, "web");
	assert.deepEqual(kind("https://i.imgur.com/AbC12de.png"), { kind: "image", url: "https://i.imgur.com/AbC12de.png" });
	assert.deepEqual(kind("https://imgur.com/AbC12de"), { kind: "image", url: "https://i.imgur.com/AbC12de.jpg" });
	assert.equal(kind("https://imgur.com/a/AbC12de").kind, "web");
	for (const page of ["upload", "signin", "gallery", "privacy"]) assert.equal(kind(`https://imgur.com/${page}`).kind, "web", page);
	assert.equal(kind("https://i.imgur.com/AbC12de.gifv").kind, "video");
	assert.equal(kind("https://i.imgur.com/AbC12de.mp4").kind, "video");
	assert.equal(kind("https://e.test/pics/cat.webp?x=1").kind, "image");
	assert.equal(kind("https://github.com/o/r/blob/main/%E0%A4%A").kind, "github", "a malformed escape does not fail the link");
	assert.equal(kind("https://github.com/settings/profile").kind, "web");
});

test("only public http(s) links are read", () => {
	assert.throws(() => parseUrl("file:///etc/passwd"), /Only http and https/);
	assert.throws(() => parseUrl("https://user:pw@example.com/"), /credentials/);
	assert.throws(() => parseUrl("http://127.0.0.1:8080/"), /private or local/);
	assert.throws(() => parseUrl("http://[::1]/"), /private or local/);
	assert.throws(() => parseUrl("http://printer.local/"), /private or local/);
	assert.throws(() => parseUrl("not a url at all"), /valid URL/);
	for (const host of ["10.0.0.1", "192.168.1.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "localhost", "intranet", "fd00::1", "fe80::1", "localhost.", "printer.local.", "nas.lan", "router.home.arpa", "box.localdomain", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::7f00:1", "::127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "ff02::1", "192.0.0.8", "192.0.2.1", "2001:0:4136:e378::1", "2001::1"]) assert.equal(isPrivateHost(host), true, host);
	for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "192.0.43.10", "2001:db8:1::1", "2001:4860:4860::8888"]) assert.equal(isPrivateHost(host), false, host);
	assert.equal(parseUrl("<https://example.com/a>").href, "https://example.com/a");
});

test("times and ranges parse in the forms people write", () => {
	assert.equal(clock(5), "0:05");
	assert.equal(clock(3725), "1:02:05");
	assert.equal(parseClock("90"), 90);
	assert.equal(parseClock("1:30"), 90);
	assert.equal(parseClock("1:02:03"), 3723);
	assert.equal(parseClock("1m30s"), 90);
	assert.equal(parseClock("soon"), undefined);
	assert.deepEqual(parseRange("1:00-2:30"), { start: 60, end: 150 });
	assert.deepEqual(parseRange("90-"), { start: 90 });
	assert.deepEqual(parseRange("-0:45"), { start: 0, end: 45 });
	assert.equal(parseRange(undefined), undefined);
	assert.throws(() => parseRange("2:00-1:00"), /Range must look like/);
	assert.throws(() => parseRange("1-2-3"), /Range must look like/);
});

test("HTML helpers read entities, preview tags, JSON-LD and body text", () => {
	assert.equal(decodeEntities("a &amp; b &#064; &#x41; &nbsp;x &bogus;"), "a & b @ A  x &bogus;");
	const html = `<meta property="og:title" content="Hi &amp; bye"><meta name='description' content='desc'><script type="application/ld+json">{"@type":"Article","articleBody":"x"}</script><script type="application/ld+json">{broken</script>`;
	const meta = metaTags(html);
	assert.equal(meta.get("og:title"), "Hi & bye");
	assert.equal(meta.get("description"), "desc");
	assert.deepEqual(jsonLd(html), [{ "@type": "Article", articleBody: "x" }]);
	assert.equal(htmlToText("<h2>Title</h2><p>One <a href=\"https://e.test/\">link</a>.</p><script>bad()</script><ul><li>a</li><li>b</li></ul>"), "## Title\n\nOne [link](https://e.test/).\n\n- a\n- b");
});

test("config keeps valid fields and drops the rest", () => {
	const config = parseConfig({ userAgents: { reddit: ["A", "", 5, "bad\nagent"], x: "nope" }, proxy: " socks5://p:1 ", refreshDays: 900, cookies: "" });
	assert.deepEqual(config.userAgents, { reddit: ["A"] });
	assert.equal(config.proxy, "socks5://p:1");
	assert.equal(config.cookies, undefined);
	assert.equal(config.refreshDays, 3);
	assert.deepEqual(agentsFor(config, "reddit", ["B"]), ["A"]);
	assert.deepEqual(agentsFor(config, "web", ["B"]), ["B"]);
});

test("the user-agent chain moves on until a response is accepted", async () => {
	const { fetcher, calls } = fakeFetch((_url, init) => {
		const agent = (init.headers as Record<string, string>)["User-Agent"];
		return agent === PREVIEW_UA ? Response.json({ ok: true }) : new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
	});
	assert.deepEqual(await getJson("https://e.test/a.json", { fetcher, agents: [PLAIN_UA, PREVIEW_UA] }), { ok: true });
	assert.deepEqual(calls.map((c) => c.agent), [PLAIN_UA, PREVIEW_UA]);
	await assert.rejects(getJson("https://e.test/a.json", { fetcher, agents: [PLAIN_UA] }), /HTTP 200/);
});

test("redirects are followed by hand and checked like the first URL", async () => {
	const { fetcher, calls } = fakeFetch((url) => (url.endsWith("/start") ? new Response(null, { status: 302, headers: { location: "/next" } }) : url.endsWith("/next") ? new Response(null, { status: 301, headers: { location: "http://169.254.169.254/meta" } }) : new Response("x")));
	await assert.rejects(get("https://e.test/start", { fetcher }), /private or local/);
	assert.deepEqual(calls.map((c) => c.url), ["https://e.test/start", "https://e.test/next"]);
});

test("credentials stay with their origin across redirects", async () => {
	const seen: Record<string, string | undefined> = {};
	const { fetcher } = fakeFetch((url, init) => {
		seen[new URL(url).hostname] = (init.headers as Record<string, string>).Authorization;
		return url.startsWith("https://api.test/") ? new Response(null, { status: 302, headers: { location: "https://other.test/x" } }) : Response.json({});
	});
	await getJson("https://api.test/a", { fetcher, headers: { Authorization: "Bearer t" } });
	assert.deepEqual(seen, { "api.test": "Bearer t", "other.test": undefined });
});

test("bodies over the cap are refused", async () => {
	const { fetcher } = fakeFetch(() => new Response("x".repeat(2000)));
	await assert.rejects(get("https://e.test/", { fetcher, maxBytes: 1000 }), /larger than/);
	const rate = fakeFetch(() => new Response("slow down", { status: 429 }));
	await assert.rejects(get("https://e.test/", { fetcher: rate.fetcher }), /rate limited/);
});
