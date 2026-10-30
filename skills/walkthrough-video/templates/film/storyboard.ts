/**
 * The one source of timing. Shot lengths are in beats (bpm 120: a beat is
 * 0.5 s, a bar 2 s), so the cuts land on the music. Event times are seconds
 * from the shot start. Change a value here, then run `wv film build`.
 *
 * This is a starting skeleton, not a film: replace the shots with yours.
 */
import type { Storyboard } from "./kit/types.ts";

export default {
	title: "Product film",
	fps: 60,
	width: 1920,
	height: 1080,
	bpm: 120,
	shots: [
		{ id: "hook", scene: "claim", beats: 4, what: "the promise in five words", text: "Say the promise here" },
		{ id: "proof", scene: "product", beats: 4, what: "the product keeps the promise", title: "Your product", rows: ["First thing", "Second thing", "Third thing"], first: 0.25, step: 0.3 },
		{ id: "claim", scene: "claim", beats: 4, what: "the second claim", text: "Then the second claim" },
		{ id: "end", scene: "end", beats: 6, what: "end card", wordmark: "Product", tagline: "What it is, in a line", url: "product.example", fade: 0.4, holds: [[2.2, 2.6]] },
	],
	music: { liftAtShot: "end", db: -21, fadeIn: 0.3, fadeOut: 1.4 },
} satisfies Storyboard;
