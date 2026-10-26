/**
 * Installs one release into the store: into `<final>.staging-<random>`,
 * verified, then renamed to its final name, so a half install never has a
 * final name. A final folder is never changed again: it is made read-only,
 * so a manual in-place `pi update` fails loudly instead of changing a tree a
 * running process loads from.
 *
 * Commands follow Pi's own: Pi itself with `npm install -g --ignore-scripts
 * --prefix`, npm packages with `npm install <spec> --prefix
 * --legacy-peer-deps`, git packages with a clone and `npm install
 * --omit=dev --legacy-peer-deps` (pi-coding-agent core/package-manager.js).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RELEASE_MARKER, STAGING_TAG } from "./gc.ts";
import type { StorePaths } from "./paths.ts";
import { describeFailure, type Runner } from "./run.ts";
import type { Origin } from "./sources.ts";
import type { PackageRelease, PiRelease } from "./state.ts";
import type { GitRelease } from "./versions.ts";

export const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface InstallDeps {
	readonly runner: Runner;
	readonly now: () => number;
	readonly timeoutMs?: number;
}

type NpmOrigin = Extract<Origin, { kind: "npm" }>;
type GitOrigin = Extract<Origin, { kind: "git" }>;

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Removes write permission everywhere under `dir`, without following symlinks. */
export function makeReadOnly(dir: string): void {
	const stat = lstatSync(dir);
	if (stat.isSymbolicLink()) return;
	if (stat.isDirectory()) for (const entry of readdirSync(dir)) makeReadOnly(join(dir, entry));
	chmodSync(dir, stat.mode & 0o7555);
}

function removeStaging(dir: string): void {
	if (!existsSync(dir)) return;
	const writable = (path: string): void => {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return;
		chmodSync(path, (stat.mode & 0o777) | 0o200);
		if (stat.isDirectory()) for (const entry of readdirSync(path)) writable(join(path, entry));
	};
	writable(dir);
	rmSync(dir, { recursive: true, force: true });
}

/** Runs one install step; `step` names it in the error ("git clone"). */
async function run(deps: InstallDeps, step: string, command: string, args: readonly string[], cwd?: string): Promise<void> {
	const result = await deps.runner(command, args, { cwd, timeoutMs: deps.timeoutMs ?? INSTALL_TIMEOUT_MS });
	if (result.code !== 0) throw new Error(`${step} failed: ${describeFailure(result)}`);
}

/**
 * Builds `final` with `build(staging)`, which throws when the result is
 * wrong. Reuses a final folder that already exists: it was verified before
 * it got its name.
 */
async function staged(final: string, deps: InstallDeps, build: (staging: string) => Promise<void>): Promise<void> {
	if (existsSync(join(final, RELEASE_MARKER))) return;
	if (existsSync(final)) removeStaging(final);
	mkdirSync(dirname(final), { recursive: true });
	const staging = `${final}${STAGING_TAG}${randomBytes(4).toString("hex")}`;
	try {
		mkdirSync(staging);
		await build(staging);
		writeFileSync(join(staging, RELEASE_MARKER), `${JSON.stringify({ installedAt: deps.now() })}\n`);
		renameSync(staging, final);
	} catch (error) {
		removeStaging(staging);
		throw error;
	}
	makeReadOnly(final);
}

export async function installPi(paths: StorePaths, name: string, version: string, deps: InstallDeps): Promise<PiRelease> {
	const dir = paths.piDir(version);
	await staged(dir, deps, async (staging) => {
		await run(deps, "npm install", "npm", ["install", "-g", "--prefix", staging, "--ignore-scripts", "--min-release-age=0", `${name}@${version}`]);
		const manifest = readJson(join(staging, "lib", "node_modules", name, "package.json"));
		if (manifest?.version !== version) throw new Error(`npm installed ${String(manifest?.version)} of ${name}, not ${version}`);
		if (!existsSync(join(staging, "bin", "pi"))) throw new Error(`the ${name} install has no bin/pi`);
	});
	return { version, dir };
}

export async function installNpmRelease(paths: StorePaths, origin: NpmOrigin, version: string, deps: InstallDeps): Promise<PackageRelease> {
	const dir = paths.releaseDir(origin.key, version);
	const entry = join(dir, "node_modules", origin.name);
	await staged(dir, deps, async (staging) => {
		// npm installs into the prefix only when it holds a package.json.
		writeFileSync(join(staging, "package.json"), `${JSON.stringify({ name: "pi-extras-release", private: true })}\n`);
		await run(deps, "npm install", "npm", ["install", `${origin.name}@${version}`, "--prefix", staging, "--legacy-peer-deps"]);
		const manifest = readJson(join(staging, "node_modules", origin.name, "package.json"));
		if (manifest?.version !== version) throw new Error(`npm installed ${String(manifest?.version)} of ${origin.name}, not ${version}`);
	});
	return { origin: origin.source, id: version, dir, entry, label: `${origin.label} ${version}` };
}

async function headCommit(deps: InstallDeps, dir: string): Promise<string> {
	const result = await deps.runner("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
	if (result.code !== 0) throw new Error(`git rev-parse failed: ${describeFailure(result)}`);
	return result.stdout.trim();
}

export async function installGitRelease(paths: StorePaths, origin: GitOrigin, release: GitRelease, deps: InstallDeps): Promise<PackageRelease> {
	const dir = paths.releaseDir(origin.key, release.id);
	await staged(dir, deps, async (staging) => {
		const branch = release.ref === "HEAD" ? [] : ["--branch", release.ref];
		await run(deps, "git clone", "git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--single-branch", ...branch, origin.url, staging]);
		const commit = await headCommit(deps, staging);
		// The tag or branch moved after the lookup: the next cycle installs what it points to then.
		if (commit !== release.commit) throw new Error(`${release.ref} moved during the install`);
		if (existsSync(join(staging, "package.json"))) await run(deps, "npm install", "npm", ["install", "--omit=dev", "--legacy-peer-deps"], staging);
	});
	const manifest = readJson(join(dir, "package.json"));
	const name = typeof manifest?.name === "string" ? manifest.name : origin.label;
	const shown = release.version ?? release.commit.slice(0, 7);
	return { origin: origin.source, id: release.id, dir, entry: dir, label: `${name} ${shown}` };
}
