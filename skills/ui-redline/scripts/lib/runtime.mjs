/**
 * Finds playwright-core and a Chromium, and installs them on request. The
 * install is a pinned cache in ${XDG_CACHE_HOME:-~/.cache}/pi-ui-redline; the
 * walkthrough-video cache and a checkout's node_modules also work, so a host
 * that already has one needs no second install.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PLAYWRIGHT_CORE = "1.63.0";
// Longer than the worst setup (two commands of up to 20 minutes each), so a live setup keeps its lock.
const LOCK_STALE_MS = 60 * 60_000;

export function cacheRoot(env = process.env, home = homedir()) {
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), "pi-ui-redline");
}

function candidates(env = process.env, home = homedir()) {
	const cache = env.XDG_CACHE_HOME || join(home, ".cache");
	return [join(cacheRoot(env, home), "node_modules", "playwright-core"), join(cache, "pi-walkthrough-video", "node_modules", "playwright-core")];
}

export const SETUP_HINT = "run `node <skill-dir>/scripts/redline.mjs setup` once (it installs playwright-core into ~/.cache/pi-ui-redline and Chromium's headless shell into Playwright's browser cache)";

/** playwright-core's chromium from the first place that has it. */
export async function loadChromium(env = process.env) {
	for (const dir of candidates(env)) {
		const entry = join(dir, "index.mjs");
		if (existsSync(entry)) return { chromium: (await import(pathToFileURL(entry).href)).chromium, source: dir };
	}
	try {
		return { chromium: (await import("playwright-core")).chromium, source: "node_modules" };
	} catch {
		throw new Error(`playwright-core is not installed: ${SETUP_HINT}`);
	}
}

/** Launches headless Chromium; a missing browser becomes an error that names the fix. */
export async function launch(chromium) {
	try {
		return await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
	} catch (error) {
		const message = String(error?.message ?? error);
		if (/Executable doesn't exist/.test(message)) throw new Error(`Chromium is not installed for playwright-core: ${SETUP_HINT}`);
		throw new Error(`Chromium did not start: ${message.split("\n").slice(0, 6).join(" ")}`);
	}
}

function packageVersion(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
	} catch {
		return null;
	}
}

function lock(path) {
	try {
		closeSync(openSync(path, "wx", 0o600));
		return () => rmSync(path, { force: true });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
			rmSync(path, { force: true });
			return lock(path);
		}
		throw new Error(`another redline setup is running (lock ${path}). Wait for it, or remove the file if that run is gone.`);
	}
}

function run(command, args, cwd, log) {
	log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20 * 60_000 });
	if (result.error || result.status !== 0) {
		const tail = `${result.stderr || ""}${result.stdout || ""}`.trim().split("\n").slice(-5).join("\n");
		throw new Error(`${command} ${args[0]} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}\n${tail}`);
	}
}

/** Installs the pinned playwright-core and the headless shell. Idempotent. */
export async function setup({ check = false, log = console.error, env = process.env } = {}) {
	const root = cacheRoot(env);
	const dir = join(root, "node_modules", "playwright-core");
	const installed = packageVersion(dir) === PLAYWRIGHT_CORE;
	if (check) {
		let browser = false;
		if (installed) {
			const { chromium } = await import(pathToFileURL(join(dir, "index.mjs")).href);
			browser = await launch(chromium).then((b) => b.close().then(() => true), () => false);
		}
		return { root, playwright: installed ? PLAYWRIGHT_CORE : null, browser };
	}
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const release = lock(join(root, ".lock"));
	try {
		if (!installed) {
			writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "pi-ui-redline-runtime", private: true, dependencies: { "playwright-core": PLAYWRIGHT_CORE } }, null, 2)}\n`);
			run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", `playwright-core@${PLAYWRIGHT_CORE}`], root, log);
		}
		run(process.execPath, [join(dir, "cli.js"), "install", "chromium-headless-shell"], root, log);
	} finally {
		release();
	}
	return setup({ check: true, log, env });
}
