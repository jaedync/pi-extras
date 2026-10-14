import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../lib/link-context/config.ts";
import { registerLinkTool } from "../lib/link-context/index.ts";
import type { PullDeps } from "../lib/link-context/pull.ts";
import { cacheKey, createReader } from "../lib/link-context/reader.ts";
import type { Pulled } from "../lib/link-context/types.ts";
import { fakeFetch, html } from "./support/link-fetch.ts";

type Tool = { execute: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[]; details: Record<string, unknown> }> };

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
	const result = await toolWith(reader).execute("id", { url: "https://e.test/page" }, undefined, undefined);
	assert.equal(result.details.cached, true);
	assert.equal(calls.length, 1);
	assert.equal(cacheKey({ url: "u" }), cacheKey({ url: "u", offset: 12_000 }));
});
