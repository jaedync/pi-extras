/**
 * Background setup for voice: a private uv, a managed Python with the speech
 * wheels, and the models. Every step is idempotent and verified, so an
 * interrupted run simply resumes on the next Pi start. The small CPU model is
 * installed first; better tiers are layered on afterwards.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
	CPU_PACKAGES,
	LARGE_MODEL,
	MLX_DIR,
	MLX_FILES,
	MLX_PACKAGES,
	MLX_REPO,
	MLX_REVISION,
	PYTHON_VERSION,
	SMALL_MODEL,
	UV_MIN_VERSION,
	VAD_MODEL,
	uvAsset,
	type ArchiveModel,
	type Asset,
} from "./assets.ts";
import { chooseThreads, tierName, TIER_ORDER, wantedTiers, type HardwareFacts, type TierId, type TierMap } from "./plan.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface Tiers extends TierMap {
	readonly python?: string;
	readonly vad?: string;
	readonly threads?: number;
}

export interface Progress {
	readonly label: string;
	readonly fraction?: number;
}

export interface ProvisionOptions {
	readonly home: string;
	readonly facts: HardwareFacts;
	readonly env: Env;
	readonly homedir: string;
	readonly onProgress: (progress: Progress | undefined) => void;
	/** Extra tiers to install beyond the planned ones, e.g. one the user picked. */
	readonly extraTiers?: readonly TierId[];
	/** An upgrade was not attempted, with the reason in words. */
	readonly onSkip?: (tier: TierId, reason: string) => void;
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;
// parakeet-mlx and its mlx wheels: 203 MB installed on macOS arm64 (mlx 0.32.2).
const MLX_PACKAGES_BYTES = 210 * MB;
// Archives are unpacked beside themselves, and filling a disk to the last byte breaks other programs.
const FREE_SPACE_FACTOR = 2;

function formatBytes(bytes: number): string {
	return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

function downloadBytes(tier: TierId, mlxCached: boolean): number {
	if (tier === "cpu-large") return LARGE_MODEL.bytes;
	if (tier === "mlx") return MLX_PACKAGES_BYTES + (mlxCached ? 0 : MLX_FILES.reduce((sum, file) => sum + file.bytes, 0));
	return SMALL_MODEL.bytes;
}

/** Why an upgrade should not start with this much free space, or undefined when it fits. */
export function skipReason(tier: TierId, freeBytes: number, mlxCached: boolean): string | undefined {
	const needed = downloadBytes(tier, mlxCached) * FREE_SPACE_FACTOR;
	if (freeBytes >= needed) return undefined;
	return `${tierName(tier)} needs ${formatBytes(needed)} free to install, ${formatBytes(freeBytes)} available`;
}

function freeBytes(path: string): number {
	const stats = statfsSync(path);
	return stats.bavail * stats.bsize;
}

export function voiceHome(env: Env, homedir: string): string {
	if (env.PI_VOICE_HOME) return env.PI_VOICE_HOME;
	return join(env.XDG_CACHE_HOME || join(homedir, ".cache"), "pi-extras", "voice");
}

export function readTiers(home: string): Tiers {
	try {
		const parsed = JSON.parse(readFileSync(join(home, "tiers.json"), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function writeTiers(home: string, tiers: Tiers): void {
	const path = join(home, "tiers.json");
	writeFileSync(`${path}.tmp`, `${JSON.stringify(tiers, null, 2)}\n`, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

/** True once the daemon has everything it needs to transcribe something. */
export function floorReady(tiers: Tiers): boolean {
	return Boolean(tiers.python && existsSync(tiers.python) && tiers.vad && tiers["cpu-small"]?.ready);
}

/** Everything this machine should have is installed, so startup can skip setup entirely. */
export function provisioningComplete(tiers: Tiers, facts: HardwareFacts, extra: readonly TierId[] = []): boolean {
	const present = pruneMissingTiers(tiers);
	return floorReady(tiers) && wantedTiers(facts, present, extra).every((tier) => present[tier]?.ready);
}

/** Drops tiers whose files were deleted, so a repair run reinstalls them. */
export function pruneMissingTiers(tiers: Tiers, exists: (path: string) => boolean = existsSync): Tiers {
	const kept: Record<string, unknown> = { ...tiers };
	for (const tier of TIER_ORDER) {
		const spec = tiers[tier];
		if (spec && !exists(spec.dir)) {
			delete kept[tier];
			if (tiers.preferred === tier) kept.preferred = "auto";
		}
	}
	return kept as Tiers;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Cross-process provisioning lock; a lock left by a dead process is taken over. */
export function acquireLock(home: string): { release(): void } | undefined {
	const path = join(home, "provision.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, String(process.pid));
			closeSync(fd);
			return { release: () => rmSync(path, { force: true }) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = Number.parseInt(readFileSync(path, "utf8"), 10);
			if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return undefined;
			rmSync(path, { force: true });
		}
	}
	return undefined;
}

const PROGRESS_STEP = 0.01;

export async function downloadVerified(asset: Asset, dest: string, onFraction: (fraction: number) => void): Promise<void> {
	const part = `${dest}.part`;
	const response = await fetch(asset.url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status} for ${asset.url}`);
	const hash = createHash("sha256");
	const file = await open(part, "w", 0o600);
	let received = 0;
	let reported = -1;
	try {
		for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
			hash.update(chunk);
			await file.write(chunk);
			received += chunk.length;
			const fraction = Math.min(1, received / asset.bytes);
			if (fraction - reported >= PROGRESS_STEP) {
				reported = fraction;
				onFraction(fraction);
			}
		}
	} finally {
		await file.close();
	}
	const digest = hash.digest("hex");
	if (digest !== asset.sha256) {
		rmSync(part, { force: true });
		throw new Error(`sha256 mismatch for ${asset.url}: got ${digest}`);
	}
	renameSync(part, dest);
	if (reported < 1) onFraction(1);
}

export function findHfSnapshot(env: Env, homedir: string, repo: string, revision: string, files: readonly string[]): string | undefined {
	const hub = env.HF_HUB_CACHE || join(env.HF_HOME || join(env.XDG_CACHE_HOME || join(homedir, ".cache"), "huggingface"), "hub");
	const dir = join(hub, `models--${repo.replace("/", "--")}`, "snapshots", revision);
	return files.every((file) => existsSync(join(dir, file))) ? dir : undefined;
}

export function parseUvVersion(output: string): [number, number, number] | undefined {
	const match = /\buv (\d+)\.(\d+)\.(\d+)/.exec(output);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function uvIsRecentEnough(version: readonly number[] | undefined): boolean {
	if (!version) return false;
	for (let i = 0; i < UV_MIN_VERSION.length; i++) {
		if (version[i] !== UV_MIN_VERSION[i]) return version[i] > UV_MIN_VERSION[i];
	}
	return true;
}

// ---------------------------------------------------------------- steps

class Provisioner {
	private readonly options: ProvisionOptions;
	private readonly models: string;
	private readonly logPath: string;

	constructor(options: ProvisionOptions) {
		this.options = options;
		this.models = join(options.home, "models");
		this.logPath = join(options.home, "provision.log");
	}

	private progress(label: string, fraction?: number): void {
		this.options.onProgress({ label, fraction });
	}

	private log(line: string): void {
		writeFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`, { flag: "a", mode: 0o600 });
	}

	private run(command: string, args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
		this.log(`$ ${command} ${args.join(" ")}`);
		const fd = openSync(this.logPath, "a", 0o600);
		return new Promise<void>((resolve, reject) => {
			const child = spawn(command, args, { stdio: ["ignore", fd, fd], env: { ...process.env, ...extraEnv } });
			child.on("error", reject);
			child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}; see ${this.logPath}`))));
		}).finally(() => closeSync(fd));
	}

	private uvEnv(): Record<string, string> {
		return {
			UV_PYTHON_INSTALL_DIR: join(this.options.home, "python"),
			UV_PYTHON_PREFERENCE: "only-managed",
			UV_NO_PROGRESS: "1",
		};
	}

	async uv(): Promise<string> {
		const { env, homedir, home, facts } = this.options;
		const dirs = [...(env.PATH ?? "").split(delimiter), join(homedir, ".local", "bin"), join(homedir, ".cargo", "bin")];
		const own = join(home, "bin", "uv");
		for (const candidate of [...dirs.filter(Boolean).map((dir) => join(dir, "uv")), own]) {
			if (!existsSync(candidate)) continue;
			const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
			if (uvIsRecentEnough(parseUvVersion(probe.stdout ?? ""))) return candidate;
		}
		const asset = uvAsset(facts.platform, facts.arch);
		if (!asset) throw new Error(`voice is not supported on ${facts.platform}-${facts.arch}`);
		mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
		const archive = join(home, "bin", "uv.tar.gz");
		await downloadVerified(asset, archive, (f) => this.progress("downloading uv", f));
		await this.run("tar", ["-xzf", archive, "-C", join(home, "bin")]);
		renameSync(join(home, "bin", asset.dir, "uv"), own);
		rmSync(join(home, "bin", asset.dir), { recursive: true, force: true });
		rmSync(archive, { force: true });
		return own;
	}

	async python(uv: string): Promise<string> {
		const envDir = join(this.options.home, "env");
		const python = join(envDir, "bin", "python");
		if (!existsSync(python)) {
			this.progress("installing python");
			await this.run(uv, ["venv", "--clear", "--python", PYTHON_VERSION, envDir], this.uvEnv());
		}
		return python;
	}

	async packages(uv: string, python: string, name: string, specs: readonly string[]): Promise<void> {
		const marker = join(this.options.home, "env", `.installed-${name}`);
		const wanted = specs.join(" ");
		if (existsSync(marker) && readFileSync(marker, "utf8") === wanted) return;
		this.progress(`installing ${name} packages`);
		await this.run(uv, ["pip", "install", "--python", python, ...specs], this.uvEnv());
		writeFileSync(marker, wanted);
	}

	async file(asset: Asset & { file: string }, dir: string, label: string): Promise<string> {
		const dest = join(dir, asset.file);
		if (existsSync(dest) && statSync(dest).size === asset.bytes) return dest;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		await downloadVerified(asset, dest, (f) => this.progress(label, f));
		return dest;
	}

	async archive(model: ArchiveModel, python: string, label: string): Promise<string> {
		const dest = join(this.models, model.dir);
		if (existsSync(join(dest, "tokens.txt"))) return dest;
		mkdirSync(this.models, { recursive: true, mode: 0o700 });
		const archive = join(this.models, `${model.dir}.tar.bz2`);
		await downloadVerified(model, archive, (f) => this.progress(label, f));
		this.progress(`unpacking ${label.replace(/^downloading /, "")}`);
		const staging = join(this.models, `.extract-${model.dir}`);
		rmSync(staging, { recursive: true, force: true });
		// Python's tarfile avoids depending on a bzip2 binary, which minimal Linux images may lack.
		await this.run(python, ["-c", "import sys,tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter='data')", archive, staging]);
		rmSync(dest, { recursive: true, force: true });
		renameSync(join(staging, model.dir), dest);
		rmSync(staging, { recursive: true, force: true });
		rmSync(archive, { force: true });
		return dest;
	}

	async mlxModel(): Promise<string> {
		const { env, homedir } = this.options;
		const cached = findHfSnapshot(env, homedir, MLX_REPO, MLX_REVISION, MLX_FILES.map((f) => f.file));
		if (cached) return cached;
		const dir = join(this.models, MLX_DIR);
		for (const asset of MLX_FILES) await this.file(asset, dir, "downloading mlx model");
		return dir;
	}

	installed(tier: TierId): boolean {
		const spec = readTiers(this.options.home)[tier];
		return Boolean(spec?.ready && existsSync(spec.dir));
	}

	markReady(patch: Partial<Record<keyof Tiers, unknown>>): void {
		writeTiers(this.options.home, { ...readTiers(this.options.home), ...patch } as Tiers);
	}

	async upgrade(tier: TierId, uv: string, python: string): Promise<void> {
		const { env, homedir, home } = this.options;
		const mlxCached = Boolean(findHfSnapshot(env, homedir, MLX_REPO, MLX_REVISION, MLX_FILES.map((f) => f.file)));
		const reason = skipReason(tier, freeBytes(home), mlxCached);
		if (reason) {
			this.log(`tier ${tier} skipped: ${reason}`);
			this.options.onSkip?.(tier, reason);
			return;
		}
		if (tier === "mlx") {
			await this.packages(uv, python, "mlx", MLX_PACKAGES);
			this.markReady({ mlx: { ready: true, dir: await this.mlxModel() } });
		} else if (tier === "cpu-large") {
			this.markReady({ "cpu-large": { ready: true, dir: await this.archive(LARGE_MODEL, python, "downloading large model") } });
		}
	}

	async all(extra: readonly TierId[]): Promise<void> {
		const uv = await this.uv();
		const python = await this.python(uv);
		await this.packages(uv, python, "cpu", CPU_PACKAGES);
		const vad = await this.file(VAD_MODEL, this.models, "downloading voice detector");
		const small = await this.archive(SMALL_MODEL, python, "downloading speech model");
		this.markReady({ python, vad, threads: chooseThreads(this.options.facts.cpus), "cpu-small": { ready: true, dir: small } });
		this.options.onProgress(undefined);
		const tiers = pruneMissingTiers(readTiers(this.options.home));
		for (const tier of wantedTiers(this.options.facts, tiers, extra)) {
			if (tier === "cpu-small" || this.installed(tier)) continue;
			try {
				await this.upgrade(tier, uv, python);
			} catch (error) {
				// The floor already works; a failed upgrade is retried on the next start.
				this.log(`tier ${tier} failed: ${(error as Error).message}`);
			}
		}
		this.options.onProgress(undefined);
	}
}

/** Returns "busy" when another Pi process is already provisioning. */
export async function provision(options: ProvisionOptions): Promise<"done" | "busy"> {
	mkdirSync(options.home, { recursive: true, mode: 0o700 });
	const lock = acquireLock(options.home);
	if (!lock) return "busy";
	try {
		await new Provisioner(options).all(options.extraTiers ?? []);
		return "done";
	} finally {
		lock.release();
	}
}
