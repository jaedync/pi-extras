import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../lib/ansi.ts";
import { PROVIDERS, barGradient, cacheState, contextBar, fadeFg, formatTokens, limitText, mixRgb, providerTag, resetLabel, toneForPct, toneRgb } from "../lib/status-plus-render.ts";

const paint = { fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>` };
const NOON = Date.parse("2026-07-01T17:00:00Z"); // 12:00 Central, a Wednesday

test("cache warmth states drive the clock tone", () => {
	const cache = { ttlMs: 5 * 60_000, warnMs: 4 * 60_000 };
	assert.deepEqual(cacheState(undefined, undefined, NOON, cache), { kind: "none", tone: "dim", label: "no calls yet" });
	assert.deepEqual(cacheState(NOON - 60_000, undefined, NOON, cache), { kind: "warm", tone: "dim", label: "1m warm" });
	assert.deepEqual(cacheState(NOON - 4 * 60_000, undefined, NOON, cache), { kind: "cooling", tone: "warning", label: "4m cooling" });
	assert.deepEqual(cacheState(NOON - 6 * 60_000, undefined, NOON, cache), { kind: "cold", tone: "error", label: "6m cold" });
	assert.deepEqual(cacheState(NOON - 60_000, NOON - 30_000, NOON, cache), { kind: "new-ctx", tone: "dim", label: "new ctx" });
});

test("context bar fills twenty cells with eighth-block precision", () => {
	const plain = { fg: (_tone: string, text: string) => text };
	assert.equal(stripAnsi(contextBar(plain, 0)), "░".repeat(20));
	assert.equal(stripAnsi(contextBar(plain, 100)), "█".repeat(20));
	const half = stripAnsi(contextBar(plain, 52.5));
	assert.equal(half.length, 20);
	assert.equal(half.slice(0, 10), "█".repeat(10));
	assert.equal(half[10], "▌");
	assert.equal(half.slice(11), "░".repeat(9));
});

test("context bar is a green-to-red truecolor gradient like the statusline", () => {
	const grad = barGradient(20);
	assert.equal(grad.length, 20);
	// Green end: green dominates; red end: red dominates. The sweep is muted,
	// so dominance is a clear margin rather than a saturated one. Every filled
	// colour is brighter than its empty twin (same hue, lower lightness).
	assert.ok(grad[0].bright.g > grad[0].bright.r * 1.3, JSON.stringify(grad[0]));
	assert.ok(grad[19].bright.r > grad[19].bright.g * 1.3, JSON.stringify(grad[19]));
	for (const { bright, dim } of grad) {
		assert.ok(bright.r + bright.g + bright.b > dim.r + dim.g + dim.b + 100);
		for (const c of [bright.r, bright.g, bright.b, dim.r, dim.g, dim.b]) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255);
	}
	// Hue moves monotonically: red share never decreases along the bar.
	for (let i = 1; i < 20; i++) assert.ok(grad[i].bright.r >= grad[i - 1].bright.r - 1, `cell ${i}`);

	const plain = { fg: (_tone: string, text: string) => text };
	const bar = contextBar(plain, 52.5);
	const sgr = bar.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
	assert.equal(sgr.length, 20, "one truecolor escape per cell");
	// Filled cells wear the bright colour, empty cells the dim one, and the
	// bar hands the foreground back to the theme when it ends.
	assert.ok(bar.startsWith(`\x1b[38;2;${grad[0].bright.r};${grad[0].bright.g};${grad[0].bright.b}m█`), JSON.stringify(bar.slice(0, 30)));
	assert.ok(bar.includes(`\x1b[38;2;${grad[19].dim.r};${grad[19].dim.g};${grad[19].dim.b}m░\x1b[39m`), JSON.stringify(bar.slice(-40)));
	assert.ok(bar.endsWith("\x1b[39m"));
});

test("limit entries render as label plus value with pressure tones", () => {
	assert.equal(limitText(paint, { label: "5h", usedPct: 47 }, NOON), "<dim>5h 47%</dim>");
	assert.equal(limitText(paint, { label: "7d", usedPct: 78 }, NOON), "<warning>7d 78%</warning>");
	assert.equal(limitText(paint, { label: "5h", usedPct: 100 }, NOON), "<error>5h 100%</error>");
	assert.equal(limitText(paint, { label: "", remainingText: "$87/$100" }, NOON), "<dim>$87/$100 left</dim>");
	assert.equal(limitText(paint, { label: "", remainingText: "$4.20 credits left" }, NOON), "<dim>$4.20 credits left</dim>");
	assert.equal(toneForPct(69), "dim");
	assert.equal(toneForPct(70), "warning");
	assert.equal(toneForPct(90), "error");
});

test("reset labels include the exact Central time for distant dates", () => {
	assert.equal(resetLabel(NOON + 3 * 3_600_000, NOON), "3pm");
	assert.equal(resetLabel(NOON + 5 * 3_600_000 + 12 * 60_000, NOON), "5:12pm");
	assert.equal(resetLabel(NOON + 26 * 3_600_000, NOON), "Thu 2pm");
	assert.equal(resetLabel(NOON + 4 * 86_400_000 + 8 * 3_600_000 + 47 * 60_000, NOON), "Sun 8:47pm");
	assert.equal(resetLabel(Date.parse("2026-10-01T00:00:00Z"), NOON), "9/30 7:00pm");
	assert.equal(resetLabel(Date.parse("2026-10-01T00:00:00Z"), NOON, true), "~9/30 7:00pm");
});

test("token counts and provider tags", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(48_200), "48k");
	assert.equal(formatTokens(1_234_567), "1.2M");
	assert.equal(stripAnsi(providerTag(paint, "anthropic")), "Ant");
	assert.equal(providerTag(paint, "kimi-coding"), "<dim>kimi-coding</dim>");
});

test("tone colours are read back from the painter and blended in linear light", () => {
	const real = {
		fg: (tone: string, text: string) =>
			tone === "hot" ? `\x1b[38;2;255;0;0m${text}\x1b[39m`
			: tone === "idx" ? `\x1b[38;5;196m${text}\x1b[39m`
			: tone === "grey" ? `\x1b[38;5;244m${text}\x1b[39m`
			: text,
	};
	assert.deepEqual(toneRgb(real, "hot"), [255, 0, 0]);
	assert.deepEqual(toneRgb(real, "idx"), [255, 0, 0], "cube index 196 is pure red");
	assert.deepEqual(toneRgb(real, "grey"), [128, 128, 128], "grey ramp");
	assert.equal(toneRgb(real, "plain"), undefined, "default colour is unknowable");
	assert.equal(toneRgb(paint, "error"), undefined, "tagging stub exposes nothing");

	assert.deepEqual(mixRgb([0, 0, 0], [255, 255, 255], 0), [0, 0, 0]);
	assert.deepEqual(mixRgb([0, 0, 0], [255, 255, 255], 1), [255, 255, 255]);
	const mid = mixRgb([0, 0, 0], [255, 255, 255], 0.5);
	assert.ok(mid[0] > 170 && mid[0] < 195, `linear-light midpoint is brighter than 128: ${mid}`);

	// Full and zero intensity use the painter's own tones; in between, a truecolor blend.
	assert.equal(fadeFg(real, "hot", "plain", 1, "x"), `\x1b[38;2;255;0;0mx\x1b[39m`);
	assert.equal(fadeFg(real, "hot", "plain", 0, "x"), "x");
	assert.equal(fadeFg(real, "hot", "plain", 0.5, "x"), `\x1b[38;2;255;0;0mx\x1b[39m`, "unknown rest colour steps at the midpoint");
	assert.equal(fadeFg(real, "hot", "plain", 0.4, "x"), "x");
	assert.match(fadeFg(real, "hot", "grey", 0.5, "x"), /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[39m$/);
	assert.equal(fadeFg(paint, "error", "text", 0.7, "x"), "<error>x</error>");
	assert.equal(fadeFg(paint, "error", "text", 0.3, "x"), "<text>x</text>");
});

test("provider colours keep distinct hues at a muted, uniform weight", () => {
	const entries = Object.entries(PROVIDERS);
	assert.ok(entries.length >= 5);
	for (const [id, { color }] of entries) {
		const [r, g, b] = color;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		// No channel pinned to the rails: that is what made the old tags glow.
		assert.ok(max <= 235 && min >= 60, `${id} ${JSON.stringify(color)}`);
		// Still visibly coloured, not gray.
		assert.ok(max - min >= 40, `${id} ${JSON.stringify(color)}`);
	}
	// Sanity on hue identity: Ant warm, Cdx cool, Go teal.
	assert.ok(PROVIDERS.anthropic.color[0] > PROVIDERS.anthropic.color[2]);
	assert.ok(PROVIDERS["openai-codex"].color[2] > PROVIDERS["openai-codex"].color[0]);
	assert.ok(PROVIDERS["opencode-go"].color[1] > PROVIDERS["opencode-go"].color[0] && PROVIDERS["opencode-go"].color[2] > PROVIDERS["opencode-go"].color[0]);
	assert.equal(stripAnsi(providerTag(paint, "openai-codex")), "Cdx");
});
