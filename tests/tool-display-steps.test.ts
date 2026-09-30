import assert from "node:assert/strict";
import test from "node:test";
import { parseAnsiColor, type Rgb } from "../lib/band/color.ts";
import { paletteFrom } from "../lib/band/palette.ts";
import { ChainRun } from "../lib/chain/run.ts";
import { splitChain } from "../lib/chain/split.ts";
import { bashRenderers } from "../lib/tool-display/shell.ts";
import { breath, BREATH_MS, flashing, STEP_FLASH_MS, stepFlash, stepLine } from "../lib/tool-display/steps.ts";
import { harness, row, text, theme } from "./support/tool-rows.ts";

const palette = paletteFrom(theme)!;
const COMMAND = "npm run lint && npm test && npm run build";

/** The background `piece` is drawn on, the last one set before it; undefined for the terminal's own. */
function bgOf(raw: string, piece: string): Rgb | undefined {
	const at = raw.indexOf(piece);
	assert.ok(at >= 0, `${piece} is drawn`);
	const last = [...raw.slice(0, at).matchAll(/\x1b\[(?:48;[\d;]+|49)m/g)].at(-1)?.[0];
	return last ? parseAnsiColor(last) : undefined;
}

/** How far `color` sits from the body gray toward `toward`, as a share of the whole way. */
function lean(color: Rgb | undefined, toward: Rgb): number {
	if (!color) return 0;
	const spread = [0, 1, 2].map((index) => toward[index]! - palette.base[index]!);
	const axis = spread.findIndex((value) => Math.abs(value) === Math.max(...spread.map(Math.abs)));
	return (color[axis]! - palette.base[axis]!) / spread[axis]!;
}

function started() {
	const h = harness();
	const run = new ChainRun(splitChain(COMMAND)!, h.now());
	h.runs.set("call-1", run);
	const line = (index: number, motion: "full" | "reduced" = "full") =>
		stepLine(theme, run.chain, run, index, index + 1, 70, { indent: 3, now: h.now(), motion });
	return { h, run, line };
}

test("a breath rises from rest to its top and back; a flash rises fast and fades to nothing", () => {
	assert.equal(breath(0), 0);
	assert.ok(Math.abs(breath(BREATH_MS / 2) - 1) < 1e-9);
	assert.ok(breath(BREATH_MS) < 1e-9);
	assert.equal(stepFlash(0), 0);
	assert.equal(stepFlash(120), 1);
	assert.ok(stepFlash(400) > stepFlash(800) && stepFlash(800) > 0);
	assert.equal(stepFlash(STEP_FLASH_MS), 0);
	assert.equal(stepFlash(-5), 0);
	assert.equal(stepFlash(Number.NaN), 0);
});

test("the running step's whole line breathes toward the accent", () => {
	const { h, run, line } = started();
	run.mark({ kind: "start", step: 0 }, h.now());
	const rest = lean(bgOf(line(0), "npm run lint"), palette.accent);
	h.advance(BREATH_MS / 2);
	const top = lean(bgOf(line(0), "npm run lint"), palette.accent);
	assert.ok(rest > 0.02 && rest < 0.05, `at rest ${rest}`);
	assert.ok(top > 0.08 && top < 0.12, `at the top ${top}`);
	assert.equal(bgOf(line(1), "npm test"), undefined, "a waiting step stays on the body");
	const steady = [line(0, "reduced"), (h.advance(400), line(0, "reduced"))].map((raw) => bgOf(raw, "npm run lint"));
	assert.deepEqual(steady[0], steady[1], "reduced motion holds one tint");
});

test("a finished step flashes its outcome's hue and fades back, one after another", () => {
	const { h, run, line } = started();
	run.mark({ kind: "start", step: 0 }, h.now());
	h.advance(300);
	run.mark({ kind: "end", step: 0, code: 0 }, h.now());
	run.mark({ kind: "start", step: 1 }, h.now());
	h.advance(150);
	const peak = lean(bgOf(line(0), "npm run lint"), palette.success);
	assert.ok(peak > 0.2, `the flash peaks toward green (${peak})`);
	h.advance(250);
	run.mark({ kind: "end", step: 1, code: 1 }, h.now());
	run.finish("fail", h.now());
	h.advance(150);
	const first = lean(bgOf(line(0), "npm run lint"), palette.success);
	const second = lean(bgOf(line(1), "npm test"), palette.error);
	assert.ok(first > 0 && first < peak, "the first step is fading");
	assert.ok(second > first, "the second step flashes red after it");
	assert.equal(bgOf(line(1, "reduced"), "npm test"), undefined, "reduced motion has no flash");
	assert.ok(flashing(run, h.now()));
	h.advance(STEP_FLASH_MS);
	assert.equal(bgOf(line(0), "npm run lint"), undefined);
	assert.equal(bgOf(line(1), "npm test"), undefined);
	assert.equal(flashing(run, h.now()), false);
});

test("a step a timeout cut off flashes from the chain's end; a saved run never moves", () => {
	const { h, run, line } = started();
	run.mark({ kind: "start", step: 0 }, h.now());
	h.advance(500);
	run.finish("timeout", h.now());
	h.advance(150);
	assert.ok(lean(bgOf(line(0), "npm run lint"), palette.warning) > 0.2);
	const saved = ChainRun.restore(run.chain, run.save("call-1"))!;
	const drawn = stepLine(theme, saved.chain, saved, 0, 1, 70, { indent: 3, now: saved.endedAt!, motion: "full" });
	assert.equal(bgOf(drawn, "npm run lint"), undefined);
	assert.equal(flashing(saved, saved.endedAt!), false);
});

test("the row keeps its frames after the call ends until the last flash has faded", () => {
	const h = harness();
	const run = new ChainRun(splitChain("true && true")!, h.now());
	h.runs.set("call-1", run);
	const bash = row(bashRenderers(h.kit), { command: "true && true" });
	bash.update({ executionStarted: true });
	for (const step of [0, 1]) {
		run.mark({ kind: "start", step }, h.now());
		h.advance(20);
		run.mark({ kind: "end", step, code: 0 }, h.now());
	}
	run.finish("ok", h.now());
	bash.update({ executionStarted: true, isPartial: false, result: text("") });
	bash.raw();
	h.advance(900);
	h.tick();
	bash.raw();
	assert.ok(h.running(), "still flashing after the band settled");
	h.advance(STEP_FLASH_MS);
	h.tick();
	bash.raw();
	assert.equal(h.running(), false, "frames stop once every flash is gone");
});
