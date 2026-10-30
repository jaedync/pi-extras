/**
 * Locates the installed runtime: playwright-core from the cache when `wv setup`
 * has run, otherwise the copy in this repo (a documented fallback, so tests and
 * a checkout both work before setup). Also finds the headless shell binary that
 * carries the HeadlessExperimental domain.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { paths } from "./paths.mjs";

export async function loadPlaywright(env = process.env) {
	const cached = join(paths(env).playwright, "index.mjs");
	if (existsSync(cached)) return { chromium: (await import(pathToFileURL(cached).href)).chromium, source: cached };
	const module = await import("playwright-core");
	return { chromium: module.chromium, source: "playwright-core from node_modules" };
}

/** chrome-headless-shell lives beside chromium in the Playwright browser cache, same revision. */
export function headlessShellPath(chromium) {
	const full = chromium.executablePath();
	// <root>/chromium-<rev>/chrome-linux64/chrome -> <root>/chromium_headless_shell-<rev>/...
	const revision = basename(dirname(dirname(full))).replace(/^chromium-/, "");
	const root = dirname(dirname(dirname(full)));
	const names = process.platform === "darwin" ? ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64"] : process.platform === "win32" ? ["chrome-headless-shell-win64"] : ["chrome-headless-shell-linux64"];
	for (const name of names) {
		const executable = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
		const candidate = join(root, `chromium_headless_shell-${revision}`, name, executable);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function chromiumPath(chromium) {
	const path = chromium.executablePath();
	return existsSync(path) ? path : null;
}

/** Both browser paths from one executablePath, for `wv setup --check`. */
export function browserPaths(chromium) {
	if (!chromium) return { shell: null, chromium: null };
	let full = null;
	try {
		full = chromium.executablePath();
	} catch {
		return { shell: null, chromium: null };
	}
	return { shell: headlessShellPath(chromium), chromium: full && existsSync(full) ? full : null };
}
