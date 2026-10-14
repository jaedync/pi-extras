/**
 * Reads a page with a local headless Chrome or Chromium when a site refuses
 * plain HTTP clients. Chrome's own `--dump-dom` does the work, so pi-extras
 * needs no browser library: it finds a browser that is already installed,
 * runs it with a throwaway profile behind the address guard, and prints the
 * page after its scripts ran. Most bot checks pass a real browser; the one
 * thing they catch is the "HeadlessChrome" token in the default user agent,
 * so the agent names the browser's own version without it.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startGuard } from "./browser-guard.ts";
import { MAX_BODY_BYTES } from "./http.ts";

export const BROWSER_TIMEOUT_MS = 30_000;
/**
 * Chrome prints the page at its load event, which ad scripts can hold back for
 * a long time. At this limit it stops loading and prints what it has; the
 * text is there long before.
 */
const LOAD_LIMIT_MS = 10_000;
/** Each browser takes a few hundred MB; auto-pull can ask for several links at once. */
const MAX_BROWSERS = 2;
const VERSION_TIMEOUT_MS = 5_000;
const FALLBACK_MAJOR = "141";
export const INSTALL_COMMAND = "npx playwright install chromium";

export interface RenderOptions {
	readonly signal?: AbortSignal;
	/** A browser binary; without it the usual places are searched. */
	readonly browser?: string;
	/** Paths to try instead of the usual places. */
	readonly candidates?: readonly string[];
	readonly timeoutMs?: number;
	readonly maxBytes?: number;
}

export type Renderer = (url: string, options?: RenderOptions) => Promise<string>;

const CHALLENGE_TITLE = /<title[^>]*>\s*(?:Just a moment\.\.\.|Attention Required! \| Cloudflare|Please Wait\.\.\. \| Cloudflare|Checking your browser|DDoS-Guard|Vercel Security Checkpoint|Pardon Our Interruption|Access Denied)/i;

/** A bot-check page in place of the content. Cloudflare's bot script is on normal pages too, so only the challenge's own marks count. */
export function isChallenge(html: string): boolean {
	return CHALLENGE_TITLE.test(html.slice(0, 20_000)) || /window\._cf_chl_opt\b/.test(html.slice(0, 50_000));
}

export interface Where {
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly list: (dir: string) => string[];
}

const PLAYWRIGHT_CACHE: Readonly<Record<string, string>> = { linux: ".cache/ms-playwright", darwin: "Library/Caches/ms-playwright", win32: "AppData/Local/ms-playwright" };
const TESTING_APP = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const LAYOUT: Readonly<Record<string, { chromium: readonly string[]; shell: readonly string[] }>> = {
	linux: { chromium: ["chrome-linux64/chrome", "chrome-linux/chrome"], shell: ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"] },
	darwin: { chromium: [`chrome-mac-arm64/${TESTING_APP}`, `chrome-mac-x64/${TESTING_APP}`, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"], shell: ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell"] },
	win32: { chromium: ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"], shell: ["chrome-headless-shell-win64/chrome-headless-shell.exe"] },
};
const LINUX_NAMES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

function systemBrowsers(where: Where): string[] {
	if (where.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", join(where.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
	if (where.platform === "win32") return [where.env.PROGRAMFILES, where.env["PROGRAMFILES(X86)"], where.env.LOCALAPPDATA].filter((dir): dir is string => !!dir).map((dir) => join(dir, "Google/Chrome/Application/chrome.exe"));
	const dirs = [...new Set([...(where.env.PATH ?? "").split(delimiter).filter(Boolean), "/usr/bin", "/usr/local/bin", "/snap/bin"])];
	return [...dirs.flatMap((dir) => LINUX_NAMES.map((name) => join(dir, name))), "/opt/google/chrome/chrome"];
}

/** Playwright's browser folders of one kind, newest first. */
function playwrightBuilds(cache: string, prefix: string, list: Where["list"]): string[] {
	const pattern = new RegExp(`^${prefix}-(\\d+)$`);
	return list(cache).map((name) => ({ name, build: Number(pattern.exec(name)?.[1] ?? -1) })).filter((entry) => entry.build >= 0).sort((a, b) => b.build - a.build).map((entry) => join(cache, entry.name));
}

/**
 * Places a browser can be, best first: a system Chrome, then Playwright's
 * Chromium, then Playwright's headless shell, which more sites refuse.
 */
export function browserCandidates(where: Where): string[] {
	const layout = LAYOUT[where.platform] ?? LAYOUT.linux!;
	const cache = where.env.PLAYWRIGHT_BROWSERS_PATH || join(where.home, PLAYWRIGHT_CACHE[where.platform] ?? PLAYWRIGHT_CACHE.linux!);
	const builds = (prefix: string, paths: readonly string[]) => playwrightBuilds(cache, prefix, where.list).flatMap((dir) => paths.map((path) => join(dir, path)));
	return [...systemBrowsers(where), ...builds("chromium", layout.chromium), ...builds("chromium_headless_shell", layout.shell)];
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

const here = (): Where => ({ platform: process.platform, home: homedir(), env: process.env, list: listDir });

const PLATFORM_TOKEN: Readonly<Record<string, string>> = { linux: "X11; Linux x86_64", darwin: "Macintosh; Intel Mac OS X 10_15_7", win32: "Windows NT 10.0; Win64; x64" };

/** The user agent of a normal desktop Chrome of the same major version as the browser. */
export function browserAgent(versionText: string, platform: NodeJS.Platform): string {
	const major = /(\d+)\.\d+\.\d+/.exec(versionText)?.[1] ?? FALLBACK_MAJOR;
	return `Mozilla/5.0 (${PLATFORM_TOKEN[platform] ?? PLATFORM_TOKEN.linux}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const versions = new Map<string, Promise<string>>();

/** `--version` once per binary; Chrome on Windows prints nothing, and the agent then uses a recent version. */
function versionOf(binary: string): Promise<string> {
	let known = versions.get(binary);
	if (!known) {
		known = new Promise((resolve) => execFile(binary, ["--version"], { timeout: VERSION_TIMEOUT_MS }, (_error, stdout) => resolve(String(stdout ?? "").trim())));
		versions.set(binary, known);
	}
	return known;
}

let running = 0;
const waiting: Array<() => void> = [];

/** A browser slot; a finished browser hands its slot straight to the next waiter. */
async function acquire(signal: AbortSignal | undefined): Promise<void> {
	signal?.throwIfAborted();
	if (running < MAX_BROWSERS) {
		running++;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const go = () => {
			signal?.removeEventListener("abort", stop);
			resolve();
		};
		const stop = () => {
			const at = waiting.indexOf(go);
			if (at >= 0) waiting.splice(at, 1);
			reject(signal?.reason);
		};
		waiting.push(go);
		signal?.addEventListener("abort", stop, { once: true });
	});
}

function release(): void {
	const next = waiting.shift();
	if (next) next();
	else running--;
}

function chromeArgs(url: string, profile: string, port: number, agent: string, loadMs: number): string[] {
	return [
		"--headless",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--disable-client-side-phishing-detection",
		"--disable-domain-reliability",
		"--disable-breakpad",
		"--no-pings",
		"--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
		"--mute-audio",
		// The text is all that is kept; images only hold back the load event.
		"--blink-settings=imagesEnabled=false",
		// Chrome refuses to start as root with its sandbox, as in many containers.
		...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
		`--user-data-dir=${profile}`,
		// Every request goes through the guard; `<-loopback>` stops Chrome from sending loopback addresses around it.
		`--proxy-server=http://127.0.0.1:${port}`,
		"--proxy-bypass-list=<-loopback>",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		`--user-agent=${agent}`,
		`--timeout=${loadMs}`,
		"--dump-dom",
		url,
	];
}

/** Stops the browser and every helper process it started. */
function killTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim().slice(0, 300) ?? "";

function run(binary: string, args: readonly string[], signal: AbortSignal | undefined, timeoutMs: number, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		// Its own process group, so one signal stops the renderers and helpers too.
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		let failure: unknown;
		const stop = (error: unknown) => {
			failure ??= error;
			killTree(child);
		};
		const timer = setTimeout(() => stop(new Error(`The local browser did not finish in ${Math.ceil(timeoutMs / 1000)} s.`)), timeoutMs);
		const onAbort = () => stop(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) stop(new Error(`The page is larger than ${Math.round(maxBytes / 1e6) || 1} MB.`));
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 8000) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => stop(new Error(`The local browser ${binary} did not start: ${error.message}`)));
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			// Helpers can outlive a browser that exited by itself.
			killTree(child);
			if (failure !== undefined) reject(failure);
			else if (code !== 0) reject(new Error(`The local browser exited with code ${code}: ${lastLine(stderr) || "no message"}`));
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});
}

export function findBrowser(candidates: readonly string[]): string | undefined {
	return candidates.find((path) => existsSync(path));
}

/** The page's HTML after its scripts ran in a local headless browser. */
export const renderPage: Renderer = async (url, options = {}) => {
	const binary = options.browser ?? findBrowser(options.candidates ?? browserCandidates(here()));
	if (!binary) throw new Error(`No local browser was found to read it. Install Chromium with: ${INSTALL_COMMAND}`);
	if (!existsSync(binary)) throw new Error(`The browser ${binary} (linkContext.browser) does not exist.`);
	const timeoutMs = options.timeoutMs ?? BROWSER_TIMEOUT_MS;
	await acquire(options.signal);
	let guard: Awaited<ReturnType<typeof startGuard>> | undefined;
	let profile: string | undefined;
	try {
		guard = await startGuard();
		profile = mkdtempSync(join(tmpdir(), "pi-link-browser-"));
		const agent = browserAgent(await versionOf(binary), process.platform);
		const loadMs = Math.max(1000, Math.min(LOAD_LIMIT_MS, timeoutMs / 2));
		return await run(binary, chromeArgs(url, profile, guard.port, agent, loadMs), options.signal, timeoutMs, options.maxBytes ?? MAX_BODY_BYTES);
	} finally {
		await guard?.close();
		if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
		release();
	}
};
