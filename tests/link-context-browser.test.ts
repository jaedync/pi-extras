import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pullWeb } from "../lib/link-context/adapters/web.ts";
import { browserCandidates, browserAgent, isChallenge, renderPage, type Renderer } from "../lib/link-context/browser.ts";
import { publicAddress, startGuard } from "../lib/link-context/browser-guard.ts";
import { parseConfig } from "../lib/link-context/config.ts";
import { get, HttpError } from "../lib/link-context/http.ts";
import { context, fakeFetch, html } from "./support/link-fetch.ts";

const PAGE = "<html><head><title>Real page</title></head><body><article><p>The real text of the page.</p></article></body></html>";
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>";

const status = (match: string, code: number, headers: Record<string, string> = {}) => (url: string) => (url.includes(match) ? new Response(CHALLENGE, { status: code, headers: { "content-type": "text/html", ...headers } }) : undefined);

function stubRenderer(result: string | Error): Renderer & { calls: string[] } {
	const calls: string[] = [];
	const render = (async (url: string) => {
		calls.push(url);
		if (result instanceof Error) throw result;
		return result;
	}) as Renderer & { calls: string[] };
	render.calls = calls;
	return render;
}

test("http: a 429 with a short Retry-After gets one retry", async () => {
	let n = 0;
	const fetcher = (async () => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : new Response("ok", { status: 200 }))) as typeof fetch;
	const result = await get("https://e.test/a", { fetcher });
	assert.equal(result.body, "ok");
	assert.equal(n, 2);
});

test("http: a 429 with a long or missing Retry-After fails at once", async () => {
	for (const headers of [{ "retry-after": "30" }, {}] as Record<string, string>[]) {
		let n = 0;
		const fetcher = (async () => (n++, new Response("slow down", { status: 429, headers }))) as typeof fetch;
		const started = Date.now();
		await assert.rejects(get("https://e.test/a", { fetcher }), (error: HttpError) => error.status === 429);
		assert.equal(n, 1);
		assert.ok(Date.now() - started < 2000);
	}
});

test("http: a network error on one agent tries the next agent", async () => {
	const fetcher = (async (_url: string, init: RequestInit) => {
		if ((init.headers as Record<string, string>)["User-Agent"] === "a") throw new TypeError("fetch failed");
		return new Response("ok", { status: 200 });
	}) as typeof fetch;
	assert.equal((await get("https://e.test/a", { fetcher, agents: ["a", "b"] })).body, "ok");
});

test("http: a 404 says that the page was not found", async () => {
	await assert.rejects(get("https://e.test/gone", { fetcher: fakeFetch().fetcher }), /e\.test answered HTTP 404 \(page not found\)/);
});

test("browser: a challenge page is recognized, and a normal page is not", () => {
	assert.ok(isChallenge(CHALLENGE));
	assert.ok(isChallenge("<title>Attention Required! | Cloudflare</title>"));
	assert.ok(isChallenge("<title>Vercel Security Checkpoint</title>"));
	assert.equal(isChallenge(PAGE), false);
	// Cloudflare adds its bot script to normal pages too.
	assert.equal(isChallenge(`${PAGE}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`), false);
});

test("web: a 403 goes to the local browser, and the result says so", async () => {
	const render = stubRenderer(PAGE);
	const ctx = { ...context(fakeFetch(status("e.test", 403)).fetcher), render };
	const pulled = await pullWeb("https://e.test/a", ctx);
	assert.deepEqual(render.calls, ["https://e.test/a"]);
	assert.equal(pulled.title, "Real page");
	assert.match(pulled.markdown, /The real text of the page\./);
	assert.match(pulled.markdown, /Read with a local browser: the site refused the plain request \(HTTP 403\)\./);
});

test("web: a 429 and a 503 go to the local browser", async () => {
	for (const code of [429, 503]) {
		const render = stubRenderer(PAGE);
		const pulled = await pullWeb("https://e.test/a", { ...context(fakeFetch(status("e.test", code)).fetcher), render });
		assert.match(pulled.markdown, new RegExp(`HTTP ${code}`));
		assert.equal(render.calls.length, 1);
	}
});

test("web: a bot-check page with HTTP 200 goes to the local browser", async () => {
	const render = stubRenderer(PAGE);
	const pulled = await pullWeb("https://e.test/a", { ...context(fakeFetch(html("e.test", CHALLENGE)).fetcher), render });
	assert.match(pulled.markdown, /Read with a local browser: the site showed a bot check/);
});

test("web: a timeout or a dropped connection goes to the local browser", async () => {
	for (const error of [new DOMException("The operation was aborted due to timeout", "TimeoutError"), new TypeError("fetch failed")]) {
		const render = stubRenderer(PAGE);
		const fetcher = (async () => {
			throw error;
		}) as typeof fetch;
		const pulled = await pullWeb("https://e.test/a", { ...context(fetcher), render });
		assert.equal(render.calls.length, 1, error.name);
		assert.equal(pulled.title, "Real page");
	}
});

test("web: a 404, a name that does not resolve and the caller's abort do not start the browser", async () => {
	const render = stubRenderer(PAGE);
	await assert.rejects(pullWeb("https://e.test/a", { ...context(fakeFetch().fetcher), render }), /page not found/);
	const dns = (async () => {
		throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND e.test"), { code: "ENOTFOUND" }) });
	}) as typeof fetch;
	await assert.rejects(pullWeb("https://e.test/a", { ...context(dns), render }), /fetch failed/);
	const controller = new AbortController();
	const aborting = (async () => {
		controller.abort();
		throw new DOMException("aborted", "AbortError");
	}) as typeof fetch;
	await assert.rejects(pullWeb("https://e.test/a", { ...context(aborting), signal: controller.signal, render }));
	assert.deepEqual(render.calls, []);
});

test("web: the browser setting off keeps the HTTP error", async () => {
	const render = stubRenderer(PAGE);
	const ctx = { ...context(fakeFetch(status("e.test", 403)).fetcher), config: parseConfig({ browser: false }), render };
	await assert.rejects(pullWeb("https://e.test/a", ctx), /e\.test answered HTTP 403/);
	assert.deepEqual(render.calls, []);
});

test("web: the error names the HTTP failure and the browser failure", async () => {
	const ctx = (render: Renderer) => ({ ...context(fakeFetch(status("e.test", 403)).fetcher), render });
	await assert.rejects(pullWeb("https://e.test/a", ctx(stubRenderer(CHALLENGE))), /HTTP 403.*the local browser also got a bot check/);
	await assert.rejects(pullWeb("https://e.test/a", ctx(stubRenderer(new Error("browser exited with code 1")))), /HTTP 403.*browser exited with code 1/);
});

test("config: browser is on by default, off with false, and a path when given", () => {
	assert.equal(parseConfig({}).browser, true);
	assert.equal(parseConfig({ browser: false }).browser, false);
	assert.equal(parseConfig({ browser: " /opt/chrome " }).browser, "/opt/chrome");
	assert.equal(parseConfig({ browser: 3 }).browser, true);
});

test("browser: candidates prefer a system Chrome, then the newest Playwright Chromium, then the headless shell", () => {
	const linux = browserCandidates({ platform: "linux", home: "/h", env: { PATH: "/usr/bin" }, list: (dir) => (dir === "/h/.cache/ms-playwright" ? ["chromium-1200", "chromium-1248", "chromium_headless_shell-1248", "ffmpeg-1011"] : []) });
	assert.equal(linux[0], "/usr/bin/google-chrome-stable");
	const chromium = linux.indexOf("/h/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome");
	const older = linux.indexOf("/h/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome");
	const shell = linux.indexOf("/h/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell");
	assert.ok(linux.indexOf("/usr/bin/chromium") < chromium && chromium < older && older < shell, linux.join("\n"));
	const mac = browserCandidates({ platform: "darwin", home: "/Users/u", env: {}, list: (dir) => (dir.endsWith("ms-playwright") ? ["chromium-1248"] : []) });
	assert.equal(mac[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.ok(mac.includes("/Users/u/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
	const custom = browserCandidates({ platform: "linux", home: "/h", env: { PLAYWRIGHT_BROWSERS_PATH: "/pw" }, list: (dir) => (dir === "/pw" ? ["chromium-1"] : []) });
	assert.ok(custom.includes("/pw/chromium-1/chrome-linux64/chrome"));
});

test("browser: the agent has no Headless mark and matches the browser's version", () => {
	assert.equal(browserAgent("Google Chrome for Testing 156.0.8078.4", "linux"), "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36");
	assert.match(browserAgent("", "darwin"), /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\).* Chrome\/\d+\.0\.0\.0 Safari/);
});

/** A stand-in browser: answers --version, records its arguments, and prints a page or waits. */
function fakeBrowser(dir: string, body: string): string {
	const path = join(dir, "chrome");
	writeFileSync(path, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Chromium 150.0.1.2"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(args));
const profile = args.find((a) => a.startsWith("--user-data-dir=")).slice(16);
fs.writeFileSync(profile + "/Local State", "{}");
${body}
`);
	chmodSync(path, 0o755);
	return path;
}

test("browser: renders through the guard with a temporary profile that is removed after", async () => {
	const dir = mkdtempSync(join(tmpdir(), "plf-browser-"));
	try {
		const binary = fakeBrowser(dir, `process.stdout.write(${JSON.stringify(PAGE)});`);
		const body = await renderPage("https://e.test/a", { browser: binary });
		assert.equal(body, PAGE);
		const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
		assert.equal(args.at(-1), "https://e.test/a");
		assert.ok(args.includes("--dump-dom"));
		assert.ok(args.includes("--headless"));
		assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
		assert.match(args.find((a) => a.startsWith("--proxy-server="))!, /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/);
		assert.equal(args.find((a) => a.startsWith("--user-agent=")), "--user-agent=" + browserAgent("Chromium 150.0.1.2", process.platform));
		const profile = args.find((a) => a.startsWith("--user-data-dir="))!.slice(16);
		assert.equal(existsSync(profile), false, "the profile is removed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("browser: the abort, the time limit and the size limit stop the whole process tree", async () => {
	const dir = mkdtempSync(join(tmpdir(), "plf-browser-"));
	try {
		const pidFile = join(dir, "child.pid");
		const hang = `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);`;
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const waitGone = async (pid: number) => {
			for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
			return !alive(pid);
		};
		const binary = fakeBrowser(dir, hang);
		const controller = new AbortController();
		const aborted = renderPage("https://e.test/a", { browser: binary, signal: controller.signal });
		while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		await assert.rejects(aborted);
		assert.ok(await waitGone(Number(readFileSync(pidFile, "utf8"))), "the abort stops the child");
		rmSync(pidFile);
		await assert.rejects(renderPage("https://e.test/a", { browser: binary, timeoutMs: 600 }), /did not finish in 1 s/);
		assert.ok(await waitGone(Number(readFileSync(pidFile, "utf8"))), "the time limit stops the child");
		const big = fakeBrowser(dir, `process.stdout.write("x".repeat(5000)); setInterval(() => {}, 1000);`);
		await assert.rejects(renderPage("https://e.test/a", { browser: big, maxBytes: 1000 }), /larger than/);
		const failing = fakeBrowser(dir, `process.stderr.write("No usable sandbox!"); process.exit(1);`);
		await assert.rejects(renderPage("https://e.test/a", { browser: failing }), /exited with code 1: No usable sandbox!/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("browser: with no browser, the error gives the install command", async () => {
	await assert.rejects(renderPage("https://e.test/a", { candidates: ["/nonexistent/chrome"] }), /No local browser.*npx playwright install chromium/);
});

test("guard: refuses private names and names that resolve to private addresses", async () => {
	const lookup = async (host: string) => (host === "inside.test" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
	assert.equal(await publicAddress("e.test", lookup), "93.184.216.34");
	assert.equal(await publicAddress("both.test", async () => [{ address: "2606:4700::1", family: 6 }, { address: "104.26.12.39", family: 4 }]), "104.26.12.39");
	await assert.rejects(publicAddress("inside.test", lookup), /private/);
	await assert.rejects(publicAddress("127.0.0.1", lookup), /private/);
	await assert.rejects(publicAddress("[::1]", lookup), /private/);
	await assert.rejects(publicAddress("router.local", lookup), /private/);
});

test("guard: a refused tunnel and request get 403, an allowed one is relayed", async () => {
	const origin = createServer((_req, res) => res.end("from origin"));
	await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
	const originPort = (origin.address() as AddressInfo).port;
	// Only "allowed.test" passes; it maps to the local test server.
	const guard = await startGuard(async (host) => {
		if (host !== "allowed.test") throw new Error("private");
		return "127.0.0.1";
	});
	try {
		const tunnel = (target: string) => new Promise<string>((resolve, reject) => {
			const socket = connect(guard.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
			socket.once("data", (data) => {
				resolve(String(data).split("\r\n")[0]!);
				socket.destroy();
			});
			socket.on("error", reject);
		});
		assert.match(await tunnel("127.0.0.1:22"), /403/);
		assert.match(await tunnel(`allowed.test:${originPort}`), /200/);
		const plain = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = httpRequest({ host: "127.0.0.1", port: guard.port, path: `http://${host}:${originPort}/`, headers: { host: `${host}:${originPort}` } }, (res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal((await plain("inside.test")).status, 403);
		assert.deepEqual(await plain("allowed.test"), { status: 200, body: "from origin" });
	} finally {
		await guard.close();
		origin.close();
	}
});
