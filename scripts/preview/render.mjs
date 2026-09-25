// Render the README and social preview image from a real staged Pi session.
//
//   npm run preview:render              stage a fresh session (stage.sh), pick its best frame, render
//   npm run preview:render -- --reuse   re-render the committed frame.ansi (layout changes only)
//   npm run preview:render -- --try "rx=40&size=62"
//                                       render a layout trial to a temp dir; the repo is untouched
//
// Writes .github/preview/{pi-extras@2x.webp, meta.json} (committed) and pi-extras.png (the social
// preview upload, ignored by git), then runs the checks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { parseFrame } from "./ansi-frame.mjs";
import { PREVIEW_DIR, README_IMAGE, SOCIAL } from "./image-facts.mjs";
import { runChecks } from "./check.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const FRAME_FILE = join(here, "frame.ansi");
const FONT_ZIP = {
	url: "https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip",
	sha256: "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf",
	files: ["JetBrainsMono-Regular.ttf", "JetBrainsMono-Bold.ttf", "JetBrainsMono-Italic.ttf"],
};

const args = process.argv.slice(2);
const reuse = args.includes("--reuse");
const trial = args.includes("--try") ? args[args.indexOf("--try") + 1] ?? "" : undefined;

/** JetBrains Mono (OFL), fetched once into a cache and verified against a pinned hash. */
async function fonts() {
	const dir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-extras-preview", "fonts");
	if (FONT_ZIP.files.every((file) => existsSync(join(dir, file)))) return dir;
	mkdirSync(dir, { recursive: true });
	const response = await fetch(FONT_ZIP.url);
	if (!response.ok) throw new Error(`font download failed: HTTP ${response.status}`);
	const zip = Buffer.from(await response.arrayBuffer());
	const digest = createHash("sha256").update(zip).digest("hex");
	if (digest !== FONT_ZIP.sha256) throw new Error(`font archive hash mismatch: ${digest}`);
	const zipPath = join(dir, "fonts.zip");
	writeFileSync(zipPath, zip);
	execFileSync("unzip", ["-j", "-o", "-q", zipPath, ...FONT_ZIP.files.map((file) => `fonts/ttf/${file}`), "-d", dir]);
	rmSync(zipPath);
	return dir;
}

const plain = (text) => text.replace(/\x1b\[[0-9;:]*m/g, "");
const litDots = (line) => [...line].reduce((sum, ch) => {
	const code = ch.codePointAt(0) - 0x2800;
	return code > 0 && code < 256 ? sum + code.toString(2).replaceAll("0", "").length : sum;
}, 0);

/**
 * The frame that shows the most at once: both jobs running, the diff on screen, the phase row
 * with a TPS reading and voice recording. Among those, the most transcribed chunks (◆) win, then
 * a chunk mid-decode (◈), then the fullest level meter.
 */
export function pickFrame(frames) {
	let best;
	for (const text of frames) {
		const lines = plain(text).split("\n");
		const voice = lines.find((line) => /^── ● \d+:\d\d /.test(line));
		// The jobs widget sits right above the phase row, one band per running job.
		const phase = lines.findIndex((line) => line.includes("TPS"));
		const widget = phase > 1 ? lines.slice(phase - 2, phase) : [];
		const running = (title) => widget.some((line) => line.trimStart().startsWith(title));
		const ready = voice && running("Run unit tests") && running("Watch types") && lines.some((l) => l.includes("TAIL_CELL_MIN = 10"));
		if (!ready) continue;
		const score = [...voice].filter((ch) => ch === "◆").length * 2000 + (voice.includes("◈") ? 1000 : 0) + litDots(voice);
		if (!best || score > best.score) best = { text, score };
	}
	if (!best) throw new Error("no staged frame showed jobs, diff, phase row and voice together; re-run the stage");
	return best.text;
}

function stage() {
	const dir = mkdtempSync(join(tmpdir(), "pi-extras-frames-"));
	try {
		execFileSync("bash", [join(here, "stage.sh"), dir], { stdio: "inherit" });
		const frames = readdirSync(dir).sort().map((file) => readFileSync(join(dir, file), "utf8"));
		return pickFrame(frames);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Quality for Chromium's WebP encoder: the smallest setting that keeps the thin red and green diff text crisp. */
const WEBP_QUALITY = 0.9;

/** Re-encode a PNG as WebP in the browser that drew it, so the pipeline needs no image tools. */
async function toWebp(browser, pngPath, webpPath) {
	const page = await browser.newPage();
	const base64 = await page.evaluate(async ({ png, quality }) => {
		const image = new Image();
		image.src = `data:image/png;base64,${png}`;
		await image.decode();
		const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
		canvas.getContext("2d").drawImage(image, 0, 0);
		const blob = await canvas.convertToBlob({ type: "image/webp", quality });
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result).split(",")[1]);
			reader.readAsDataURL(blob);
		});
	}, { png: readFileSync(pngPath).toString("base64"), quality: WEBP_QUALITY });
	await page.close();
	writeFileSync(webpPath, Buffer.from(base64, "base64"));
}

async function shoot(page, url, path) {
	await page.goto(url);
	await page.waitForSelector("body[data-ready]");
	await page.locator("#stage").screenshot({ path });
}

async function main() {
	const frameText = reuse || trial !== undefined ? readFileSync(FRAME_FILE, "utf8") : stage();
	// The frame is committed, so the machine's own paths must not be in it, even off-image.
	if (frameText.includes(homedir())) throw new Error("the staged frame contains your home path; it must not be committed");
	if (!reuse && trial === undefined) writeFileSync(FRAME_FILE, frameText);

	const build = mkdtempSync(join(tmpdir(), "pi-extras-card-"));
	for (const file of ["card.html", "term.js", "hero.js"]) copyFileSync(join(here, file), join(build, file));
	mkdirSync(join(build, "fonts"));
	const fontDir = await fonts();
	for (const file of FONT_ZIP.files) copyFileSync(join(fontDir, file), join(build, "fonts", file));
	writeFileSync(join(build, "frame.js"), `window.FRAME = ${JSON.stringify(parseFrame(frameText))};\n`);

	const url = `${pathToFileURL(join(build, "card.html")).href}${trial ? `?${trial}` : ""}`;
	const outDir = trial !== undefined ? build : join(root, PREVIEW_DIR);
	mkdirSync(outDir, { recursive: true });
	const browser = await chromium.launch({ args: ["--allow-file-access-from-files", "--font-render-hinting=none"] });
	try {
		for (const [path, scale] of [[join(outDir, SOCIAL.file), 1], [join(build, "retina.png"), 2]]) {
			const page = await browser.newPage({ viewport: { width: SOCIAL.width, height: SOCIAL.height }, deviceScaleFactor: scale });
			await shoot(page, url, path);
			await page.close();
		}
		await toWebp(browser, join(build, "retina.png"), join(outDir, README_IMAGE.file));
	} finally {
		await browser.close();
	}

	if (trial !== undefined) {
		console.log(`trial render: ${join(outDir, SOCIAL.file)}`);
		await runChecks({ imageDir: outDir, strict: false });
		return;
	}
	rmSync(build, { recursive: true, force: true });
	const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	const frameSha256 = createHash("sha256").update(frameText).digest("hex");
	writeFileSync(join(outDir, "meta.json"), `${JSON.stringify({ version, frameSha256 }, null, 2)}\n`);
	console.log(`rendered ${PREVIEW_DIR}/${README_IMAGE.file} and ${SOCIAL.file} for ${version}`);
	await runChecks({ imageDir: outDir, strict: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
