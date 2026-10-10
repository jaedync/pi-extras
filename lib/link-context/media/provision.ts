/**
 * The media toolchain, installed on first use into the user's cache, with no
 * sudo and no browser: a private Python with yt-dlp, the bgutil PO-token
 * plugin, youtube-transcript-api, a static ffmpeg and Pillow, plus the bgutil token
 * script built with the Node that runs Pi. Video sites break old clients often,
 * so these follow upstream releases and refresh every `refreshDays`; speech
 * models are installed only when a video has no captions.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PYTHON_VERSION, uvAsset } from "../../voice/assets.ts";
import { acquireLock, downloadVerified, parseUvVersion, uvIsRecentEnough } from "../../voice/provision.ts";
import { deadline } from "../http.ts";
import { killGroup, track } from "./children.ts";

export const BGUTIL_REPO = "Brainicism/bgutil-ytdlp-pot-provider";
/** Used when GitHub's release API cannot be reached; plugin and script must share a version. */
export const BGUTIL_FALLBACK_TAG = "2.0.2";
/** Unpinned on purpose: video sites break old clients within weeks. A changed list reinstalls. */
export const PACKAGES = ["yt-dlp[default,curl-cffi]", "youtube-transcript-api", "imageio-ffmpeg", "pillow"] as const;
const LOCK_WAIT_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const TAG = /^\d+\.\d+\.\d+$/;
/** Per install step; a hung step must not hold the lock that other sessions wait on. */
const STEP_TIMEOUT_MS = { download: 5 * 60_000, venv: 5 * 60_000, pip: 20 * 60_000, git: 3 * 60_000, npm: 10 * 60_000, tsc: 5 * 60_000, tar: 60_000 } as const;

type Env = Readonly<Record<string, string | undefined>>;

export interface MediaState {
	readonly packagesAt?: number;
	readonly packages?: string;
	readonly bgutilTag?: string;
	readonly bgutilError?: string;
	readonly bgutilFailedAt?: number;
	readonly asr?: string;
}

export interface Toolchain {
	readonly python: string;
	readonly helper: string;
	readonly node: string;
	/** Built bgutil `server/` directory, or undefined when it could not be built. */
	readonly serverHome?: string;
	readonly home: string;
}

export function mediaHome(env: Env = process.env, home = homedir()): string {
	return env.PI_LINK_CONTEXT_HOME || join(env.XDG_CACHE_HOME || join(home, ".cache"), "pi-extras", "link-context");
}

export const HELPER = join(dirname(fileURLToPath(import.meta.url)), "helper.py");

/**
 * The environment for yt-dlp, the token script and installers: what they need
 * to run and reach the network, not the API keys in Pi's own environment.
 */
const PASS_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|TMPDIR|TMP|TEMP|XDG_\w+|(?:HTTPS?|NO|ALL)_PROXY|(?:https?|no|all)_proxy|SSL_CERT_(?:FILE|DIR)|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NODE_EXTRA_CA_CERTS|HF_HOME|HF_HUB_CACHE|UV_\w+|PIP_\w+|npm_config_\w+|NPM_CONFIG_\w+)$/;

export function toolEnv(env: Env = process.env): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => PASS_ENV.test(entry[0]) && typeof entry[1] === "string"));
}

export function readState(home: string): MediaState {
	try {
		const value = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as unknown;
		if (!value || typeof value !== "object") return {};
		const state = value as MediaState;
		// The tag reaches git and pip as an argument, so only a plain version passes.
		return typeof state.bgutilTag === "string" && !TAG.test(state.bgutilTag) ? { ...state, bgutilTag: undefined } : state;
	} catch {
		return {};
	}
}

function writeState(home: string, patch: Partial<MediaState>): MediaState {
	const next = { ...readState(home), ...patch };
	const temp = join(home, `.state.${process.pid}.tmp`);
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, join(home, "state.json"));
	return next;
}

/** A failed token-provider build is tried again after a day, not on every video call. */
export function bgutilDue(state: MediaState, now = Date.now()): boolean {
	return !state.bgutilFailedAt || now - state.bgutilFailedAt > DAY_MS;
}

export function packagesDue(state: MediaState, refreshDays: number, now = Date.now()): boolean {
	return !state.packagesAt || state.packages !== PACKAGES.join(" ") || (refreshDays > 0 && now - state.packagesAt > refreshDays * DAY_MS);
}

/** speech-to-text backend and default model for this machine. */
export function asrPlan(platform = process.platform, arch = process.arch): { backend: string; packages: string[]; model: string } {
	if (platform === "darwin" && arch === "arm64") return { backend: "mlx-whisper", packages: ["mlx-whisper"], model: "mlx-community/whisper-large-v3-turbo" };
	return { backend: "faster-whisper", packages: ["faster-whisper"], model: "small" };
}

class Installer {
	readonly home: string;
	private readonly log: string;
	private readonly progress: (text: string) => void;
	private readonly signal?: AbortSignal;

	constructor(home: string, progress: (text: string) => void, signal?: AbortSignal) {
		this.home = home;
		this.log = join(home, "provision.log");
		this.progress = progress;
		this.signal = signal;
	}

	/** One step, logged; killed with its children on abort or after `timeoutMs`. */
	run(command: string, args: readonly string[], timeoutMs: number, options: { cwd?: string } = {}): Promise<void> {
		this.signal?.throwIfAborted();
		writeFileSync(this.log, `${new Date().toISOString()} $ ${command} ${args.join(" ")}\n`, { flag: "a", mode: 0o600 });
		const fd = openSync(this.log, "a", 0o600);
		return new Promise<void>((resolve, reject) => {
			const env = { ...toolEnv(), ...this.uvEnv(), PATH: nodePath(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", npm_config_update_notifier: "false" };
			const child = spawn(command, [...args], { cwd: options.cwd, detached: true, stdio: ["ignore", fd, fd], env });
			const untrack = track(child.pid);
			let why: string | undefined;
			const stop = (reason: string) => {
				why ??= reason;
				killGroup(child.pid);
			};
			const onAbort = () => stop("was cancelled");
			const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 60_000)} min`), timeoutMs);
			const settle = () => {
				clearTimeout(timer);
				this.signal?.removeEventListener("abort", onAbort);
				untrack();
			};
			this.signal?.addEventListener("abort", onAbort, { once: true });
			child.on("error", (error) => {
				settle();
				reject(error);
			});
			child.on("exit", (code) => {
				settle();
				if (this.signal?.aborted) reject(this.signal.reason ?? new Error("aborted"));
				else if (code === 0) resolve();
				else reject(new Error(`${command} ${args[0] ?? ""} ${why ?? `failed (exit ${code})`}; see ${this.log}`));
			});
		}).finally(() => closeSync(fd));
	}

	uvEnv(): Record<string, string> {
		return { UV_PYTHON_INSTALL_DIR: join(this.home, "python"), UV_PYTHON_PREFERENCE: "only-managed", UV_NO_PROGRESS: "1" };
	}

	async uv(): Promise<string> {
		const own = join(this.home, "bin", "uv");
		const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin"), join(homedir(), ".cargo", "bin")];
		for (const candidate of [...dirs.filter(Boolean).map((dir) => join(dir, "uv")), own]) {
			if (!existsSync(candidate)) continue;
			const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
			if (uvIsRecentEnough(parseUvVersion(probe.stdout ?? ""))) return candidate;
		}
		const asset = uvAsset(process.platform, process.arch);
		if (!asset) throw new Error(`pull_link media support is not available on ${process.platform}-${process.arch}`);
		this.progress("downloading uv");
		mkdirSync(join(this.home, "bin"), { recursive: true, mode: 0o700 });
		const archive = join(this.home, "bin", "uv.tar.gz");
		await downloadVerified(asset, archive, () => {}, deadline(this.signal, STEP_TIMEOUT_MS.download));
		await this.run("tar", ["-xzf", archive, "-C", join(this.home, "bin")], STEP_TIMEOUT_MS.tar);
		renameSync(join(this.home, "bin", asset.dir, "uv"), own);
		rmSync(join(this.home, "bin", asset.dir), { recursive: true, force: true });
		rmSync(archive, { force: true });
		return own;
	}

	async python(uv: string): Promise<string> {
		const python = join(this.home, "env", "bin", "python");
		if (!existsSync(python)) {
			this.progress("installing Python");
			await this.run(uv, ["venv", "--clear", "--python", PYTHON_VERSION, join(this.home, "env")], STEP_TIMEOUT_MS.venv);
			// A new environment has none of the packages the state says were installed.
			writeState(this.home, { packagesAt: undefined, packages: undefined, asr: undefined });
		}
		return python;
	}

	async bgutil(tag: string): Promise<string> {
		const root = join(this.home, "bgutil", tag);
		const server = join(root, "server");
		if (existsSync(join(server, "build", "generate_once.js"))) return server;
		this.progress(`building the YouTube token provider ${tag}`);
		const staging = `${root}.staging`;
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
		await this.run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, `https://github.com/${BGUTIL_REPO}.git`, staging], STEP_TIMEOUT_MS.git);
		const stagedServer = join(staging, "server");
		await this.run(npmCommand(), ["ci", "--no-audit", "--no-fund", "--loglevel=error"], STEP_TIMEOUT_MS.npm, { cwd: stagedServer });
		await this.run(process.execPath, [join(stagedServer, "node_modules", "typescript", "bin", "tsc")], STEP_TIMEOUT_MS.tsc, { cwd: stagedServer });
		rmSync(root, { recursive: true, force: true });
		renameSync(staging, root);
		return server;
	}
}

/** Node that runs Pi first on PATH, so yt-dlp and the token script find a Node 22+. */
export function nodePath(env: Env = process.env): string {
	return [dirname(process.execPath), ...(env.PATH ?? "").split(delimiter)].filter(Boolean).join(delimiter);
}

function npmCommand(): string {
	const beside = join(dirname(process.execPath), "npm");
	return existsSync(beside) ? beside : "npm";
}

async function latestBgutilTag(): Promise<string | undefined> {
	try {
		const response = await fetch(`https://api.github.com/repos/${BGUTIL_REPO}/releases/latest`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-extras-link" } });
		const tag = response.ok ? ((await response.json()) as { tag_name?: unknown }).tag_name : undefined;
		return typeof tag === "string" && TAG.test(tag) ? tag : undefined;
	} catch {
		return undefined;
	}
}

async function withLock<T>(home: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	let lock = acquireLock(home);
	while (!lock) {
		if (Date.now() > deadline) throw new Error("Another Pi session has been installing the media tools for over 10 minutes.");
		signal?.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		lock = acquireLock(home);
	}
	try {
		return await work();
	} finally {
		lock.release();
	}
}

export interface EnsureOptions {
	readonly refreshDays: number;
	readonly progress: (text: string) => void;
	readonly signal?: AbortSignal;
	readonly home?: string;
}

/** Installs or refreshes the toolchain. A failed refresh keeps the last working install. */
export async function ensureMedia(options: EnsureOptions): Promise<Toolchain> {
	const home = options.home ?? mediaHome();
	mkdirSync(home, { recursive: true, mode: 0o700 });
	return withLock(home, async () => {
		const installer = new Installer(home, options.progress, options.signal);
		const uv = await installer.uv();
		const python = await installer.python(uv);
		let state = readState(home);
		if (packagesDue(state, options.refreshDays)) {
			const tag = (await latestBgutilTag()) ?? state.bgutilTag ?? BGUTIL_FALLBACK_TAG;
			options.progress(state.packagesAt ? "updating yt-dlp" : "installing yt-dlp and helpers");
			try {
				await installer.run(uv, ["pip", "install", "--python", python, "-U", ...PACKAGES, `bgutil-ytdlp-pot-provider==${tag}`], STEP_TIMEOUT_MS.pip);
				state = writeState(home, { packagesAt: Date.now(), packages: PACKAGES.join(" "), bgutilTag: tag });
			} catch (error) {
				if (!state.packagesAt || options.signal?.aborted) throw error;
				options.progress("update failed; using the installed version");
			}
		}
		const tag = state.bgutilTag ?? BGUTIL_FALLBACK_TAG;
		let serverHome: string | undefined = existsSync(join(home, "bgutil", tag, "server", "build", "generate_once.js")) ? join(home, "bgutil", tag, "server") : undefined;
		if (!serverHome && bgutilDue(state)) {
			try {
				serverHome = await installer.bgutil(tag);
				if (state.bgutilError) state = writeState(home, { bgutilError: undefined, bgutilFailedAt: undefined });
			} catch (error) {
				if (options.signal?.aborted) throw error;
				// Without tokens YouTube may refuse downloads, but captions and other sites still work.
				state = writeState(home, { bgutilError: (error as Error).message, bgutilFailedAt: Date.now() });
			}
		}
		return { python, helper: HELPER, node: process.execPath, serverHome, home };
	}, options.signal);
}

/** Installs the speech-to-text packages once; models download on first transcription. */
export async function ensureAsr(toolchain: Toolchain, progress: (text: string) => void, signal?: AbortSignal): Promise<{ backend: string; model: string }> {
	const plan = asrPlan();
	return withLock(toolchain.home, async () => {
		const state = readState(toolchain.home);
		if (state.asr !== plan.backend) {
			const installer = new Installer(toolchain.home, progress, signal);
			progress(`installing ${plan.backend}`);
			await installer.run(await installer.uv(), ["pip", "install", "--python", toolchain.python, ...plan.packages], STEP_TIMEOUT_MS.pip);
			writeState(toolchain.home, { asr: plan.backend });
		}
		return { backend: plan.backend, model: plan.model };
	}, signal);
}
