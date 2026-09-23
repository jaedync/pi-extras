import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_COVER_MS, STREAM_FRAME_MS, TAIL_MAX_MS, TranscriptStream } from "../lib/voice/stream.ts";

/** A clock and timer queue that only move when told to. */
function harness() {
	let now = 0;
	let timers: Array<{ at: number; fn: () => void }> = [];
	const pieces: Array<{ at: number; text: string }> = [];
	let doneAt: number | undefined;
	const options = {
		now: () => now,
		schedule: (fn: () => void, ms: number) => {
			const timer = { at: now + ms, fn };
			timers.push(timer);
			return () => (timers = timers.filter((t) => t !== timer));
		},
		emit: (text: string) => pieces.push({ at: now, text }),
		onDone: () => (doneAt = now),
	};
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			timers = timers.filter((t) => t !== next);
			now = next.at;
			next.fn();
		}
		now = end;
	};
	return {
		options,
		advance,
		pieces,
		shown: () => pieces.map((p) => p.text).join(""),
		get doneAt() { return doneAt; },
	};
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("ready text starts at once and finishes around the predicted wait", () => {
	const h = harness();
	const ready = words(60);
	new TranscriptStream(h.options, "", ready, 300);
	assert.ok(h.pieces.length > 0 && h.pieces[0]!.at === 0, "first words appear immediately");
	h.advance(150);
	assert.ok(h.shown().length > ready.length * 0.3 && h.shown().length < ready.length, `about half shown: ${h.shown().length}`);
	h.advance(150 + STREAM_FRAME_MS);
	assert.equal(h.shown(), ready);
	assert.equal(h.doneAt, undefined, "not done until the final text arrives");
});

test("the covered wait is capped", () => {
	const h = harness();
	const ready = words(40);
	new TranscriptStream(h.options, "", ready, 5000);
	h.advance(MAX_COVER_MS + STREAM_FRAME_MS);
	assert.equal(h.shown(), ready);
});

test("text that arrives with the final result finishes within the tail limit", () => {
	const h = harness();
	const stream = new TranscriptStream(h.options, "", "", 300);
	h.advance(80);
	stream.finish("fix the parser bug");
	h.advance(TAIL_MAX_MS + STREAM_FRAME_MS);
	assert.equal(h.shown(), "fix the parser bug");
	assert.ok(h.doneAt! <= 80 + TAIL_MAX_MS + STREAM_FRAME_MS);
	assert.ok(h.doneAt! <= 80 + "fix the parser bug".length * 4 + STREAM_FRAME_MS, "short text is nearly instant");
});

test("an early final speeds up the rest instead of dragging out the prediction", () => {
	const h = harness();
	const ready = words(80);
	const stream = new TranscriptStream(h.options, "", ready, MAX_COVER_MS);
	h.advance(60);
	stream.finish(`${ready} tail words`);
	h.advance(TAIL_MAX_MS + STREAM_FRAME_MS);
	assert.equal(h.shown(), `${ready} tail words`);
	assert.ok(h.doneAt! <= 60 + TAIL_MAX_MS + STREAM_FRAME_MS);
});

test("once caught up it waits for the final text without padding", () => {
	const h = harness();
	const stream = new TranscriptStream(h.options, "", "fix the", 100);
	h.advance(1000);
	assert.equal(h.shown(), "fix the");
	stream.finish("fix the parser");
	h.advance(STREAM_FRAME_MS * 3);
	assert.equal(h.shown(), "fix the parser");
	assert.ok(h.doneAt! - 1000 <= " parser".length * 4 + STREAM_FRAME_MS);
});

test("more ready text mid-stream joins the same flow", () => {
	const h = harness();
	const stream = new TranscriptStream(h.options, "", "one two", 200);
	h.advance(50);
	stream.offer("one two three four");
	h.advance(200);
	assert.equal(h.shown(), "one two three four");
});

test("pieces always end on a word boundary and carry the leading separator", () => {
	const h = harness();
	const stream = new TranscriptStream(h.options, " ", words(30), 200);
	stream.finish(words(30));
	h.advance(1000);
	assert.equal(h.shown(), ` ${words(30)}`);
	let offset = 0;
	for (const piece of h.pieces) {
		offset += piece.text.length;
		const next = h.shown()[offset];
		assert.ok(next === undefined || next === " ", `piece "${piece.text}" splits a word`);
	}
});

test("an empty result finishes with nothing inserted", () => {
	const h = harness();
	const stream = new TranscriptStream(h.options, " ", "", 200);
	stream.finish("   ");
	h.advance(STREAM_FRAME_MS);
	assert.equal(h.pieces.length, 0);
	assert.equal(stream.inserted, false);
	assert.equal(h.doneAt, 0);
});

test("cancel drops whatever has not been inserted yet", () => {
	const h = harness();
	const stream = new TranscriptStream(h.options, "", words(50), 300);
	h.advance(50);
	const before = h.shown();
	stream.cancel();
	h.advance(1000);
	assert.equal(h.shown(), before);
	assert.ok(before.length < words(50).length);
});
