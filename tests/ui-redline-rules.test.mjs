import assert from "node:assert/strict";
import test from "node:test";
import { contrastRatio, hueSpread, oklch } from "../skills/ui-redline/scripts/lib/color.mjs";
import { kindOf, normalizeConfig, RULES, runRules, score, scores } from "../skills/ui-redline/scripts/lib/rules/index.mjs";
import { border, el, facts, text } from "./ui-redline-support.mjs";

const PURPLE = [139, 92, 246, 1];
const BLUE = [59, 130, 246, 1];
const PINK = [236, 72, 153, 1];

/** Ids of the findings for these elements in one view. */
function ids(elements, { page, view = "desktop", focus, config } = {}) {
	return runRules(facts(elements, page), { view, focus, config }).map((f) => f.id);
}
const has = (elements, id, options) => ids(elements, options).includes(id);

test("color math: WCAG contrast, OKLCH chroma and hue spread", () => {
	assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255])), 21);
	assert.ok(Math.abs(contrastRatio([118, 118, 118], [255, 255, 255]) - 4.54) < 0.02);
	assert.ok(oklch(PURPLE).c > 0.15);
	assert.ok(oklch([30, 30, 33]).c < 0.01);
	assert.equal(hueSpread([350, 10]), 20);
	assert.equal(hueSpread([0, 120, 240]), 240);
});

test("every rule has an id, a category, a severity, a title and a fix", () => {
	const seen = new Set();
	for (const rule of RULES) {
		assert.ok(rule.id && !seen.has(rule.id), rule.id);
		seen.add(rule.id);
		assert.ok(["high", "medium", "low"].includes(rule.severity), rule.id);
		assert.ok(rule.category && rule.title && rule.fix, rule.id);
	}
});

test("hue-gradient: two hues fire, a tone shift of one neutral does not", () => {
	assert.ok(has([el({ bgImage: [{ kind: "linear", stops: [PURPLE, BLUE] }] })], "hue-gradient"));
	assert.ok(!has([el({ bgImage: [{ kind: "linear", stops: [[43, 43, 43, 1], [31, 31, 31, 1]] }] })], "hue-gradient"));
	assert.ok(!has([el({ bgImage: [{ kind: "linear", stops: [[0, 0, 0, 0], [0, 0, 0, 0.6]] }] })], "hue-gradient"));
});

test("gradient-text fires on clipped gradient text with a transparent fill", () => {
	const logo = text("Ledgerly", { clipText: true, textFill: [0, 0, 0, 0], color: [0, 0, 0, 0], bgImage: [{ kind: "linear", stops: [PURPLE, BLUE] }] });
	assert.deepEqual(ids([logo]).filter((id) => id.includes("gradient")), ["gradient-text"]);
});

test("colored-glow: a blurred purple shadow fires, a small neutral shadow does not", () => {
	assert.ok(has([el({ boxShadow: [{ color: [168, 85, 247, 0.6], x: 0, y: 0, blur: 20, spread: 0, inset: false }] })], "colored-glow"));
	assert.ok(!has([el({ boxShadow: [{ color: [0, 0, 0, 0.2], x: 0, y: 1, blur: 3, spread: 0, inset: false }] })], "colored-glow"));
	assert.ok(has([el({ filter: { drops: [{ color: PINK, x: 0, y: 0, blur: 12, spread: 0, inset: false }], blur: 0 } })], "colored-glow"));
});

test("color-wash: a large radial wash and a blurred colored blob fire", () => {
	assert.ok(has([el({ rect: { x: 0, y: 0, w: 400, h: 400 }, bgImage: [{ kind: "radial", stops: [[236, 72, 153, 0.5], [0, 0, 0, 0]] }] })], "color-wash"));
	assert.ok(has([el({ bg: PINK, filter: { drops: [], blur: 40 } })], "color-wash"));
	assert.ok(!has([el({ rect: { x: 0, y: 0, w: 20, h: 20 }, bgImage: [{ kind: "radial", stops: [PINK, [0, 0, 0, 0]] }] })], "color-wash"));
});

test("low-contrast: uses the worst gradient stop and the large-text threshold", () => {
	const grey = [140, 140, 140, 1];
	assert.ok(has([text("Muted", { color: grey })], "low-contrast"));
	assert.ok(!has([text("Big", { color: grey, font: { size: 28 } })], "low-contrast"), "3:1 is enough for large text");
	assert.ok(has([text("Over a gradient", { color: [255, 255, 255, 1], effBg: [128, 128, 128, 1], effBgStops: [[20, 20, 20, 1], [230, 230, 230, 1]] })], "low-contrast"));
	assert.ok(!has([text("Unknown", { color: grey, effBgUnknown: true })], "low-contrast"), "over an image the rule stays silent");
});

test("text-colors counts text roles but not inverse text on a filled control", () => {
	const shades = [[20, 20, 20, 1], [60, 60, 60, 1], [100, 100, 100, 1], [80, 40, 160, 1], [40, 120, 80, 1], [140, 30, 30, 1]];
	const six = shades.map((c, i) => text(`t${i}`, { color: c }));
	assert.ok(has(six, "text-colors"));
	const five = [...six.slice(0, 5), text("Pay", { color: [255, 255, 255, 1], bg: PURPLE, effBg: PURPLE })];
	assert.ok(!has(five, "text-colors"));
});

test("accent-hues fires on four hues, not on one accent plus red and green", () => {
	const swatch = (c) => el({ bg: c });
	assert.ok(has([PURPLE, BLUE, PINK, [234, 179, 8, 1]].flatMap((c) => [swatch(c), swatch(c)]), "accent-hues"));
	assert.ok(!has([BLUE, [220, 38, 38, 1], [22, 163, 74, 1]].flatMap((c) => [swatch(c), swatch(c)]), "accent-hues"));
});

test("neon-border needs three saturated borders", () => {
	const card = () => el({ border: border(PURPLE) });
	assert.ok(!has([card(), card()], "neon-border"));
	assert.ok(has([card(), card(), card()], "neon-border"));
	assert.ok(!has([1, 2, 3].map(() => el({ border: border([255, 255, 255, 0.08]) })), "neon-border"));
	assert.ok(!has([1, 2, 3].map(() => el({ inCode: true, border: border(PURPLE) })), "neon-border"), "diff lines in code pass");
});

test("type rules: sizes, weights, families, tracked caps, tight and tiny text", () => {
	const sizes = [10, 12, 13, 14, 15, 16, 18, 20].map((s) => text("x", { font: { size: s } }));
	assert.ok(has(sizes, "font-sizes"));
	assert.ok(has([text("Big", { font: { weight: 800 } })], "heavy-weight"));
	assert.ok(!has([text("Semi", { font: { weight: 600 } })], "heavy-weight"));
	assert.ok(has([300, 400, 500, 700].map((w) => text("x", { font: { weight: w } })), "font-weights"));
	assert.ok(has(["A", "B", "C"].map((f) => text("x", { font: { family: f } })), "font-families"));
	assert.ok(has([text("Navigation", { font: { transform: "uppercase", size: 11, spacing: 1.5 } })], "tracked-caps"));
	assert.ok(has([text("PAID THIS MONTH", { font: { size: 11, spacing: 1 } })], "tracked-caps"));
	assert.ok(!has([text("API", { font: { size: 11, spacing: 1 } })], "tracked-caps"), "short acronyms pass");
	assert.ok(!has([text("Navigation", { font: { transform: "uppercase", size: 11, spacing: 0 } })], "tracked-caps"));
	assert.ok(has([text("Meta", { font: { size: 13, spacing: -0.5 } })], "tight-small-text"));
	assert.ok(!has([text("Body", { font: { size: 15, spacing: -0.165 } })], "tight-small-text"), "-0.011em is optical tuning");
	assert.ok(!has([text("Display", { font: { size: 48, spacing: -1 } })], "tight-small-text"));
	assert.ok(has([text("tiny", { font: { size: 10 } })], "tiny-text"));
	assert.ok(has([text("tiny", { font: { size: 10 } })], "tiny-text", { view: "mobile" }));
});

test("figures: tabular numerals and one money format", () => {
	const figures = ["$48,210", "182", "12%"].map((t) => text(t));
	assert.ok(has(figures, "tabular-figures"));
	assert.ok(!has(["$48,210", "182", "12%"].map((t) => text(t, { font: { numeric: "tabular-nums" } })), "tabular-figures"));
	assert.ok(has([text("$48,210"), text("$124,860.40")], "mixed-number-format"));
	assert.ok(!has([text("$48,210"), text("$124,860")], "mixed-number-format"));
});

test("long-lines fires on a wide paragraph only", () => {
	const long = "word ".repeat(60);
	assert.ok(has([text(long, { rect: { x: 0, y: 0, w: 1100, h: 60 } })], "long-lines"));
	assert.ok(!has([text(long, { rect: { x: 0, y: 0, w: 600, h: 120 } })], "long-lines"));
});

test("off-grid: off-scale padding fires; grid steps, 1-2px nudges and centering margins do not", () => {
	assert.ok(has([el({ spacing: { pt: 13 } })], "off-grid"));
	assert.ok(!has([el({ spacing: { pt: 12, pb: 2, pl: 28 } })], "off-grid"));
	assert.ok(!has([el({ spacing: { ml: 237, mr: 237 } })], "off-grid"), "auto margins");
	assert.ok(has([el({ display: "flex", spacing: { colGap: 14 } })], "off-grid"));
	assert.ok(!has([el({ display: "block", spacing: { colGap: 14 } })], "off-grid"), "gap counts only on flex and grid");
	assert.ok(!has([el({ spacing: { pt: 6, pr: 10 } })], "off-grid"), "6 and 10 are half-steps");
	assert.ok(has([el({ spacing: { pt: 14 } })], "off-grid"));
	assert.ok(!has([el({ spacing: { pt: 14 } })], "off-grid", { config: normalizeConfig({ grid: 2 }) }));
});

function rows(paddings, ys, h = 40) {
	return paddings.map((pt, i) => el({ parent: 99, classKey: "div.row", rect: { x: 0, y: ys[i], w: 300, h }, spacing: { pt } }));
}

test("uneven-siblings and uneven-rhythm read lists of alike items", () => {
	assert.ok(has(rows([8, 8, 12], [0, 50, 100]), "uneven-siblings"));
	assert.ok(!has(rows([8, 8, 8], [0, 48, 96]), "uneven-siblings"));
	assert.ok(has(rows([8, 8, 8], [0, 46, 100]), "uneven-rhythm"));
	assert.ok(!has(rows([8, 8, 8], [0, 48, 96]), "uneven-rhythm"));
	assert.ok(!has(rows([8, 8], [0, 60]), "uneven-rhythm"), "two items are not a list");
	assert.ok(!has(rows([8, 8, 8], [0, 140, 400]), "uneven-rhythm"), "gaps over 64px separate sections");
	assert.ok(!has(rows([8, 8, 8, 8], [0, 40, 80, 144], 40), "uneven-rhythm"), "flush rows with one break");
});

test("nested-radius: inner radius must follow outer radius minus inset", () => {
	const outer = el({ i: 0, bg: [30, 30, 30, 1], radius: [16, 16, 16, 16], rect: { x: 0, y: 0, w: 300, h: 200 } });
	const inner = (r) => el({ i: 1, parent: 0, bg: [40, 40, 40, 1], radius: [r, r, r, r], rect: { x: 8, y: 8, w: 284, h: 100 } });
	assert.ok(has([outer, inner(16)], "nested-radius"), "same radius at an 8px inset bulges");
	assert.ok(!has([outer, inner(8)], "nested-radius"));
	const clipping = { ...outer, clips: true };
	const flush = el({ i: 1, parent: 0, bg: [40, 40, 40, 1], rect: { x: 0, y: 0, w: 300, h: 100 } });
	assert.ok(has([outer, flush], "nested-radius"), "a square box in a rounded corner pokes out");
	assert.ok(!has([clipping, flush], "nested-radius"), "unless the parent clips it");
});

test("copy rules: emoji, exclamation, hype, claims, greeting, trailing period, placeholder", () => {
	assert.ok(has([text("🏠 Dashboard")], "emoji"));
	assert.ok(!has([text("© 2026 Ledgerly → next")], "emoji"), "typographic symbols are not emoji");
	assert.ok(!has([text("🚀 deploy", { inCode: true })], "emoji"), "code is not interface text");
	assert.ok(has([text("Saved!")], "exclamation"));
	assert.ok(!has([text("a != b")], "exclamation"));
	assert.ok(has([text("Supercharge your seamless workflow")], "hype-words"));
	assert.ok(has([text("Loved by 10,000+ teams")], "unverified-claims"));
	assert.ok(has([text("Welcome back, Sam", { tag: "h1" })], "greeting"));
	assert.ok(!has([text("Welcome back, Sam", { tag: "p" })], "greeting"));
	assert.ok(has([text("Save changes.", { tag: "button" })], "trailing-period"));
	assert.ok(!has([text("Loading...", { tag: "button" })], "trailing-period"));
	assert.ok(has([text("Total: $123,456")], "placeholder-data"));
	assert.ok(!has([text("Loved by 10,000+ teams")], "placeholder-data"));
});

test("motion rules: loops, transition all, layout transitions, too many curves", () => {
	assert.ok(has([el({ animation: { names: ["pulse"], iterations: ["infinite"], durations: [1.6] } })], "looping-animation"));
	assert.ok(!has([el({ live: true, animation: { names: ["spin"], iterations: ["infinite"], durations: [1] } })], "looping-animation"));
	assert.ok(has([el({ transition: { props: ["all"], durations: [0.3], easings: ["ease"] } })], "transition-all"));
	assert.ok(!has([el({ transition: { props: ["all"], durations: [0], easings: ["ease"] } })], "transition-all"), "the default all 0s is no transition");
	assert.ok(has([el({ transition: { props: ["width", "opacity"], durations: [0.2], easings: ["ease"] } })], "layout-transition"));
	const curves = ["ease", "linear", "ease-in", "cubic-bezier(0.68, -0.55, 0.27, 1.55)"].map((e) => el({ transition: { props: ["opacity"], durations: [0.2], easings: [e] } }));
	assert.ok(has(curves, "motion-curves"));
});

test("layout rules: overflow, viewport meta, clipped text, tap targets, focus", () => {
	assert.ok(has([el()], "horizontal-overflow", { page: { scrollWidth: 1600 } }));
	assert.ok(has([el()], "horizontal-overflow", { view: "mobile", page: { viewport: { w: 615, h: 844 }, scrollWidth: 615, requestedWidth: 390 } }), "a zoomed-out mobile page overflows");
	assert.ok(!has([el()], "horizontal-overflow", { view: "mobile", page: { viewport: { w: 980, h: 844 }, scrollWidth: 980, requestedWidth: 390, viewportMeta: null } }), "mobile-viewport covers a page without the meta tag");
	assert.ok(has([el()], "mobile-viewport", { view: "mobile", page: { viewportMeta: null } }));
	assert.ok(!has([el()], "mobile-viewport"), "desktop does not check the meta tag");
	assert.ok(has([text("Long name", { clipped: true })], "clipped-text"));
	const tiny = (x) => el({ interactive: true, rect: { x, y: 0, w: 20, h: 20 } });
	assert.ok(has([tiny(0), tiny(22)], "tap-target", { view: "mobile" }), "two small targets side by side");
	assert.ok(!has([tiny(0), tiny(60)], "tap-target", { view: "mobile" }), "spaced small targets pass (WCAG 2.5.8 exception)");
	assert.ok(!has([{ ...tiny(0), inlineInText: true }, { ...tiny(22), inlineInText: true }], "tap-target", { view: "mobile" }));
	assert.ok(has([el()], "focus-ring", { focus: [{ tag: "a", label: "Home", rect: { x: 0, y: 0, w: 10, h: 10 }, visible: false }] }));
	assert.ok(!has([el()], "focus-ring", { focus: [{ tag: "a", label: "Home", rect: { x: 0, y: 0, w: 10, h: 10 }, visible: true }] }));
});

test("icon rules: sizes and strokes", () => {
	const icon = (size, stroke) => el({ tag: "svg", icon: { w: size, h: size, stroke } });
	assert.ok(has([icon(16, 1.5), icon(18, 1.5), icon(24, 1.5)], "icon-sizes"));
	assert.ok(has([icon(16, 1.5), icon(16, 2)], "icon-strokes"));
	assert.ok(!has([icon(16, 1.5), icon(16, 1.5), icon(96, 1)], "icon-strokes"), "large illustrations do not count");
});

test("config: turn a rule off, change severity and options, reject unknown rules", () => {
	const tracked = [text("NAVIGATION", { font: { size: 11, spacing: 1.5 } })];
	assert.ok(!has(tracked, "tracked-caps", { config: normalizeConfig({ rules: { "tracked-caps": "off" } }) }));
	const low = runRules(facts(tracked), { config: normalizeConfig({ rules: { "tracked-caps": { severity: "low" } } }) }).find((f) => f.id === "tracked-caps");
	assert.equal(low.severity, "low");
	assert.ok(!has([text("Big", { font: { weight: 800 } })], "heavy-weight", { config: normalizeConfig({ rules: { "heavy-weight": { min: 900 } } }) }));
	assert.throws(() => normalizeConfig({ rules: { "no-such-rule": "off" } }), /unknown rule/);
	assert.throws(() => normalizeConfig({ rules: { emoji: { severity: "urgent" } } }), /severity/);
	assert.throws(() => normalizeConfig({ grid: -4 }), /grid/);
	assert.throws(() => normalizeConfig([]), /JSON object/);
});

test("score caps each rule at five instances", () => {
	const findings = [{ severity: "high", count: 40 }, { severity: "low", count: 2 }];
	assert.equal(score(findings), 100 - 6 * 5 - 2);
	assert.equal(score([{ severity: "high", count: 5 }, { severity: "high", count: 5 }, { severity: "high", count: 5 }, { severity: "high", count: 5 }]), 0);
});

test("scores split slop signs from craft defects", () => {
	assert.equal(kindOf("emoji"), "slop");
	assert.equal(kindOf("low-contrast"), "craft");
	assert.deepEqual(scores([{ id: "emoji", severity: "high", count: 1 }, { id: "off-grid", severity: "medium", count: 2 }]), { slop: 94, craft: 94 });
});

test("review fixes: emoji-only labels, text symbols, flags and the #1 claim", () => {
	assert.ok(has([text("🚀")], "emoji"), "an emoji-only label has no letter but still fires");
	assert.ok(has([text("⚙️ Settings")], "emoji"), "a pictograph with U+FE0F is an emoji");
	assert.ok(has([text("Ships to 🇺🇸")], "emoji"), "a flag is an emoji");
	assert.ok(!has([text("✔ Done ▶ Play ♥ ⚠ Warning")], "emoji"), "text symbols without U+FE0F pass");
	assert.ok(has([text("The #1 rated tool")], "unverified-claims"));
	assert.ok(!has([text("Issue #12 is fixed")], "unverified-claims"));
	assert.ok(!has([text("Clean up deprecated APIs used by the rider app")], "unverified-claims"), "used by in plain prose");
	assert.ok(has([text("Trusted by leading teams")], "unverified-claims"));
});

test("review fixes: opacity fades text, pseudo loops count, hidden root overflow passes", () => {
	assert.ok(has([text("Faded", { drawnOpacity: 0.3 })], "low-contrast"), "dark text at 30% opacity is about 2:1");
	assert.ok(!has([text("Solid", { drawnOpacity: 1 })], "low-contrast"));
	const shimmer = el({ pseudo: true, tag: "::after", animation: { names: ["shimmer"], iterations: ["infinite"], durations: [1.2] } });
	assert.ok(has([shimmer], "looping-animation"));
	assert.ok(!has([el()], "horizontal-overflow", { page: { scrollWidth: 1600, overflowHidden: true } }), "the page cannot scroll sideways");
});

test("review fixes: default heading margins, first and last siblings, radius away from corners, hue families", () => {
	assert.ok(!has([el({ tag: "h1", font: { size: 32 }, spacing: { mt: 21.44, mb: 21.44 } })], "off-grid"), "0.67em on an h1 is the browser default");
	assert.ok(has([el({ tag: "div", font: { size: 32 }, spacing: { mt: 21.44 } })], "off-grid"));
	assert.ok(has([el({ spacing: { mt: -13 } })], "off-grid"), "negative margins are checked too");
	assert.ok(!has(rows([0, 8, 8, 8, 0], [0, 48, 96, 144, 192]), "uneven-siblings"), "a different first and last item is deliberate");
	assert.ok(has(rows([8, 8, 12, 8, 8], [0, 48, 96, 144, 192]), "uneven-siblings"));
	const card = el({ i: 0, bg: [30, 30, 30, 1], radius: [16, 16, 16, 16], rect: { x: 0, y: 0, w: 300, h: 200 } });
	const button = el({ i: 1, parent: 0, bg: [40, 40, 40, 1], radius: [6, 6, 6, 6], rect: { x: 120, y: 4, w: 60, h: 30 } });
	assert.ok(!has([card, button], "nested-radius"), "the radii meet only at a corner");
	const ringed = (c) => el({ border: border(c) });
	assert.ok(!has([PURPLE, BLUE, PINK, [234, 179, 8, 1]].map(ringed), "accent-hues"), "four sides of one element count once");
	const ramp = [[14, 165, 233, 1], [2, 132, 199, 1], [3, 105, 161, 1], [7, 89, 133, 1]];
	assert.ok(!has([...ramp, PURPLE].flatMap((c) => [el({ bg: c }), el({ bg: c })]), "accent-hues"), "one color ramp is one family");
});

test("review fixes: money amounts without thousands separators", () => {
	assert.ok(!has([text("$1500.00"), text("$2,000.00")], "mixed-number-format"));
	assert.ok(has([text("$1500.00"), text("$2,000")], "mixed-number-format"));
});
