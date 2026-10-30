/**
 * wv lift: the brand tokens come from the page mechanically. These tests feed
 * assignRoles the raw facts that the page collector returns, so the rules
 * that pick the ground, the inks, the accent, the fonts and the springs are
 * pinned without a browser.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assignRoles, easeKind, parseColor, scrubMarkup, stripTransitions, toHex } from "../skills/walkthrough-video/scripts/film/tokens.mjs";
import { brandCss, crashRetrySize, fontFile, fontFormat } from "../skills/walkthrough-video/scripts/film/lift.mjs";

test("colours normalise to lower-case hex, with alpha only when it is not 1", () => {
	assert.deepEqual(parseColor("rgb(46, 35, 32)"), { r: 46, g: 35, b: 32, a: 1 });
	assert.deepEqual(parseColor("rgba(212,133,106,0.25)"), { r: 212, g: 133, b: 106, a: 0.25 });
	assert.deepEqual(parseColor("#FFF"), { r: 255, g: 255, b: 255, a: 1 });
	assert.deepEqual(parseColor("#d4856a80").a, 128 / 255);
	assert.equal(parseColor("transparent").a, 0);
	assert.equal(parseColor("var(--x)"), null);
	assert.equal(toHex("rgb(250, 245, 242)"), "#faf5f2");
	assert.equal(toHex("rgba(212, 133, 106, 0.25)"), "#d4856a40");
	assert.equal(toHex("#FFFFFF"), "#ffffff");
});

test("a curve that overshoots is a spring; the rest are eases", () => {
	assert.equal(easeKind("cubic-bezier(0.34, 1.56, 0.64, 1)"), "spring");
	assert.equal(easeKind("cubic-bezier(0.4, 0, 0.2, 1)"), "ease");
	assert.equal(easeKind("cubic-bezier(0.6, -0.28, 0.74, 0.05)"), "anticipate");
	assert.equal(easeKind("linear"), "linear");
});

test("transitions are removed from a lifted stylesheet, animations stay", () => {
	const css = ".a { color: red; transition: opacity 0.2s ease; }\n.b { transition-duration: 1s; animation: pop 1s; }";
	const out = stripTransitions(css);
	assert.doesNotMatch(out, /transition/);
	assert.match(out, /color: red/);
	assert.match(out, /animation: pop 1s/);
});

const RAW = {
	url: "http://example.test/",
	viewport: { width: 1920, height: 1080 },
	vars: [
		{ name: "--bg", value: "#faf5f2", computed: "#faf5f2" },
		{ name: "--surface", value: "#ffffff", computed: "#ffffff" },
		{ name: "--header-bg", value: "#2e2320", computed: "#2e2320" },
		{ name: "--header-text", value: "#f0e8e2", computed: "#f0e8e2" },
		{ name: "--accent", value: "#d4856a", computed: "#d4856a" },
		{ name: "--accent-glow", value: "rgba(212,133,106,0.25)", computed: "rgba(212,133,106,0.25)" },
		{ name: "--sidebar-w", value: "280px", computed: "280px" },
	],
	grounds: [
		{ color: "rgb(46, 35, 32)", share: 0.93, selector: "div.landing", image: "radial-gradient(...)" },
		{ color: "rgb(255, 255, 255)", share: 0.05, selector: "div.card" },
	],
	texts: [
		{ color: "rgb(240, 232, 226)", family: "Karla", weight: 800, size: 64, chars: 7, ground: "rgb(46, 35, 32)", variation: "normal", selector: "h1.logo" },
		{ color: "rgb(201, 188, 174)", family: "Instrument Sans", weight: 600, size: 18, chars: 40, ground: "rgb(46, 35, 32)", variation: "normal", selector: "p.sub" },
		{ color: "rgb(179, 162, 148)", family: "Instrument Sans", weight: 400, size: 14, chars: 30, ground: "rgb(46, 35, 32)", variation: "normal", selector: "p.url" },
		{ color: "rgb(58, 46, 40)", family: "Recursive", weight: 800, size: 40, chars: 2, ground: "rgb(255, 255, 255)", variation: "\"CASL\" 0.5", selector: "div.card-value" },
	],
	fontFaces: [{ family: "Karla", src: "http://example.test/fonts/karla.woff2", weight: "400 800", style: "normal" }],
	easings: [
		{ value: "cubic-bezier(0.34, 1.56, 0.64, 1)", selector: ".card", prop: "transition" },
		{ value: "cubic-bezier(0.34, 1.56, 0.64, 1)", selector: ".pop", prop: "animation" },
		{ value: "cubic-bezier(0.4, 0, 0.2, 1)", selector: ".fade", prop: "transition" },
		{ value: "ease", selector: ".x", prop: "transition" },
	],
	keyframes: [{ name: "heroCardDeal", css: "@keyframes heroCardDeal { }" }],
	literals: [{ selector: ".tagline", prop: "color", value: "#b3a294" }],
};

test("roles: the ground is the largest painted colour, the ink the main text on it", () => {
	const t = assignRoles(RAW);
	assert.equal(t.ground.color, "#2e2320");
	assert.equal(t.ground.var, "--header-bg");
	assert.equal(t.ground.selector, "div.landing");
	assert.equal(t.ink.color, "#f0e8e2");
	assert.equal(t.ink.var, "--header-text");
	assert.deepEqual(t.inkSecondary.map((i) => i.color), ["#c9bcae", "#b3a294"]);
});

test("roles: surfaces, accent, palette and fonts", () => {
	const t = assignRoles(RAW);
	assert.deepEqual(t.surfaces.map((s) => [s.var, s.color]), [["--bg", "#faf5f2"], ["--surface", "#ffffff"]]);
	assert.equal(t.accent.color, "#d4856a");
	assert.equal(t.accent.var, "--accent");
	assert.equal(t.palette["--accent-glow"], "#d4856a40");
	assert.equal(t.palette["--sidebar-w"], undefined, "only colours go in the palette");
	const karla = t.fonts.find((f) => f.family === "Karla");
	assert.equal(karla.role, "display");
	assert.equal(karla.weight, 800);
	const rec = t.fonts.find((f) => f.family === "Recursive");
	assert.equal(rec.weight, 800);
	assert.equal(rec.variation, '"CASL" 0.5');
	assert.equal(t.fonts.find((f) => f.family === "Instrument Sans").weight, 600);
});

test("roles: the motion language lists springs first, with their use counts", () => {
	const t = assignRoles(RAW);
	assert.deepEqual(t.motion.springs, [{ value: "cubic-bezier(0.34, 1.56, 0.64, 1)", uses: 2, selectors: [".card", ".pop"] }]);
	assert.equal(t.motion.eases[0].value, "cubic-bezier(0.4, 0, 0.2, 1)");
	assert.deepEqual(t.motion.keyframes, ["heroCardDeal"]);
});

test("inks by ground: each ground lists its text colours, heaviest first", async () => {
	const { inksByGround } = await import("../skills/walkthrough-video/scripts/film/tokens.mjs");
	const table = inksByGround(RAW.texts, { "#f0e8e2": "--header-text" });
	assert.deepEqual(Object.keys(table), ["#2e2320", "#ffffff"]);
	assert.deepEqual(table["#2e2320"].map((i) => i.color), ["#f0e8e2", "#c9bcae", "#b3a294"]);
	assert.equal(table["#2e2320"][0].var, "--header-text");
	assert.equal(table["#ffffff"][0].color, "#3a2e28");
});

test("lifted markup names the app at app.example, never at its local address", () => {
	const html = '<a href="http://127.0.0.1:47811/ukb4t">127.0.0.1:47811/ukb4t</a><span>localhost:3000</span><i>http://192.168.1.4:8080/x</i><b>pointer.jaedyn.me</b>';
	const { html: out, replaced } = scrubMarkup(html, "http://127.0.0.1:47811/");
	assert.equal(out, '<a href="https://app.example/ukb4t">app.example/ukb4t</a><span>app.example</span><i>https://app.example/x</i><b>pointer.jaedyn.me</b>');
	assert.equal(replaced, 4);
	assert.equal(scrubMarkup("<p>hi</p>", "https://app.test/").replaced, 0);
});

test("a lift whose page crashed (a WebGL page under memory pressure) is tried once more at 1280x720", () => {
	assert.deepEqual(crashRetrySize(new Error("page.screenshot: Target crashed"), { width: 1920, height: 1080 }), { width: 1280, height: 720 });
	assert.equal(crashRetrySize(new Error("net::ERR_CONNECTION_REFUSED"), { width: 1920, height: 1080 }), null);
	assert.equal(crashRetrySize(new Error("Target crashed"), { width: 1280, height: 720 }), null);
});

test("a lifted font file keeps its name, takes a query string off, and never overwrites its twin", () => {
	assert.equal(fontFile("https://app.test/fonts/inter.woff2?v=3"), "inter.woff2");
	assert.equal(fontFile("https://app.test/fonts/a/b/Inter-Bold.otf"), "Inter-Bold.otf");
	const taken = new Set(["inter.woff2"]);
	assert.equal(fontFile("https://cdn.test/other/inter.woff2", taken), "inter-2.woff2");
	assert.equal(fontFile("https://cdn.test/other/inter.woff2", new Set(["inter.woff2", "inter-2.woff2"])), "inter-3.woff2");
	assert.equal(fontFile("https://app.test/fonts/%20"), "font");
});

test("a font face names its real format, and an apostrophe in a family stays in the CSS string", () => {
	assert.equal(fontFormat("inter.woff2"), "woff2");
	assert.equal(fontFormat("inter.woff"), "woff");
	assert.equal(fontFormat("Inter.ttf"), "truetype");
	assert.equal(fontFormat("Inter.otf"), "opentype");
	assert.equal(fontFormat("inter.bin"), null);
	const tokens = { palette: {}, ground: null, ink: null, inkSecondary: [], accent: null, motion: { springs: [] }, fonts: [] };
	const css = brandCss(tokens, [
		{ family: "Inter", file: "Inter.ttf", weight: 400, style: "normal" },
		{ family: "Bob's Font", file: "bob.woff2", weight: 700, style: "normal" },
		{ family: "Odd", file: "odd.bin", weight: 400, style: "normal" },
	]);
	assert.match(css, /url\('fonts\/Inter\.ttf'\) format\('truetype'\)/);
	assert.match(css, /font-family: 'Bob\\'s Font'/);
	assert.match(css, /url\('fonts\/odd\.bin'\);/, "an unknown extension gets no format hint");
	assert.doesNotMatch(css, /format\('woff2'\);\n  font-weight: 400;\n  font-style: normal;\n}\n@font-face \{\n  font-family: 'Odd'/);
});

test("a private address is replaced only as a whole address, and only inside its own range", () => {
	const scrub = (html) => scrubMarkup(html, "https://app.test/").html;
	assert.equal(scrub("<p>10.0.0.7</p>"), "<p>app.example</p>");
	assert.equal(scrub("<p>192.168.15.4:8080</p>"), "<p>app.example</p>");
	assert.equal(scrub("<p>http://172.20.3.4/x</p>"), "<p>https://app.example/x</p>");
	// Not private: 110.1.2.3 is not 10.x, and 172.32 is outside 172.16 to 172.31.
	assert.equal(scrub("<p>110.1.2.3</p>"), "<p>110.1.2.3</p>");
	assert.equal(scrub("<p>172.32.0.1</p>"), "<p>172.32.0.1</p>");
	// An octet above 255 is not an address.
	assert.equal(scrub("<p>10.999.0.1</p>"), "<p>10.999.0.1</p>");
	assert.equal(scrub("<p>x10.0.0.1y</p>"), "<p>x10.0.0.1y</p>");
});
