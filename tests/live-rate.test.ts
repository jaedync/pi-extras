import assert from "node:assert/strict";
import test from "node:test";
import { emptyLiveRate, liveTokensPerSecond, noteArrival, type LiveRate } from "../lib/live-rate.ts";

const stream = (rate: LiveRate, from: number, to: number, everyMs: number, chars: number): LiveRate => {
	let next = rate;
	for (let at = from; at <= to; at += everyMs) next = noteArrival(next, at, chars);
	return next;
};
const near = (actual: number | undefined, expected: number) =>
	assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.01, `${actual} is not ${expected}`);

test("a steady stream reads as the tokens of the latest second", () => {
	// 12 characters every 20 ms is 600 characters, 150 tokens, a second.
	near(liveTokensPerSecond(stream(emptyLiveRate(0), 1000, 3000, 20, 12), 3000), 150);
});

test("the rate follows the stream at once, down as well as up", () => {
	const fast = stream(emptyLiveRate(0), 1000, 3000, 20, 12);
	// Half a second after it slows, the latest second holds half of each pace.
	near(liveTokensPerSecond(stream(fast, 3100, 3500, 100, 12), 3500), 90);
	near(liveTokensPerSecond(stream(fast, 3100, 4000, 100, 12), 4000), 30);
});

test("a second without tokens has no live rate, so the divider can show the average", () => {
	const rate = stream(emptyLiveRate(0), 1000, 2000, 20, 12);
	assert.notEqual(liveTokensPerSecond(rate, 2999), undefined);
	assert.equal(liveTokensPerSecond(rate, 3000), undefined);
	assert.equal(liveTokensPerSecond(undefined, 3000), undefined);
});

test("a tool call the provider held back counts as if it came during the silence before it", () => {
	// Thinking streams until 1 s; the whole 2,000-character call comes at 5 s. A quarter of its 500 tokens fall in the latest second.
	near(liveTokensPerSecond(noteArrival(stream(emptyLiveRate(0), 200, 1000, 20, 12), 5000, 2000), 5000), 125);
});

test("the first tokens of a request count from the request's start", () => {
	// A gateway that holds the arguments sends them as the first content, 5 s after the request: 500 tokens over 5 s.
	near(liveTokensPerSecond(noteArrival(emptyLiveRate(0), 5000, 2000), 5000), 100);
});

test("empty and out-of-order arrivals change nothing", () => {
	const rate = stream(emptyLiveRate(0), 1000, 2000, 20, 12);
	assert.equal(noteArrival(rate, 2000, 0), rate);
	assert.equal(noteArrival(rate, 1500, 12), rate);
});
