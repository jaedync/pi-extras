// The look's font. HyperFrames resolves its bundled families by name; any other family needs an
// @font-face to a file in the project, or the render falls back to a generic face. So the composer
// fetches the family's Latin woff2 files from Google Fonts once, at compose time, into assets/fonts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUNDLED = new Set(["Inter", "Montserrat", "Outfit", "Nunito", "Oswald", "League Gothic", "Archivo Black", "Space Mono", "IBM Plex Mono", "JetBrains Mono", "EB Garamond", "Playfair Display", "Source Code Pro", "Noto Sans JP", "Roboto", "Open Sans", "Lato", "Poppins"]);
const WEIGHTS = [500, 600, 700];
// Google Fonts serves woff2 only to a browser user agent.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TIMEOUT_MS = 15_000;

/** Keeps the latin and latin-ext @font-face blocks; Google labels each block with a comment. */
export function latinBlocks(css) {
	const blocks = [];
	const re = /\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*{[^}]*})/g;
	for (let m = re.exec(css); m; m = re.exec(css)) if (m[1] === "latin" || m[1] === "latin-ext") blocks.push(m[2]);
	return blocks;
}

async function get(url, as) {
	const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return as === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
}

/**
 * Returns { family, css, warning }. css holds @font-face rules that point at assets/fonts.
 * When the fetch fails (offline, unknown family), the family falls back to Inter with a warning.
 */
export async function projectFont(family, outDir) {
	if (BUNDLED.has(family)) return { family, css: "" };
	try {
		const api = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${WEIGHTS.join(";")}&display=block`;
		const blocks = latinBlocks(await get(api, "text"));
		if (!blocks.length) throw new Error("no Latin faces in the response");
		mkdirSync(join(outDir, "assets/fonts"), { recursive: true });
		const rules = [];
		for (const [i, block] of blocks.entries()) {
			const url = block.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
			if (!url) continue;
			const name = `${family.replace(/\W+/g, "-").toLowerCase()}-${i}.woff2`;
			writeFileSync(join(outDir, "assets/fonts", name), await get(url, "bytes"));
			rules.push(block.replace(url, `assets/fonts/${name}`));
		}
		return { family, css: rules.join("\n") };
	} catch (e) {
		return { family: "Inter", css: "", warning: `Font "${family}" could not be fetched (${e.message}); the video uses Inter. Put woff2 files in assets/fonts and an @font-face in index.html to use it.` };
	}
}
