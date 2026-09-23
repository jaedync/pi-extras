// Check the committed preview image, and render the two ways people actually see
// it, so a human can look before release:
//   - a 4:3 centre crop (chat apps and some link unfurls crop the 2:1 card)
//   - the README at GitHub's content width, from the committed WebP
//   npm run preview:check [-- --open]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PREVIEW_DIR, previewProblems, README_IMAGE, SOCIAL, socialProblems } from "./image-facts.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const README_WIDTH = 880; // GitHub's README column on a desktop browser
const CROP_WIDTH = Math.round((SOCIAL.height * 4) / 3);

// A data URL, because Chromium will not load file:// images into a page set with setContent.
const dataUrl = (path) => `data:image/${path.endsWith(".webp") ? "webp" : "png"};base64,${readFileSync(path).toString("base64")}`;

async function views(imageDir) {
	const out = mkdtempSync(join(tmpdir(), "pi-extras-preview-check-"));
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: CROP_WIDTH, height: SOCIAL.height } });
		const left = (SOCIAL.width - CROP_WIDTH) / 2;
		await page.setContent(`<body style="margin:0;overflow:hidden"><img src="${dataUrl(join(imageDir, SOCIAL.file))}" style="margin-left:-${left}px;display:block">`);
		await page.waitForFunction(() => document.images[0].complete);
		await page.screenshot({ path: join(out, "crop-4x3.png") });
		const readme = await browser.newPage({ viewport: { width: README_WIDTH, height: README_WIDTH / 2 }, deviceScaleFactor: 2 });
		await readme.setContent(`<body style="margin:0"><img src="${dataUrl(join(imageDir, README_IMAGE.file))}" style="width:${README_WIDTH}px;display:block">`);
		await readme.waitForFunction(() => document.images[0].complete);
		await readme.screenshot({ path: join(out, "readme-width.png") });
	} finally {
		await browser.close();
	}
	return [join(out, "crop-4x3.png"), join(out, "readme-width.png")];
}

/** Print problems and the review views; with strict, problems fail the process. */
export async function runChecks({ imageDir = join(root, PREVIEW_DIR), strict = true, open = false } = {}) {
	const problems = strict ? [...previewProblems(root), ...socialProblems(imageDir)] : [];
	for (const problem of problems) console.error(`preview: ${problem}`);
	const paths = await views(imageDir);
	console.log(`look at these before releasing:\n  ${[join(imageDir, SOCIAL.file), ...paths].join("\n  ")}`);
	console.log("then upload the 1x image under the repository's Settings > General > Social preview");
	if (open && process.platform === "darwin") execFileSync("open", [join(imageDir, SOCIAL.file), ...paths]);
	if (problems.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	runChecks({ open: process.argv.includes("--open") }).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
