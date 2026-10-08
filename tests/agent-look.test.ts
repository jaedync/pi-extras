import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AGENT_HUE, AVATAR, agentBody, agentHue, agentLine, doingGlyph, doingOf, spaced } from "../lib/band/agent-look.ts";
import { paintFg } from "../lib/band/band.ts";
import { fgSgr } from "../lib/band/color.ts";
import { OTHER_PROVIDER, providerColor } from "../lib/status-plus-render.ts";
import { MODE_SPINNERS, glyphAt } from "../lib/band/glyph.ts";
import { colorOf } from "./support/tool-rows.ts";
import { fgOf, quiet } from "./support/quiet-theme.ts";

const theme = quiet();
const MAUVE = fgOf("#b294b0");
test("an agent line starts after a two-space margin with compact groups and no rail or background", () => {
	const segs = spaced([{ text: `${AVATAR} file-count`, color: "customMessageLabel", bold: true }], [], [{ text: "25.2s", color: "muted" }]);
	const line = agentLine(theme, segs, 40);
	const plain = stripTerminalSequences(line);
	assert.equal(visibleWidth(plain), 40);
	assert.equal(plain.trimEnd(), `  ${AVATAR} file-count  25.2s`);
	assert.equal(colorOf(line, AVATAR), MAUVE);
	assert.doesNotMatch(line, /\x1b\[48;|▍/);
	assert.deepEqual(spaced([], []), []);
});

test("agent bodies are indented and leave the terminal background untouched", () => {
	const lines = agentBody(theme, 40, "first\nsecond", "customMessageText", null);
	assert.deepEqual(lines.map(stripTerminalSequences), ["    first", "    second"]);
	for (const line of lines) assert.doesNotMatch(line, /\x1b\[48;|▍/);
});

test("a theme without colors still gets the margin and words", () => {
	const bare = { getFgAnsi: () => "", getBgAnsi: () => "", getColorMode: () => "truecolor" as const, fg: (_key: string, text: string) => text, bg: (_key: string, text: string) => text };
	const plain = stripTerminalSequences(agentLine(bare, [{ text: "◆ x", color: "text" }], 30));
	assert.ok(plain.startsWith("  ◆ x"), plain);
});

test("what an agent is doing comes from its state and activity words", () => {
	assert.equal(doingOf({ state: "running", activity: "thinking" }), "thinking");
	assert.equal(doingOf({ state: "running", activity: null }), "thinking");
	assert.equal(doingOf({ state: "running", activity: "writing" }), "writing");
	assert.equal(doingOf({ state: "running", activity: "compacting context" }), "compacting");
	assert.equal(doingOf({ state: "running", activity: "calling a tool" }), "tool");
	assert.equal(doingOf({ state: "running", activity: "bash npm test" }), "tool");
	assert.equal(doingOf({ state: "starting", activity: "starting" }), "starting");
	assert.equal(doingOf({ state: "asking", activity: "asking main" }), "asking");
	assert.equal(doingOf({ state: "waiting", activity: "waiting on its subagents" }), "waiting");
	assert.equal(doingOf({ state: "queued", activity: "queued" }), "queued");
	assert.equal(doingOf({ state: "idle", activity: null }), "done");
	assert.equal(doingOf({ state: "failed", activity: null }), "done");
});

test("an agent moves the way main's spinner does for the same work", () => {
	assert.equal(doingGlyph("thinking", 300).glyph, glyphAt(MODE_SPINNERS.think, 300));
	assert.equal(doingGlyph("writing", 300).glyph, glyphAt(MODE_SPINNERS.text, 300, { rateElapsedMs: 300 }));
	assert.equal(doingGlyph("tool", 300).glyph, glyphAt(MODE_SPINNERS.tool, 300));
	assert.equal(doingGlyph("compacting", 300).glyph, glyphAt(MODE_SPINNERS.compaction, 300));
	assert.equal(doingGlyph("asking", 300).glyph, glyphAt(MODE_SPINNERS.peer, 300));
	// Tool work is drawn in the tool color, the rest in the agent's own.
	assert.equal(doingGlyph("tool", 0).color, "accent");
	assert.equal(doingGlyph("thinking", 0).color, "customMessageLabel");
	assert.equal(doingGlyph("asking", 0).color, "warning");
});

test("glyphs keep a fixed width so the words after them never shift", () => {
	const widths = new Set<number>();
	for (const doing of ["thinking", "writing", "tool", "compacting", "starting", "asking", "waiting", "queued", "done"] as const) {
		for (const ms of [0, 130, 470, 999]) widths.add(visibleWidth(doingGlyph(doing, ms).glyph));
	}
	assert.deepEqual([...widths], [3]);
});

test("reduced motion holds every glyph still", () => {
	assert.equal(doingGlyph("thinking", 0, "reduced").glyph, doingGlyph("thinking", 777, "reduced").glyph);
});

test("an agent takes its provider's identity color from the footer, the shared one for other providers, purple with no provider", () => {
	const hex = (rgb: readonly number[]) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
	assert.equal(agentHue("anthropic/claude-opus-5-5"), hex(providerColor("anthropic")!));
	assert.equal(agentHue("openai-codex/gpt-6-luna"), hex(providerColor("openai-codex")!));
	assert.notEqual(agentHue("anthropic/x"), agentHue("openai-codex/x"));
	assert.equal(agentHue("redarch-lora/qwen3"), hex(OTHER_PROVIDER));
	assert.equal(agentHue("fw01-halogen/halogen-qwen3.8-flash-next"), hex(OTHER_PROVIDER));
	for (const model of [undefined, "", "gpt-6-luna", "/x"]) assert.equal(agentHue(model), AGENT_HUE, String(model));
});

test("a fixed color is set in the terminal's color mode, on a line and in plain text", () => {
	const hue = agentHue("openai-codex/gpt-6-luna");
	const rgb = providerColor("openai-codex")!;
	const segs = [{ text: `${AVATAR} scout`, color: hue, bold: true }];
	assert.equal(colorOf(agentLine(quiet(), segs, 30), AVATAR), fgSgr(rgb, "truecolor"));
	assert.ok(agentLine(quiet("256color"), segs, 30).includes(`${fgSgr(rgb, "256color")}\x1b[1m${AVATAR}`));
	assert.equal(paintFg(quiet("256color"), hue, "x"), `${fgSgr(rgb, "256color")}x\x1b[39m`);
	assert.equal(paintFg(theme, "accent", "x"), theme.fg("accent", "x"));
	assert.equal(paintFg(theme, "no-such-key", "x"), "x");
});

test("thinking, writing and compacting spin in the agent's own color; tool work keeps the tool color", () => {
	const hue = agentHue("anthropic/claude-opus-5-5");
	for (const doing of ["thinking", "writing", "compacting"] as const) assert.equal(doingGlyph(doing, 0, "full", hue).color, hue);
	assert.equal(doingGlyph("thinking", 0).color, AGENT_HUE);
	assert.equal(doingGlyph("tool", 0, "full", hue).color, "accent");
	assert.equal(doingGlyph("asking", 0, "full", hue).color, "warning");
});
