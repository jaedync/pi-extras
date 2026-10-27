import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../lib/link-context/config.ts";
import { registerLinkTool } from "../lib/link-context/index.ts";
import type { PullDeps } from "../lib/link-context/pull.ts";
import { cacheKey, createReader } from "../lib/link-context/reader.ts";
import type { Pulled } from "../lib/link-context/types.ts";
import { MAX_IMAGE_BYTES, UNLOADABLE_IMAGE } from "../lib/link-context/media/images.ts";
import { sniffImage } from "../lib/link-context/media/image-bytes.ts";
import { png, pngClaiming } from "./support/image-bytes.ts";
import { fakeFetch, html } from "./support/link-fetch.ts";

type Tool = { description: string; execute: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[]; details: Record<string, unknown> }> };

const noImages: PullDeps["images"] = async () => [];

function gate<T>(): { promise: Promise<T>; open: (value: T) => void; fail: (error: Error) => void } {
	let open!: (value: T) => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<T>((resolve, reject) => { open = resolve; fail = reject; });
	return { promise, open, fail };
}

function toolWith(reader: ReturnType<typeof createReader>): Tool {
	const tools: Tool[] = [];
	registerLinkTool({ registerTool: (tool: never) => tools.push(tool) } as never, { reader });
	return tools[0];
}

test("a pull_link call for a link in flight waits for that read and uses its result", async () => {
	const page = gate<Response>();
	let fetches = 0;
	const slow = (async () => { fetches++; return page.promise; }) as typeof fetch;
	const reader = createReader({ fetcher: slow, config: () => parseConfig({}), deps: { video: async () => { throw new Error("no video"); }, images: noImages } });
	const background = reader.readPlain("https://e.test/slow", new AbortController().signal);
	const progress: string[] = [];
	const asked = reader.read({ url: "https://e.test/slow" }, undefined, (text) => progress.push(text));
	await new Promise((resolve) => setImmediate(resolve));
	page.open(new Response("<title>Slow</title><article><p>done</p></article>", { headers: { "content-type": "text/html" } }));
	const [first, second] = await Promise.all([background, asked]);
	assert.equal(fetches, 1, "one read serves both");
	assert.equal(second.pulled, first.pulled);
	assert.equal(second.cached, true);
	assert.match(progress.join(" "), /already/);
	assert.equal((await reader.read({ url: "https://e.test/slow", offset: 10 }, undefined, () => {})).cached, true, "the finished read is kept under the plain call's key");
});

test("a waiting pull_link call stops when its own call is aborted, and the read goes on", async () => {
	const page = gate<Response>();
	const reader = createReader({ fetcher: (async () => page.promise) as typeof fetch, config: () => parseConfig({}), deps: { video: async () => { throw new Error("no"); }, images: noImages } });
	const background = reader.readPlain("https://e.test/a", new AbortController().signal);
	const stop = new AbortController();
	const asked = reader.read({ url: "https://e.test/a" }, stop.signal, () => {});
	stop.abort(new Error("call aborted"));
	await assert.rejects(asked, /call aborted/);
	page.open(new Response("<title>A</title><p>text</p>", { headers: { "content-type": "text/html" } }));
	assert.equal((await background).pulled.title, "A");
});

test("a failed read in flight leaves the pull_link call to read the link itself", async () => {
	let up = false;
	const fetcher = (async () => (up ? new Response("<title>Back</title><p>x</p>", { headers: { "content-type": "text/html" } }) : new Response("gone", { status: 500 }))) as typeof fetch;
	const reader = createReader({ fetcher, config: () => parseConfig({}), deps: { video: async () => { throw new Error("no"); }, images: noImages } });
	const background = reader.readPlain("https://e.test/b", new AbortController().signal);
	// The site is back by the time the waiting call reads the link itself.
	background.catch(() => { up = true; });
	const asked = reader.read({ url: "https://e.test/b" }, undefined, () => {});
	await assert.rejects(background);
	const result = await asked;
	assert.equal(result.pulled.title, "Back");
	assert.equal(result.cached, false);
});

test("a captions-only video is kept apart from what a default pull_link call returns", async () => {
	const seen: { speech?: boolean }[] = [];
	const video: PullDeps["video"] = async (url, site, ctx) => {
		seen.push({ speech: ctx.options.speech });
		const skipped = ctx.options.speech === false;
		return { platform: site, title: "V", url, markdown: skipped ? "# V\n\nNo transcript" : "# V\n\n[0:01] Spoken.", ...(skipped ? { speechSkipped: true } : {}) } satisfies Pulled;
	};
	const reader = createReader({ config: () => parseConfig({}), deps: { video, images: noImages } });
	const url = "https://www.youtube.com/watch?v=abcdefghijk";
	const auto = await reader.readPlain(url, new AbortController().signal);
	assert.equal(auto.pulled.speechSkipped, true);
	assert.equal((await reader.readPlain(url, new AbortController().signal)).cached, true, "a second auto read uses the captions-only result");
	const asked = await reader.read({ url }, undefined, () => {});
	assert.equal(asked.cached, false);
	assert.match(asked.pulled.markdown, /Spoken/);
	assert.deepEqual(seen, [{ speech: false }, { speech: undefined }]);
	assert.equal((await reader.readPlain(url, new AbortController().signal)).pulled, asked.pulled, "the full result then serves auto-pull too");
});

test("a captions-only read in flight does not answer a pull_link call", async () => {
	const done = gate<void>();
	const video: PullDeps["video"] = async (url, site, ctx) => {
		if (ctx.options.speech === false) { await done.promise; return { platform: site, title: "V", url, markdown: "none", speechSkipped: true }; }
		return { platform: site, title: "V", url, markdown: "spoken" };
	};
	const reader = createReader({ config: () => parseConfig({}), deps: { video, images: noImages } });
	const url = "https://vimeo.com/42";
	const auto = reader.readPlain(url, new AbortController().signal);
	const asked = reader.read({ url }, undefined, () => {});
	done.open();
	await auto;
	assert.equal((await asked).pulled.markdown, "spoken");
});

test("a read that ends after its abort is not kept", async () => {
	const stop = new AbortController();
	const video: PullDeps["video"] = async (url, site) => { stop.abort(); return { platform: site, title: "V", url, markdown: "partial" }; };
	const reader = createReader({ config: () => parseConfig({}), deps: { video, images: noImages } });
	await assert.rejects(reader.readPlain("https://vimeo.com/7", stop.signal));
	const again = await reader.read({ url: "https://vimeo.com/7" }, undefined, () => {});
	assert.equal(again.cached, false);
});

test("the tool goes through the shared reader", async () => {
	const { fetcher, calls } = fakeFetch(html("e.test/page", "<title>Page</title><article><p>words</p></article>"));
	const reader = createReader({ fetcher, config: () => parseConfig({}), deps: { video: async () => { throw new Error("no"); }, images: noImages } });
	await reader.readPlain("https://e.test/page", new AbortController().signal);
	const tool = toolWith(reader);
	assert.match(tool.description, /Links in the user's messages are usually read already: a message next to the user's message that starts with "Pull Link read"/);
	const result = await tool.execute("id", { url: "https://e.test/page" }, undefined, undefined);
	assert.equal(result.details.cached, true);
	assert.equal(calls.length, 1);
	assert.equal(cacheKey({ url: "u" }), cacheKey({ url: "u", offset: 12_000 }));
});

test("two pull_link calls waiting on a captions-only read start one full read between them", async () => {
	const done = gate<void>();
	let full = 0;
	const video: PullDeps["video"] = async (url, site, ctx) => {
		if (ctx.options.speech === false) { await done.promise; return { platform: site, title: "V", url, markdown: "none", speechSkipped: true }; }
		full++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { platform: site, title: "V", url, markdown: "spoken" };
	};
	const reader = createReader({ config: () => parseConfig({}), deps: { video, images: noImages } });
	const url = "https://vimeo.com/43";
	const auto = reader.readPlain(url, new AbortController().signal);
	const first = reader.read({ url }, undefined, () => {});
	const second = reader.read({ url }, undefined, () => {});
	done.open();
	await auto;
	const [a, b] = await Promise.all([first, second]);
	assert.equal(full, 1, "speech-to-text runs once");
	assert.equal(a.pulled, b.pulled);
});

test("an X conversation that auto-pull's time limit cut short is kept apart; a pull_link call reads it in full", async () => {
	const status = { id: "1", text: "post", author: { name: "op", screen_name: "op" }, replies: 1 };
	const replies = [{ id: "2", text: "reply", author: { name: "r", screen_name: "r" }, replies: 2, replying_to: { status: "1" } }];
	let slow = true;
	const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		if (url.endsWith("/2/conversation/1")) return Response.json({ code: 200, status, thread: [status], replies });
		if (slow) return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
		return Response.json({ code: 200, status: replies[0], thread: [], replies: [{ id: "3", text: "nested", author: { name: "n", screen_name: "n" }, replying_to: { status: "2" } }] });
	}) as typeof fetch;
	const reader = createReader({ fetcher, config: () => parseConfig({}), autoReadMs: 30 });
	const url = "https://x.com/op/status/1";
	const auto = await reader.readPlain(url, new AbortController().signal);
	assert.equal(auto.pulled.timeLimited, true);
	assert.equal((await reader.readPlain(url, new AbortController().signal)).cached, true, "a second auto read uses the short result");
	slow = false;
	const asked = await reader.read({ url }, undefined, () => {});
	assert.equal(asked.cached, false);
	assert.match(asked.pulled.markdown, /nested/);
	assert.equal(asked.pulled.timeLimited, undefined);
});

/** A real 3x2 JPEG, so Pi's image library can decode it. */
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==", "base64");

/** Download links whose path has no file extension; only the content-type says what they are. */
function downloads() {
	const bodies: Record<string, [Buffer, string]> = {
		"/photo": [JPEG, "image/jpeg"],
		"/wide": [png(3000, 10), "image/png"],
		"/huge": [Buffer.concat([png(2, 2), Buffer.alloc(MAX_IMAGE_BYTES)]), "image/png"],
		"/doc": [Buffer.from("%PDF-1.7"), "application/pdf"],
		"/octet": [png(4, 4), "application/octet-stream"],
		"/unlabelled": [png(4, 4), ""],
		"/signed": [png(4, 4), "image/png"],
		"/drawing": [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>Logo</title><text>hello</text></svg>'), "image/svg+xml"],
		"/denied": [Buffer.from("<html><body>Access denied</body></html>"), "image/png"],
		"/bomb": [pngClaiming(20_000, 20_000), "image/png"],
	};
	return fakeFetch(
		(url) => (new URL(url).pathname === "/redirect" ? new Response(null, { status: 302, headers: { location: "https://e.test/signed?X-Amz-Signature=SECRET123" } }) : undefined),
		(url) => {
			const found = bodies[new URL(url).pathname];
			if (!found) return undefined;
			const response = new Response(new Uint8Array(found[0]));
			if (found[1]) response.headers.set("content-type", found[1]);
			else response.headers.delete("content-type");
			return response;
		},
	);
}

test("a direct image link without a file extension is the image, read once, in auto-pull and in pull_link", async () => {
	const { fetcher, calls } = downloads();
	const reader = createReader({ fetcher, config: () => parseConfig({}) });
	const photo = (await reader.readPlain("https://e.test/photo?key=k", new AbortController().signal)).pulled;
	assert.equal(photo.platform, "image");
	assert.deepEqual(photo.images?.map((image) => image.mimeType), ["image/jpeg"]);
	assert.equal(calls.length, 1, "the page read's bytes are the image; it is not downloaded again");
	const wide = (await reader.read({ url: "https://e.test/wide" }, undefined, () => {})).pulled;
	assert.equal(wide.images?.length, 1);
	const size = sniffImage(Buffer.from(wide.images?.[0].data ?? "", "base64"));
	assert.ok(size && size.width <= 2000, `scaled down as other images are: ${JSON.stringify(size)}`);
});

test("an extension-less image with images: false is a short note, not an error", async () => {
	const { fetcher } = downloads();
	const reader = createReader({ fetcher, config: () => parseConfig({}) });
	const { pulled } = await reader.read({ url: "https://e.test/photo", images: false }, undefined, () => {});
	assert.equal(pulled.images, undefined);
	assert.match(pulled.markdown, /image/i);
	assert.doesNotMatch(pulled.markdown, /fetch_content/);
});

test("an extension-less image over the size limit fails as a direct image link does; a PDF still points to fetch_content", async () => {
	const { fetcher } = downloads();
	const reader = createReader({ fetcher, config: () => parseConfig({}) });
	await assert.rejects(reader.readPlain("https://e.test/huge", new AbortController().signal), /could not be loaded: it is missing, too large/);
	await assert.rejects(reader.readPlain("https://e.test/doc", new AbortController().signal), /application\/pdf, not a page\. Use fetch_content for PDFs and documents\./);
});

test("an image sent as application/octet-stream or with no content-type is the image when its bytes say so", async () => {
	const { fetcher } = downloads();
	const reader = createReader({ fetcher, config: () => parseConfig({}) });
	for (const path of ["/octet", "/unlabelled"]) {
		const { pulled } = await reader.read({ url: `https://e.test${path}` }, undefined, () => {});
		assert.equal(pulled.platform, "image", path);
		assert.deepEqual(pulled.images?.map((image) => image.mimeType), ["image/png"], path);
	}
});

test("an image behind a redirect keeps the link that was given, not the signed target", async () => {
	const { fetcher } = downloads();
	const reader = createReader({ fetcher, config: () => parseConfig({}) });
	const { pulled } = await reader.read({ url: "https://e.test/redirect" }, undefined, () => {});
	assert.equal(pulled.images?.length, 1);
	assert.doesNotMatch(JSON.stringify({ ...pulled, images: [] }), /SECRET123/);
	assert.equal(pulled.url, "https://e.test/redirect");
});

test("SVG stays a page; a fake or oversized image behind an image content-type is not sent", async () => {
	const { fetcher } = downloads();
	const reader = createReader({ fetcher, config: () => parseConfig({}) });
	const svg = (await reader.read({ url: "https://e.test/drawing" }, undefined, () => {})).pulled;
	assert.equal(svg.platform, "web");
	assert.equal(svg.title, "Logo", "read as XML text, as before");
	assert.equal(svg.images, undefined);
	const unloadable = new RegExp(UNLOADABLE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	await assert.rejects(reader.read({ url: "https://e.test/denied" }, undefined, () => {}), unloadable);
	await assert.rejects(reader.read({ url: "https://e.test/bomb" }, undefined, () => {}), unloadable);
});
