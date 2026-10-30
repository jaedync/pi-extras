/**
 * `wv setup`: install the runtime on first use into
 * ${XDG_CACHE_HOME:-~/.cache}/pi-walkthrough-video, with pinned versions, a
 * lock file so two sessions never install at once, and explicit errors. Every
 * step is idempotent, so an interrupted install resumes next time.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { FILM_PY_PACKAGES, SCORE_PY_PACKAGES, GSAP, HYPERFRAMES, KOKORO_PACKAGES, MODEL_FILES, MODEL_RELEASE, PLAYWRIGHT_CORE, TYPESCRIPT, ensureHome, paths, pythonPackageNames, writeState } from "./paths.mjs";
import { HYPERFRAMES_ENV, findOnPath, pathWithNode, run, sleep } from "./proc.mjs";
import { browserPaths } from "./runtime.mjs";
import { musicKitStatus } from "./music-kit.mjs";

/** Setup installs the same package list that the setup help names. */
export { pythonPackageNames };

const LOCK_WAIT_MS = 10 * 60_000;
// Longer than the worst install (npm 15 + browsers 20 + uv 20 min), so a live install keeps it.
const LOCK_STALE_MS = 70 * 60_000;

function acquireLock(lockPath) {
	try {
		mkdirSync(join(lockPath, ".."), { recursive: true, mode: 0o700 });
		const fd = openSync(lockPath, "wx", 0o600);
		writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
		closeSync(fd);
		return { release: () => rmSync(lockPath, { force: true }) };
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		try {
			const age = Date.now() - statSync(lockPath).mtimeMs;
			if (age > LOCK_STALE_MS) {
				rmSync(lockPath, { force: true });
				return acquireLock(lockPath);
			}
		} catch {
			return acquireLock(lockPath);
		}
		return null;
	}
}

async function withLock(lockPath, work) {
	const deadline = Date.now() + LOCK_WAIT_MS;
	let lock = acquireLock(lockPath);
	while (!lock) {
		if (Date.now() > deadline) throw new Error(`another wv setup has held ${lockPath} for over ${LOCK_WAIT_MS / 60_000} minutes. Remove the file if that session is gone.`);
		await sleep(1000);
		lock = acquireLock(lockPath);
	}
	try {
		return await work();
	} finally {
		lock.release();
	}
}

async function sha256Sync(file) {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(file)) digest.update(chunk);
	return digest.digest("hex");
}

function packageVersion(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
	} catch {
		return null;
	}
}

function hasModule(root, name, version) {
	return packageVersion(join(root, "node_modules", name)) === version;
}

function venvHasModules(python, modules) {
	if (!existsSync(python)) return false;
	const probe = spawnSync(python, ["-c", `import ${modules.join(", ")}; print('ok')`], { encoding: "utf8", timeout: 60000 });
	return probe.status === 0;
}

function venvHasPackages(python) {
	return venvHasModules(python, ["kokoro_onnx", "soundfile", "numpy", "cv2", "scipy", "mido", "pedalboard"]);
}

/**
 * A venv that can import `modules`, created or repaired with uv and these pinned
 * packages. The voice and the music kit share it, so one install serves both.
 */
export async function ensurePythonVenv({ python, venv, packages, modules, log = () => {} }) {
	const uv = findOnPath("uv");
	if (!existsSync(python)) {
		if (!uv) throw new Error("uv is not on PATH. Install it (https://docs.astral.sh/uv/) or with your package manager, then run the command again.");
		log("creating the runtime venv");
		const created = await run(uv, ["venv", venv], { env: { ...process.env, UV_NO_PROGRESS: "1" }, timeoutMs: 5 * 60_000 });
		if (created.code !== 0) throw new Error(`uv venv failed: ${(created.stderr || created.stdout).trim()}`);
	}
	if (!venvHasModules(python, modules)) {
		if (!uv) throw new Error("uv is not on PATH, so the Python packages cannot be installed.");
		log(`installing ${packages.map((spec) => String(spec).split("==")[0]).join(", ")}`);
		const result = await run(uv, ["pip", "install", "--python", python, ...packages], { env: { ...process.env, UV_NO_PROGRESS: "1" }, timeoutMs: 20 * 60_000 });
		if (result.code !== 0) throw new Error(`uv pip install failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
	}
	if (!venvHasModules(python, modules)) throw new Error(`the venv cannot import ${modules.join(", ")} after install; run the command again and read the uv output.`);
	return python;
}

/** Downloads to `.part` while hashing, then renames; an exported seam for the tests. */
export async function downloadModel(url, dest, sha) {
	const part = `${dest}.part`;
	const digest = createHash("sha256");
	const out = createWriteStream(part, { mode: 0o600 });
	const finished = new Promise((resolve, reject) => {
		out.on("error", reject);
		out.on("finish", resolve);
	});
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
		if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
		for await (const chunk of response.body) {
			digest.update(chunk);
			if (!out.write(chunk)) await Promise.race([new Promise((resolve) => out.once("drain", resolve)), finished]);
		}
		out.end();
		await finished;
		const actual = digest.digest("hex");
		if (actual !== sha) throw new Error(checksumMismatch(dest, actual));
		renameSync(part, dest);
	} finally {
		out.destroy();
		await finished.catch(() => {});
		rmSync(part, { force: true });
	}
}

/** The checksum-mismatch message: the partial file is already removed, so it never says "delete it". */
export function checksumMismatch(dest, actual) {
	return `${dest}: checksum mismatch (got ${actual}), so the file was not installed and the partial download is removed. Run wv setup again.`;
}

async function modelStatus(modelDir, shareDir, name, sha) {
	const target = join(modelDir, name);
	if (existsSync(target) && (await sha256Sync(target)) === sha) return { name, ok: true, how: "installed" };
	for (const candidate of [join(shareDir, name)]) {
		if (existsSync(candidate) && (await sha256Sync(candidate)) === sha) return { name, ok: false, how: "reusable", source: candidate };
	}
	return { name, ok: false, how: "missing" };
}

function ffmpegStatus() {
	const path = findOnPath("ffmpeg");
	if (!path) return { ok: false, how: "missing" };
	const version = spawnSync(path, ["-version"], { encoding: "utf8", timeout: 5000 });
	if (version.status !== 0) return { ok: false, how: "broken", detail: version.stderr?.split("\n")[0] };
	return { ok: true, path, version: version.stdout.split("\n")[0] };
}

/** Reads what is installed, without changing anything. */
export async function checkSetup(log = () => {}) {
	const p = paths();
	const chromium = await importPlaywrightForCheck(p);
	const items = [];
	const ffmpeg = ffmpegStatus();
	items.push({ name: "ffmpeg", ok: ffmpeg.ok, detail: ffmpeg.ok ? ffmpeg.path : "not on PATH; install it with your package manager" });
	items.push({ name: "playwright-core", ok: packageVersion(p.playwright) === PLAYWRIGHT_CORE, detail: packageVersion(p.playwright) ?? "not installed" });
	items.push({ name: "hyperframes", ok: packageVersion(p.hyperframes) === HYPERFRAMES, detail: packageVersion(p.hyperframes) ?? "not installed" });
	items.push({ name: "gsap", ok: packageVersion(p.gsap) === GSAP, detail: packageVersion(p.gsap) ?? "not installed" });
	items.push({ name: "typescript (film type check)", ok: packageVersion(p.typescript) === TYPESCRIPT, detail: packageVersion(p.typescript) ?? "not installed" });
	const browser = browserPaths(chromium);
	items.push({ name: "chromium-headless-shell", ok: Boolean(browser.shell), detail: browser.shell ?? "not installed" });
	items.push({ name: "chromium", ok: Boolean(browser.chromium), detail: browser.chromium ?? "not installed" });
	items.push({ name: "python venv (voice, measures)", ok: venvHasPackages(p.python), detail: existsSync(p.python) ? p.python : "not created" });
	// The music kit is optional: a missing kit never makes `wv setup --check` fail.
	const kit = musicKitStatus(p.musicKit);
	items.push({ name: "music kit (optional)", ok: kit.present, optional: true, detail: kit.present ? kit.detail : `${kit.detail}; ${kit.hint}` });
	const models = [];
	for (const [name, sha] of Object.entries(MODEL_FILES)) models.push(await modelStatus(p.models, p.kokoroShare, name, sha));
	const modelsOk = models.every((model) => model.how !== "missing");
	items.push({ name: "kokoro models", ok: modelsOk, detail: modelsOk ? models.map((model) => `${model.name} (${model.how})`).join(", ") : models.filter((model) => model.how === "missing").map((model) => model.name).join(", ") });
	const missing = items.filter((item) => !item.ok && !item.optional);
	for (const item of items) log(`${item.ok ? "ok  " : item.optional ? "opt " : "MISS"}  ${item.name.padEnd(24)} ${item.detail}`);
	if (missing.length > 0) log(`\n${missing.length} of ${items.length} missing. Run: wv setup`);
	return { ok: missing.length === 0, items, missing: missing.map((item) => item.name) };
}

async function importPlaywrightForCheck(p) {
	const cached = join(p.playwright, "index.mjs");
	if (existsSync(cached)) return (await import(cached)).chromium;
	try {
		return (await import("playwright-core")).chromium;
	} catch {
		return null;
	}
}

/** Installs or repairs the runtime. Returns the same report shape as checkSetup. */
function installNodePackages(root, p, log) {
	const wanted = { name: "pi-walkthrough-video", private: true, type: "module", dependencies: { "playwright-core": PLAYWRIGHT_CORE, hyperframes: HYPERFRAMES, gsap: GSAP, typescript: TYPESCRIPT } };
	const onDisk = existsSync(p.packageJson) ? JSON.parse(readFileSync(p.packageJson, "utf8")) : null;
	if (JSON.stringify(onDisk?.dependencies) !== JSON.stringify(wanted.dependencies)) writeFileSync(p.packageJson, `${JSON.stringify(wanted, null, 2)}\n`, { mode: 0o600 });
	if (hasModule(root, "playwright-core", PLAYWRIGHT_CORE) && hasModule(root, "hyperframes", HYPERFRAMES) && hasModule(root, "gsap", GSAP) && hasModule(root, "typescript", TYPESCRIPT)) return;
	log("installing playwright-core, hyperframes, gsap and typescript from npm (this can take a minute)");
	const npm = findOnPath("npm") ?? "npm";
	return run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: root, env: { ...process.env, PATH: pathWithNode(), npm_config_update_notifier: "false" }, timeoutMs: 15 * 60_000 }).then((result) => {
		if (result.code !== 0) throw new Error(`npm install failed in ${root}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
	});
}

async function installBrowsers(p, log) {
	const playwrightCli = join(p.playwright, "cli.js");
	if (!existsSync(playwrightCli)) throw new Error(`playwright-core is not installed in ${p.playwright}; run wv setup again.`);
	const chromium = (await import(join(p.playwright, "index.mjs"))).chromium;
	const before = browserPaths(chromium);
	if (before.shell && before.chromium) {
		log(`browsers: ${before.shell}`);
		return chromium;
	}
	log("installing chromium-headless-shell and chromium for playwright-core");
	const result = await run(process.execPath, [playwrightCli, "install", "chromium-headless-shell", "chromium"], { env: { ...process.env, PATH: pathWithNode() }, timeoutMs: 20 * 60_000 });
	if (result.code !== 0) throw new Error(`playwright browser install failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
	return chromium;
}

async function installModels(p, log) {
	mkdirSync(p.models, { recursive: true, mode: 0o700 });
	for (const [name, sha] of Object.entries(MODEL_FILES)) {
		const status = await modelStatus(p.models, p.kokoroShare, name, sha);
		const target = join(p.models, name);
		if (status.how === "installed") {
			log(`model: ${name} already installed`);
			continue;
		}
		if (status.how === "reusable") {
			log(`model: linking ${status.source}`);
			try {
				symlinkSync(status.source, target);
			} catch {
				try {
					linkSync(status.source, target);
				} catch {
					copyFileSync(status.source, target);
				}
			}
			continue;
		}
		log(`model: downloading ${name} (about 350 MB)`);
		await downloadModel(`${MODEL_RELEASE}${name}`, target, sha);
	}
}

async function installVoice(p, log) {
	const uv = findOnPath("uv");
	if (!existsSync(p.python)) {
		if (!uv) throw new Error("uv is not on PATH. Install it (https://docs.astral.sh/uv/) or with your package manager, then run wv setup again.");
		log("creating the voice venv");
		const created = await run(uv, ["venv", p.venv], { env: { ...process.env, UV_NO_PROGRESS: "1" }, timeoutMs: 5 * 60_000 });
		if (created.code !== 0) throw new Error(`uv venv failed: ${(created.stderr || created.stdout).trim()}`);
	}
	if (!venvHasPackages(p.python)) {
		if (!uv) throw new Error("uv is not on PATH, so the voice packages cannot be installed.");
		log(`installing ${pythonPackageNames().join(", ")}`);
		const result = await run(uv, ["pip", "install", "--python", p.python, ...KOKORO_PACKAGES, ...FILM_PY_PACKAGES, ...SCORE_PY_PACKAGES], { env: { ...process.env, UV_NO_PROGRESS: "1" }, timeoutMs: 20 * 60_000 });
		if (result.code !== 0) throw new Error(`uv pip install failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
	}
	if (!venvHasPackages(p.python)) throw new Error("the voice venv cannot import kokoro_onnx after install; run wv setup again and read the uv output.");
}

/** Installs or repairs the runtime. Returns the same report shape as checkSetup. */
export async function installSetup(log = () => {}) {
	const root = ensureHome();
	const p = paths();
	const ffmpeg = ffmpegStatus();
	if (!ffmpeg.ok) throw new Error("ffmpeg is not on PATH. Install it with your package manager (on Arch: pacman -S ffmpeg), then run wv setup again.");
	log(`ffmpeg: ${ffmpeg.path}`);

	let chromium = null;
	await withLock(p.lock, async () => {
		await installNodePackages(root, p, log);
		chromium = await installBrowsers(p, log);
		await installModels(p, log);
		await installVoice(p, log);
		writeState({
			version: 1,
			installedAt: new Date().toISOString(),
			home: root,
			playwrightCore: PLAYWRIGHT_CORE,
			hyperframes: HYPERFRAMES,
			gsap: GSAP,
			typescript: TYPESCRIPT,
			browsers: browserPaths(chromium),
			venv: p.venv,
			models: Object.keys(MODEL_FILES),
			ffmpeg: ffmpeg.path,
			env: HYPERFRAMES_ENV,
		});
		log("setup complete");
	});
	return checkSetup(log);
}
