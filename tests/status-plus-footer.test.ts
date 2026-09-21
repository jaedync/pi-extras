import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, visibleWidth } from "../lib/ansi.ts";
import { formatIncrement } from "../lib/status-plus-spend.ts";
import { renderFooter, type FooterModel } from "../lib/status-plus-footer.ts";

const paint = { fg: (_tone: string, text: string) => `\x1b[2m${text}\x1b[22m` };
const NOON = Date.parse("2026-07-01T17:00:00Z"); // 12:00 Central

function model(overrides: Partial<FooterModel> = {}): FooterModel {
	return {
		nowMs: NOON,
		lastApiEndMs: NOON,
		cache: { kind: "warm", tone: "dim", label: "2m warm" },
		context: { usedTokens: 112_000, windowTokens: 272_000, percent: 41.2 },
		modelName: "gpt-5.6-sol",
		thinkingLevel: "high",
		counters: { prompts: 12, turns: 31, toolCalls: 48 },
		cwd: "~/projects/example-app",
		gitBranch: "main",
		sessionName: "e2e",
		tokens: { input: 1_200_000, cacheWrite: 310_000, cacheRead: 9_800_000, output: 48_000 },
		cacheHitPct: 92,
		rows: [
			{ id: "anthropic", cost: 1.84, airtimeMs: 725_000, tokens: { input: 9_400_000, output: 41_000 }, entries: [
				{ label: "5h", usedPct: 47, resetMs: NOON + 3 * 3_600_000 },
				{ label: "7d", usedPct: 12, resetMs: NOON + 3 * 86_400_000 + 12 * 3_600_000 + 47 * 60_000 },
				{ label: "fable", usedPct: 21, resetMs: NOON + 3 * 86_400_000 + 12 * 3_600_000 + 47 * 60_000 },
				{ label: "", remainingText: "$87/$100" },
			] },
			{ id: "openai-codex", cost: 0.62, airtimeMs: 250_000, tokens: { input: 80_000, output: 5_200 }, entries: [
				{ label: "5h", usedPct: 3, resetMs: NOON + 5 * 3_600_000 + 12 * 60_000 },
				{ label: "7d", usedPct: 78, resetMs: NOON + 3 * 86_400_000 },
			] },
			{ id: "openrouter", cost: 0.31, airtimeMs: 40_000, tokens: { input: 12_000, output: 900 }, entries: [{ label: "", remainingText: "$4.20 credits left" }] },
			{ id: "opencode-go", cost: 0.0012, airtimeMs: 62_000, tokens: { input: 6_000, output: 700 }, billingNote: "billing Zen", entries: [
				{ label: "5h", usedPct: 100, exhausted: true, resetMs: NOON + 4 * 3_600_000 },
				{ label: "7d", usedPct: 3 }, { label: "mo", usedPct: 9 },
			] },
			{ id: "opencode", cost: 0.05, airtimeMs: 12_000, tokens: { input: 2_000, output: 200 }, entries: [], note: "balance not exposed by OpenCode" },
			{ id: "kimi-coding", cost: 0, airtimeMs: 90_000, tokens: { input: 0, output: 0 }, entries: [{ label: "5h", usedPct: 50 }] },
		],
		extensionStatuses: [],
		...overrides,
	};
}

function columns(line: string, char = "│"): number[] {
	const plain = stripAnsi(line);
	const out: number[] = [];
	for (let i = 0; i < plain.length; i++) if (plain[i] === char) out.push(i);
	return out;
}

test("wide terminal: two grid lines plus one row per provider with spend", () => {
	const lines = renderFooter(model(), 150, paint);
	const plain = lines.map(stripAnsi);
	assert.equal(plain.length, 7, plain.join("\n"));
	assert.match(plain[0], /^12:00 [█▏▎▍▌▋▊▉░]{20} 112k \/ 272k\s+│ gpt-5\.6-sol high\s+│ \$2\.82 · 19m\s+│ ~\/projects\/example-app \(main\) · e2e$/);
	// Fresh input and cache writes are separate figures (both cost more than reads).
	assert.match(plain[1], /^ +12 prompts · 31 turns · 48 tools\s+│ 1\.2M in · 310k write · 9\.8M read · 48k out\s+│ cache 92% · 2m warm$/);
	// Columns hug their content: one space either side of each separator. The
	// cost cell alone may pad, because line two's token cell spans it.
	assert.ok(plain[0].includes("272k │ gpt-5.6-sol high │ $2.82 · 19m"), plain[0]);
	assert.ok(plain[0].includes("│ ~/projects/example-app (main) · e2e"), plain[0]);
	// Line two's token cell spans the model and cost cells, so it has one
	// separator fewer; the outer two line up with line one's first and last.
	const [c0, , c2] = columns(plain[0]);
	assert.deepEqual(columns(plain[1]), [c0, c2], "grid separators align");
	assert.ok(plain[1].includes("48 tools │ 1.2M in"), plain[1]);
	// Counters end where the context figure above them ends.
	assert.equal(plain[1].indexOf("tools") + "tools".length, plain[0].indexOf("272k") + "272k".length, plain.slice(0, 2).join("\n"));
	// Grid separators line up between the two header lines.
	assert.deepEqual(columns(plain[1]), [columns(plain[0])[0], columns(plain[0])[2]]);
	// Rows: kimi-coding has no spend, so it is absent; order follows provider rank.
	assert.deepEqual(plain.slice(2).map((l) => l.trim().split(/\s+/)[0]), ["Ant", "Cdx", "Ort", "Go", "Zen"]);
	assert.ok(!plain.some((l) => l.includes("kimi")));
	for (const line of lines) assert.ok(visibleWidth(line) <= 150, `too wide: ${stripAnsi(line)}`);
});

test("row columns align with mixed cost and airtime widths", () => {
	const lines = renderFooter(model(), 150, paint).map(stripAnsi).slice(2);
	const seps = lines.map((l) => columns(l));
	for (const s of seps) assert.deepEqual(s.slice(0, 3), seps[0].slice(0, 3), lines.join("\n"));
	// Per-provider tokens sit between the money and the limits.
	assert.ok(lines.some((l) => /Ant\s+\$1\.84 · 12m05s │ 9\.4M in · 41k out\s+│ 5h 47%/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /Cdx\s+\$0\.62 · +4m10s │ 80k in · 5\.2k out\s+│ 5h 3%/.test(l)), lines.join("\n"));
	// Costs are right-aligned: every "$" amount ends at the same column.
	const costEnds = lines.map((l) => l.indexOf(" · ", 0));
	assert.ok(costEnds.every((c) => c === costEnds[0]), lines.join("\n"));
	assert.ok(lines.some((l) => /\$0\.0012 · /.test(l)), "tiny cost keeps its precision");
	assert.ok(lines.some((l) => / \$1\.84 · 12m05s /.test(l)));
	assert.ok(lines.some((l) => /Go\s+\$0\.0012 · +1m02s │ 6\.0k in · 700 out\s+│ 5h 100% · 7d 3% · mo 9%   billing Zen\s+│ 4pm/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /Ant .*│ 5h 47% · 7d 12% · fable 21% · \$87\/\$100 left\s+│ 3pm · Sun 12:47am$/.test(l)), "shared resets said once: " + lines.join("\n"));
	assert.ok(lines.some((l) => /Cdx .*│ 5h 3% · 7d 78%\s+│ 5:12pm · Sat 12pm/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /Zen .*│ balance not exposed by OpenCode\s+│$/.test(l)), lines.join("\n"));
});

test("narrow terminal drops tokens, then resets, then airtime, and never exceeds the width", () => {
	for (const width of [110, 100, 84, 76, 64, 60, 50]) {
		const lines = renderFooter(model(), width, paint);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
	}
	const at100 = renderFooter(model(), 100, paint).map(stripAnsi);
	assert.ok(at100.some((l) => /12 prompts 31 turns 48 tools/.test(l)), "counters never abbreviate");
	assert.match(at100[0], /│ …[a-z/-]* \(main\) e2e$/, "place keeps its tail: " + at100[0]);
	assert.ok(at100[1].endsWith("92% 2m warm"), at100[1]);
	assert.ok(at100.some((l) => l.includes("Sun 12:47am")), "rows still fit with resets at 100");
	assert.ok(at100.some((l) => /9\.4M in 41k out/.test(l)), "rows still carry tokens at 100");
	const at84 = renderFooter(model(), 84, paint).map(stripAnsi);
	assert.ok(at84.some((l) => l.includes("Sun 12:47am")), "removing dots keeps resets longer");
	assert.ok(!at84.some((l) => l.includes("41k out")), "row tokens go before resets");
	const at76 = renderFooter(model(), 76, paint).map(stripAnsi);
	assert.ok(!at76.some((l) => l.includes("Sun 12:47am")), "reset column dropped");
	assert.ok(at76.some((l) => /7d 78% 3d/.test(l)), "hot windows keep an inline countdown");
	const at64 = renderFooter(model(), 64, paint).map(stripAnsi);
	assert.ok(at64.some((l) => l.includes("12m05s")), "removing dots keeps airtime longer");
	const at50 = renderFooter(model(), 50, paint).map(stripAnsi);
	assert.ok(!at50.some((l) => l.includes("12m05s")), "airtime dropped only when necessary");
});

test("clock carries the cache tone and a session with no rows is two lines", () => {
	const toned = { fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>` };
	// The tagging painter inflates visible widths, so give the full grid room.
	const cold = renderFooter(model({ cache: { kind: "cold", tone: "error", label: "6m cold" }, rows: [] }), 400, toned);
	assert.equal(cold.length, 2);
	assert.ok(cold[0].startsWith("<error>12:00</error>"), cold[0]);
	assert.ok(cold[1].endsWith("<error>6m cold</error>"), cold[1]);
	const fresh = renderFooter(model({ cache: { kind: "none", tone: "dim", label: "no calls yet" }, cacheHitPct: undefined, rows: [] }), 400, toned);
	assert.ok(fresh[1].endsWith("<dim>no calls yet</dim>") && !fresh[1].includes("cache"), fresh[1]);
});

test("narrow layouts remove decoration before hiding or combining token classes", () => {
	for (const width of [60, 64, 80, 84, 100, 110]) {
		const lines = renderFooter(model(), width, paint).map(stripAnsi);
		const tokens = lines.find(line => line.includes("310k write"));
		assert.ok(tokens?.includes("1.2M in 310k write 9.8M read 48k out"), `${width}: ${lines.join("\n")}`);
		assert.ok(!lines.some(line => line.includes("1.5M in")), "writes never become input");
		assert.ok(lines.every(line => !line.includes(" · ")), `${width}: no decorative dots`);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
	}
});

test("cache writes stay split when the long model cell already made room", () => {
	// A long model id widens the middle span, so
	// the token cell has slack and the split costs the place cell nothing.
	const m = model({
		modelName: "opencode-go/deepseek-v4-flash-vision-exp",
		thinkingLevel: "max",
		context: { usedTokens: 17_000, windowTokens: 1_000_000, percent: 1.7 },
		counters: { prompts: 2, turns: 8, toolCalls: 7 },
		cwd: "~",
		gitBranch: null,
		sessionName: null,
		tokens: { input: 12_000, cacheWrite: 3_000, cacheRead: 106_000, output: 1_800 },
		cacheHitPct: 98,
		rows: [{ id: "opencode-go", cost: 0.0053, airtimeMs: 39_000, tokens: { input: 12_000, output: 1_800 }, entries: [
			{ label: "5h", usedPct: 0 }, { label: "7d", usedPct: 44 }, { label: "mo", usedPct: 83 },
		] }],
	});
	const lines = renderFooter(m, 110, paint).map(stripAnsi);
	assert.ok(lines[1].includes("12k in 3.0k write 106k read 1.8k out"), lines[1]);
	assert.ok(lines[0].endsWith("│ ~"), lines[0]);
	assert.deepEqual(columns(lines[1]), [columns(lines[0])[0], columns(lines[0])[2]]);
});

test("zero writes are omitted without changing input, independent of provider names", () => {
	for (const id of ["openai-codex", "anthropic", "custom-proxy"]) {
		const m = model({ tokens: { input: 1_200_000, cacheWrite: 0, cacheRead: 9_800_000, output: 48_000 }, rows: [{ id, cost: 1, airtimeMs: 1000, tokens: { input: 1, output: 1 }, entries: [] }] });
		for (const width of [150, 110, 100, 60]) {
			const lines = renderFooter(m, width, paint).map(stripAnsi);
			const tokens = lines.find(line => line.includes("1.2M in"));
			assert.ok(tokens?.includes("9.8M read") && tokens.includes("48k out"), `${id} ${width}: ${lines.join("\n")}`);
			assert.ok(lines.every(line => !line.includes("write") && !line.includes("?")), "no zero-write field or placeholder");
		}
	}
});

test("zero recorded cache counts show only input, read and output without placeholders", () => {
	const lines = renderFooter(model({ tokens: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 } }), 150, paint).map(stripAnsi);
	assert.ok(lines[1].includes("10 in · 0 read · 5 out"), lines[1]);
	assert.ok(!lines[1].includes("?") && !lines[1].includes("write"), lines[1]);
});

test("layout changes never mutate the accounting model", () => {
	const m = model();
	const before = structuredClone(m);
	for (const width of [60, 80, 100, 150, 200]) renderFooter(m, width, paint);
	assert.deepEqual(m, before);
});

test("compact layout preserves literal middle dots supplied by other content", () => {
	const lines = renderFooter(model({ cwd: "~/a·b", gitBranch: null, sessionName: "note·name", extensionStatuses: ["external · status"], rows: [] }), 110, paint).map(stripAnsi);
	assert.ok(lines[0].includes("a·b"));
	assert.ok(lines[0].includes("note·name"));
	assert.equal(lines.at(-1), "external · status");
});

test("clock is the last completed call, never the wall clock", () => {
	const toned = { fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>` };
	// The footer re-renders on a timer, so a wall clock would tick; the point
	// of the cell is "when was the cache last kept warm".
	const lastCall = NOON - 7 * 60_000; // 11:53 Central
	const warm = renderFooter(model({ nowMs: NOON, lastApiEndMs: lastCall, cache: { kind: "warm", tone: "dim", label: "7m warm" }, rows: [] }), 400, toned);
	assert.ok(warm[0].startsWith("<dim>11:53</dim>"), warm[0]);
	// After compaction the last call still anchors the clock.
	const newCtx = renderFooter(model({ nowMs: NOON, lastApiEndMs: lastCall, cache: { kind: "new-ctx", tone: "dim", label: "new ctx" }, rows: [] }), 400, toned);
	assert.ok(newCtx[0].startsWith("<dim>11:53</dim>"), newCtx[0]);
	// Before the first call there is nothing to anchor to.
	const fresh = renderFooter(model({ nowMs: NOON, lastApiEndMs: undefined, cache: { kind: "none", tone: "dim", label: "no calls yet" }, rows: [] }), 400, toned);
	assert.ok(fresh[0].startsWith("<dim>--:--</dim>"), fresh[0]);
});

test("remote-pi mesh state joins the cache cell on the second grid line", () => {
	const mesh = { session: "backend", peerCount: 2, relay: "paired" as const, device: "ab12" };
	const lines = renderFooter(model({ rows: [], mesh }), 170, paint).map(stripAnsi);
	assert.equal(lines.length, 2, lines.join("\n"));
	assert.match(lines[1], /│ cache 92% · 2m warm │ backend \(2\) · relay · ab12$/);
	// The grid still aligns: the tail column starts at the same place on both
	// lines, and the mesh cell only adds a separator inside that tail.
	const top = columns(lines[0]);
	const bottom = columns(lines[1]);
	assert.equal(top[0], bottom[0]);
	assert.equal(top[2], bottom[1]);
	assert.equal(bottom.length, 3);
});

test("mesh state gets its own line when the tail is too narrow for both", () => {
	const mesh = { session: "backend", peerCount: 2, relay: "unpaired" as const, device: "ab12" };
	const lines = renderFooter(model({ mesh }), 110, paint).map(stripAnsi);
	const grid = lines.slice(0, 2);
	assert.ok(grid.every((line) => !line.includes("backend")), lines.join("\n"));
	// Narrow enough to force compact spacing, so the relay shortens too.
	assert.match(lines[2], /^backend \(2\) (· )?relay (\?|unpaired) (· )?ab12$/);
	assert.ok(lines.length > 3, "provider rows follow the mesh line");
});

test("model id wears its provider colour and the effort level Pi's thinking tone", () => {
	const toned = { fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>` };
	const line = renderFooter(model({ rows: [], providerId: "anthropic", modelName: "claude-fable-5-1", thinkingLevel: "high" }), 200, toned)[0];
	assert.match(line, /\x1b\[38;2;\d+;\d+;\d+mclaude-fable-5-1\x1b\[39m <thinkingHigh>high<\/thinkingHigh>/, line);
	// Unknown provider falls back to the text tone; unknown level to dim.
	const plain = renderFooter(model({ rows: [], providerId: "kimi-coding", modelName: "k2", thinkingLevel: "turbo" }), 200, toned)[0];
	assert.ok(plain.includes("<text>k2</text> <dim>turbo</dim>"), plain);
	assert.equal(columns(stripAnsi(line)).length, 3, "colouring never widens the cell");
});

test("animated spend fades the eased figure through red while it moves", () => {
	const toned = { fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>` };
	const moving = renderFooter(model({ rows: [], spend: { cost: 2.7, airtimeMs: 60_000, flash: 1 } }), 400, toned)[0];
	assert.ok(moving.includes("<error>$2.70 · 1m</error>"), moving);
	const settled = renderFooter(model({ rows: [], spend: { cost: 2.82, airtimeMs: 60_000, flash: 0 } }), 400, toned)[0];
	assert.ok(settled.includes("<text>$2.82 · 1m</text>"), settled);
	// A real painter exposes colours, so the midpoint is a blended truecolor, not a step.
	const real = { fg: (tone: string, text: string) => tone === "error" ? `\x1b[38;2;200;80;80m${text}\x1b[39m` : `\x1b[38;2;200;200;200m${text}\x1b[39m` };
	const mid = renderFooter(model({ rows: [], spend: { cost: 2.7, airtimeMs: 60_000, flash: 0.5 } }), 400, real)[0];
	const sgr = /\x1b\[38;2;(\d+);(\d+);(\d+)m\$2\.70/.exec(mid);
	assert.ok(sgr, mid);
	assert.equal(sgr[1], "200");
	assert.ok(Number(sgr[2]) > 80 && Number(sgr[2]) < 200, `green channel blended: ${sgr[2]}`);
	// Without a spend override the row totals still drive the cell.
	const rows = renderFooter(model(), 400, toned)[0];
	assert.ok(rows.includes("<text>$2.82 · 19m</text>"), rows);
});

test("delta overpaints the tail without changing the resting layout at any width", () => {
	const base = model({ rows: [{ id: "anthropic", cost: 0.59, airtimeMs: 0, tokens: { input: 1, output: 1 }, entries: [] }], tokens: { input: 1, cacheWrite: 0, cacheRead: 1, output: 1 } });
	for (let width = 40; width <= 200; width++) {
		const idle = renderFooter(base, width, paint).map(stripAnsi);
		for (const delta of [0.043, 0.00093, 1e-20]) {
			const active = renderFooter({ ...base, spend: { cost: 0.59, airtimeMs: 0, flash: 1, delta } }, width, paint).map(stripAnsi);
			assert.deepEqual(columns(active[0]).slice(0, 2), columns(idle[0]).slice(0, 2), `width ${width}`);
			assert.equal(active[0].indexOf("$0.59"), idle[0].indexOf("$0.59"), `money anchor at ${width}`);
			assert.deepEqual(active.slice(1), idle.slice(1), "every other line stays exactly fixed");
			assert.ok(active.every(line => visibleWidth(line) <= width));
			if (width >= 120) {
				assert.ok(active[0].includes("$0.59 +$"), active[0]);
				assert.ok(!active[0].includes("0m"), active[0]);
				assert.match(idle[0], /\$0\.59 · 0m │/, "no idle reservation");
				const start = idle[0].indexOf("$0.59");
				const overlay = `$0.59 ${formatIncrement(delta)}`;
				assert.equal(active[0], idle[0].slice(0, start) + overlay + idle[0].slice(start + overlay.length), "only painted cells change");
				assert.ok(!columns(active[0]).includes(columns(idle[0])[2]), "separator is covered, not relocated");
			}
		}
	}
});

test("delta uses existing token-column padding before borrowing tail space", () => {
	const base = model();
	const idle = renderFooter(base, 150, paint).map(stripAnsi);
	const active = renderFooter({ ...base, spend: { cost: 2.82, airtimeMs: 60_000, flash: 1, delta: 0.00093 } }, 150, paint).map(stripAnsi);
	assert.ok(active[0].includes("$2.82 +$0.00093"));
	assert.deepEqual(columns(active[0]), columns(idle[0]));
	assert.deepEqual(active.slice(1), idle.slice(1));
});

test("other extensions' statuses still get a line", () => {
	const lines = renderFooter(model({ rows: [], extensionStatuses: ["subagents: 2 running"] }), 150, paint).map(stripAnsi);
	assert.equal(lines.length, 3);
	assert.equal(lines[2], "subagents: 2 running");
});

test("everything is dim except the model, total cost, and what needs attention", () => {
	const toned = { fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>` };
	const hot = model({
		context: { usedTokens: 250_000, windowTokens: 272_000, percent: 92 },
		rows: [{ id: "openai-codex", cost: 0.62, airtimeMs: 250_000, tokens: { input: 80_000, output: 5_200 }, entries: [
			{ label: "5h", usedPct: 3 }, { label: "7d", usedPct: 78 },
		] }],
	});
	const [first, second, row] = renderFooter(hot, 400, toned);
	assert.ok(row.includes("<dim>80k in · 5.2k out</dim>"), row);
	assert.ok(first.includes("<error>250k / 272k</error>"), first);
	assert.ok(first.includes("<text>gpt-5.6-sol</text> <thinkingHigh>high</thinkingHigh>"), first);
	assert.ok(first.includes("<text>$0.62 · 4m</text>"), first);
	assert.ok(first.includes("<dim>~/projects/example-app (main) · e2e</dim>"), first);
	assert.ok(second.includes("<dim>12 prompts · 31 turns · 48 tools</dim>"), second);
	assert.ok(second.includes("<dim>cache 92% · </dim><dim>2m warm</dim>"), second);
	assert.ok(row.includes("<dim>$0.62</dim>"), row);
	assert.ok(row.includes("<dim>5h 3%</dim>") && row.includes("<warning>7d 78%</warning>"), row);
});

test("long model ids lose their vendor prefix, then their middle", () => {
	const plain = (name: string) => stripAnsi(renderFooter(model({ modelName: name, rows: [] }), 200, paint)[0]);
	assert.ok(plain("google/gemini-3.8-flash").includes("│ gemini-3.8-flash high "), plain("google/gemini-3.8-flash"));
	assert.ok(plain("gpt-5.6-sol").includes("│ gpt-5.6-sol high "), "short ids untouched");
	const long = plain("qwen/qwen3.6-235b-a22b-thinking-2507");
	assert.match(long, /│ qwen3\.6-23…nking-2507 high /, long);
	const seps = columns(long);
	assert.equal(seps[1] - seps[0], 2 + 26 + 1, "model cell never exceeds its cap: " + long);
});
