/**
 * `wv lift <url>`: takes the brand from the live app, so the film is built
 * from the product's own colours, type, curves and stylesheet, not from a
 * guess. It writes:
 *
 *   tokens.json   the roles (ground, ink, surfaces, accent, fonts, springs)
 *                 and the whole colour palette, with the CSS variable names
 *   brand.css     the app's custom properties and @font-face rules that
 *                 point to the local font files, for the film page
 *   app.css       the app's own stylesheets, transitions removed, so a scene
 *                 can rebuild the UI with the app's markup and class names
 *   fonts/        the font files that the page declares
 *   facts.json    the raw facts (for a second look)
 *   lift.png      the page as lift saw it (lift-<state>.png for each state)
 *   markup-<state>.html  the body of each state, scripts removed, local
 *                 addresses replaced by app.example, with the
 *                 app's class names: paste it into a scene and style it with app.css
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../lib/args.mjs";
import { launchBrowser, trackBrowser } from "../lib/browser.mjs";
import { loadPlaywright } from "../lib/runtime.mjs";
import { collectPageFacts } from "./lift-page.mjs";
import { pathToFileURL } from "node:url";
import { assignRoles, inksByGround, scrubMarkup, stripTransitions } from "./tokens.mjs";
import { privateFindings } from "./page-check.mjs";

const USAGE = `wv lift <url> [--flow <states.mjs>] [--out <dir>] [--width 1920] [--height 1080] [--wait <ms>] [--json]

Takes the brand tokens from the live page: ground, inks, surfaces, accent,
fonts (with the font files), springs and keyframes, and the app's stylesheet
without transitions. Writes tokens.json, brand.css, app.css, fonts/,
facts.json, lift.png and markup-start.html to --out (default ./lift).

--flow takes the app to more states, so the tokens cover the app as well
as the landing page. It default-exports async (page, lift) => { ... }: drive
the Playwright page, then call await lift.state("room") at each state. Each
state adds its grounds and inks (tokens.states, tokens.inksByGround), a
screenshot lift-<name>.png and its markup markup-<name>.html.`;

/** Runs in the page: the body markup without scripts, with the form values written into it. */
function pageMarkup() {
	const body = /** @type {HTMLElement} */ (document.body.cloneNode(true));
	const live = document.body.querySelectorAll("input, textarea");
	body.querySelectorAll("input, textarea").forEach((el, i) => {
		const value = /** @type {HTMLInputElement} */ (live[i]).value;
		if (el.tagName === "TEXTAREA") el.textContent = value;
		else el.setAttribute("value", value);
	});
	body.querySelectorAll("script, noscript").forEach((el) => el.remove());
	return body.outerHTML;
}

/** Short text for the terminal: one line for each role. */
export function formatTokens(t) {
	const c = (x) => (x ? `${x.color}${x.var ? ` (${x.var})` : ""}` : "none");
	const lines = [
		`ground      ${c(t.ground)}${t.ground?.selector ? ` on ${t.ground.selector}, ${Math.round(t.ground.share * 100)} % of the screen` : ""}`,
		`ink         ${c(t.ink)}`,
		`ink 2nd     ${t.inkSecondary.map(c).join(", ") || "none"}`,
		`surfaces    ${t.surfaces.map(c).join(", ") || "none"}`,
		`accent      ${c(t.accent)}`,
		...t.fonts.map((f) => `font        ${f.family} ${f.weight}${f.variation ? ` ${f.variation}` : ""} (${f.role}, weights ${f.weights.join("/")}, up to ${f.maxSize}px)`),
		...Object.entries(t.inksByGround ?? {}).map(([ground, inks]) => `on ${ground}  ${inks.slice(0, 6).map(c).join(", ")}`),
		...t.motion.springs.map((s) => `spring      ${s.value} x${s.uses}`),
		...t.motion.eases.slice(0, 3).map((s) => `ease        ${s.value} x${s.uses}`),
		`keyframes   ${t.motion.keyframes.join(", ") || "none"}`,
		`palette     ${Object.keys(t.palette).length} colour variables`,
	];
	return lines.join("\n");
}

/**
 * The name of a lifted font file: its own name without the query string, made
 * safe for a path, and never the name another face already took.
 */
export function fontFile(url, taken = new Set()) {
	let base = "";
	try {
		base = decodeURIComponent(basename(new URL(url).pathname));
	} catch {
		base = "";
	}
	base = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "font";
	const ext = extname(base);
	const stem = ext ? base.slice(0, base.length - ext.length) : base;
	let file = base;
	for (let n = 2; taken.has(file); n++) file = `${stem}-${n}${ext}`;
	return file;
}

/** The CSS format() hint for a font file, or null when its extension says nothing. */
export function fontFormat(file) {
	const ext = extname(String(file)).toLowerCase();
	if (ext === ".woff2") return "woff2";
	if (ext === ".woff") return "woff";
	if (ext === ".ttf") return "truetype";
	if (ext === ".otf") return "opentype";
	return null;
}

/** A font family as a CSS string: a family with an apostrophe must not end the string. */
function cssFamily(family) {
	return `'${String(family).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** brand.css: the custom properties, and @font-face rules for the local files. */
export function brandCss(tokens, faces) {
	const vars = Object.entries(tokens.palette).map(([name, value]) => `  ${name}: ${value};`);
	const roles = [
		tokens.ground && `  --wv-ground: ${tokens.ground.color};`,
		tokens.ink && `  --wv-ink: ${tokens.ink.color};`,
		...tokens.inkSecondary.map((ink, i) => `  --wv-ink-${i + 2}: ${ink.color};`),
		tokens.accent && `  --wv-accent: ${tokens.accent.color};`,
		tokens.motion.springs[0] && `  --wv-spring: ${tokens.motion.springs[0].value};`,
		...["display", "body"].flatMap((role) => {
			const font = tokens.fonts.find((f) => f.role === role);
			return font ? [`  --wv-font-${role}: '${font.family}', sans-serif;`, `  --wv-font-${role}-weight: ${font.weight};`] : [];
		}),
	].filter(Boolean);
	const fontFaces = faces.map((f) => {
		const format = fontFormat(f.file);
		return `@font-face {\n  font-family: ${cssFamily(f.family)};\n  src: url('fonts/${f.file}')${format ? ` format('${format}')` : ""};\n  font-weight: ${f.weight};\n  font-style: ${f.style};\n}`;
	});
	// No source URL here: this file goes into the film page, and the app often runs on a local address.
	return `/* Lifted by wv lift (tokens.json names the source). */\n${fontFaces.join("\n")}\n:root {\n${[...vars, ...roles].join("\n")}\n}\n`;
}

export async function lift({ url, out, flow = null, width = 1920, height = 1080, waitMs = 1500, log = (_line) => {} }) {
	const { chromium } = await loadPlaywright();
	const browser = await launchBrowser(chromium);
	const untrack = trackBrowser(browser);
	try {
		const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
		const page = await context.newPage();
		await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
		await page.evaluate(() => document.fonts.ready);
		// Intro animations finish first, so the facts describe the page at rest.
		await page.waitForTimeout(waitMs);
		const facts = await page.evaluate(collectPageFacts);
		mkdirSync(join(out, "fonts"), { recursive: true });
		await page.screenshot({ path: join(out, "lift.png") });
		const saveMarkup = async (slug) => {
			const { html, replaced } = scrubMarkup(await page.evaluate(pageMarkup), page.url());
			writeFileSync(join(out, `markup-${slug}.html`), `${html}\n`);
			if (replaced) log(`markup-${slug}.html: ${replaced} local address(es) replaced by app.example`);
			const left = privateFindings(html.replace(/<[^>]*>/g, " "));
			if (left.length) log(`markup-${slug}.html: private data to replace before a scene uses it: ${[...new Set(left.map((f) => `${f.kind} ${f.match}`))].slice(0, 5).join(", ")}`);
		};
		await saveMarkup("start");
		const states = [{ name: "start", facts }];
		if (flow) {
			const run = (await import(pathToFileURL(resolve(flow)).href)).default;
			if (typeof run !== "function") throw new UsageError(`lift: ${flow} must default-export async (page, lift) => {}`);
			await run(page, {
				state: async (name) => {
					await page.evaluate(() => document.fonts.ready);
					await page.waitForTimeout(waitMs);
					states.push({ name: String(name), facts: await page.evaluate(collectPageFacts) });
					const slug = String(name).replace(/[^\w-]+/g, "_");
					await page.screenshot({ path: join(out, `lift-${slug}.png`) });
					await saveMarkup(slug);
				},
			});
		}
		// The stylesheet facts can grow as the app opens views; take them from the last state.
		const last = states.at(-1).facts;
		Object.assign(facts, { vars: last.vars, fontFaces: last.fontFaces, easings: last.easings, keyframes: last.keyframes, literals: last.literals, css: last.css, skippedSheets: last.skippedSheets });
		const faces = [];
		for (const face of facts.fontFaces) {
			if (!face.src) continue;
			const response = await context.request.get(face.src).catch(() => null);
			if (!response?.ok()) {
				log(`lift: font ${face.src} did not download`);
				continue;
			}
			const file = fontFile(face.src, new Set(faces.map((taken) => taken.file)));
			writeFileSync(join(out, "fonts", file), await response.body());
			faces.push({ ...face, file });
		}
		const tokens = assignRoles(facts);
		// The shortest variable name wins, as in assignRoles: --accent before --accent-hover.
		const varOf = Object.fromEntries(Object.entries(tokens.palette).sort((a, b) => b[0].length - a[0].length).map(([name, hex]) => [hex, name]));
		tokens.inksByGround = inksByGround(states.flatMap((st) => st.facts.texts), varOf);
		tokens.states = states.map(({ name, facts: f }) => {
			const roles = assignRoles({ ...facts, grounds: f.grounds, texts: f.texts });
			return { name, ground: roles.ground, ink: roles.ink, inkSecondary: roles.inkSecondary, fonts: roles.fonts.map(({ family, weight, weights }) => ({ family, weight, weights })) };
		});
		tokens.fontFiles = faces.map((f) => ({ family: f.family, file: `fonts/${f.file}`, weight: f.weight }));
		// The font roles point to the local copies, not to the app's server.
		for (const font of tokens.fonts) {
			const face = faces.find((f) => f.family === font.family);
			if (face) font.src = `fonts/${face.file}`;
			else delete font.src;
		}
		let appCss = facts.css.map((s) => `/* ${s.href ?? "inline <style>"} */\n${s.text}`).join("\n\n");
		for (const face of faces) appCss = appCss.split(face.src).join(`fonts/${face.file}`).split(new URL(face.src).pathname).join(`fonts/${face.file}`);
		writeFileSync(join(out, "tokens.json"), `${JSON.stringify(tokens, null, 1)}\n`);
		writeFileSync(join(out, "brand.css"), brandCss(tokens, faces));
		writeFileSync(join(out, "app.css"), `${stripTransitions(appCss)}\n`);
		writeFileSync(join(out, "facts.json"), `${JSON.stringify({ ...facts, css: undefined, states: states.map((st) => ({ name: st.name, grounds: st.facts.grounds, texts: st.facts.texts })) }, null, 1)}\n`);
		if (facts.skippedSheets.length) log(`lift: ${facts.skippedSheets.length} cross-origin stylesheet(s) could not be read`);
		return tokens;
	} finally {
		untrack();
		await browser.close().catch(() => {});
	}
}

/** The smaller size for one more try when the page crashed (a WebGL page needs RAM), or null. */
export function crashRetrySize(error, { width, height }) {
	if (!/(Target|Page) crashed/i.test(String(error?.message ?? error))) return null;
	if (width <= 1280 && height <= 720) return null;
	return { width: 1280, height: 720 };
}

export async function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	let parsed;
	try {
		parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { out: { type: "string" }, flow: { type: "string" }, width: { type: "string" }, height: { type: "string" }, wait: { type: "string" }, json: { type: "boolean" } } });
	} catch (error) {
		throw new UsageError(`lift: ${error.message}`);
	}
	const { values, positionals } = parsed;
	if (positionals.length !== 1) throw new UsageError("wv lift needs one URL");
	const number = (v, name, d) => {
		if (v === undefined) return d;
		const n = Number(v);
		if (!Number.isInteger(n) || n < 0) throw new UsageError(`lift: ${name} must be a whole number`);
		return n;
	};
	const out = resolve(values.out ?? "lift");
	const log = (line) => process.stderr.write(`${line}\n`);
	const options = { url: positionals[0], out, flow: values.flow ?? null, width: number(values.width, "--width", 1920), height: number(values.height, "--height", 1080), waitMs: number(values.wait, "--wait", 1500), log };
	let tokens;
	try {
		tokens = await lift(options);
	} catch (error) {
		const smaller = crashRetrySize(error, options);
		if (!smaller) throw error;
		log(`lift: the page crashed at ${options.width}x${options.height} (a WebGL page needs RAM); trying once more at ${smaller.width}x${smaller.height}`);
		tokens = await lift({ ...options, ...smaller });
	}
	process.stdout.write(values.json ? `${JSON.stringify(tokens, null, 1)}\n` : `${formatTokens(tokens)}\n\nwrote ${out}\n`);
	return 0;
}
