/**
 * Live checks of the X and Bluesky conversation reads against the public
 * APIs. Off by default: they need the network and depend on posts that their
 * authors can delete. Run with `npm run test:live-links`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pullBluesky } from "../lib/link-context/adapters/bluesky.ts";
import { pullX } from "../lib/link-context/adapters/x.ts";
import { parseConfig } from "../lib/link-context/config.ts";
import type { AdapterContext } from "../lib/link-context/types.ts";

const skip = process.env.PI_EXTRAS_LIVE_LINKS !== "1" && "set PI_EXTRAS_LIVE_LINKS=1 to read the public APIs";
const whole = (): AdapterContext => ({ config: parseConfig({}), options: { comments: 2000, quotes: 1000, transcript: false, frames: 0, images: false }, progress: () => {} });

test("live X: replies, nested replies, quote posts and the quote chain of a small post", { skip, timeout: 120_000 }, async () => {
	const pulled = await pullX("2114579807577194499", whole());
	assert.doesNotMatch(pulled.markdown, /could not be read \(/, "the v2 API answered");
	assert.match(pulled.markdown, /## Replies \(\d+\)/);
	assert.match(pulled.markdown, /^ {2}- \*\*/m, "a nested reply");
	assert.match(pulled.markdown, /## Quote posts \(\d+/);
	assert.match(pulled.markdown, /Quoted post:\n>[\s\S]*> Quoted post:/, "two levels of quoted posts");
});

test("live X: a reply deep in a self-thread gets every post above it, in order", { skip, timeout: 120_000 }, async () => {
	const pulled = await pullX("2112689291570938255", whole());
	const ids = [...pulled.markdown.slice(0, pulled.markdown.indexOf("## Post")).matchAll(/status\/(\d+)/g)].map((match) => match[1]);
	assert.deepEqual(ids, ["2112630778068881543", "2112631208580645130", "2112632287250743641", "2112657717227843942"]);
});

test("live Bluesky: the reply tree and the quote posts", { skip, timeout: 120_000 }, async () => {
	const pulled = await pullBluesky("bsky.app", "3l6oveex3ii2l", whole());
	assert.match(pulled.markdown, /## Replies \(\d+/);
	assert.match(pulled.markdown, /## Quote posts \(\d+/);
	assert.doesNotMatch(pulled.markdown, /could not be read/);
});
