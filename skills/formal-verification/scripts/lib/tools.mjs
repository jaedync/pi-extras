// Install Quint and a Java runtime at user scope, pinned, with checksums.
// Quint itself downloads Apalache (which carries TLC) and its Rust simulator
// into ~/.quint on first use.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QUINT_VERSION = "0.33.1";
export const JRE_RELEASE = "jdk-21.0.13+9";
const JRE_BASE = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9";
/** Temurin 21 JRE tarballs and their SHA-256 sums from api.adoptium.net. */
export const JRE_BUILDS = {
	"linux-x64": { file: "OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz", sha256: "a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd" },
	"linux-arm64": { file: "OpenJDK21U-jre_aarch64_linux_hotspot_21.0.13_9.tar.gz", sha256: "b1734db7ade49c3f6acc6ae06233b8c2dd90e3e2f00f67000ae1c972aaa64d8c" },
	"darwin-arm64": { file: "OpenJDK21U-jre_aarch64_mac_hotspot_21.0.13_9.tar.gz", sha256: "225bab0a09491ef06835488cd942f5d2befa9a0410a2484f0c8bbcf7506ec09a" },
	"darwin-x64": { file: "OpenJDK21U-jre_x64_mac_hotspot_21.0.13_9.tar.gz", sha256: "c909674b1c10c261b9a3fb7e9c0efebd303e33f88a4fe84be7135b5e2d711f89" },
};
const MIN_JAVA = 17; // Apalache needs Java 17 or later.

export function cacheDir(env = process.env) {
	const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
	return join(base, "pi-formal-verification");
}

/** @returns {{ file: string, sha256: string } | null} */
export function jreBuild(platform = process.platform, arch = process.arch) {
	return JRE_BUILDS[`${platform}-${arch}`] ?? null;
}

/** The major version in `java -version` output, or null. */
export function javaMajor(versionText) {
	const match = /version "(\d+)(?:\.(\d+))?/.exec(versionText);
	if (!match) return null;
	const first = Number(match[1]);
	return first === 1 && match[2] ? Number(match[2]) : first;
}

function run(command, args, options = {}) {
	return spawnSync(command, args, { encoding: "utf8", ...options });
}

/** A java of version 17 or later: the pinned one in the cache, else one on PATH. */
export function findJava(dir = cacheDir()) {
	const pinned = javaInCache(dir);
	if (pinned) return pinned;
	const probe = run("java", ["-version"]);
	if (probe.status === 0 && (javaMajor(`${probe.stderr}${probe.stdout}`) ?? 0) >= MIN_JAVA) return "java";
	return null;
}

function javaInCache(dir) {
	const home = join(dir, JRE_RELEASE);
	for (const candidate of [join(home, "bin", "java"), join(home, "Contents", "Home", "bin", "java")]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function quintBin(dir = cacheDir()) {
	return join(dir, `quint-${QUINT_VERSION}`, "node_modules", ".bin", "quint");
}

async function download(url, path, sha256) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`download failed: ${url} answered ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== sha256) throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
	writeFileSync(path, bytes);
}

async function installJre(dir, log) {
	const build = jreBuild();
	if (!build) throw new Error(`no pinned Java runtime for ${process.platform}-${process.arch}; install Java 17 or later and put it on PATH`);
	const staging = join(dir, `${JRE_RELEASE}.partial`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const tarball = join(staging, build.file);
	log(`downloading Temurin ${JRE_RELEASE} JRE (${build.file})`);
	await download(`${JRE_BASE}/${build.file}`, tarball, build.sha256);
	const untar = run("tar", ["-xzf", tarball, "-C", staging, "--strip-components=1"]);
	if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
	rmSync(tarball);
	renameSync(staging, join(dir, JRE_RELEASE));
}

function installQuint(dir, log) {
	const prefix = join(dir, `quint-${QUINT_VERSION}`);
	log(`installing @informalsystems/quint@${QUINT_VERSION} into ${prefix}`);
	const npm = run("npm", ["install", "--silent", "--no-audit", "--no-fund", "--ignore-scripts", "--prefix", prefix, `@informalsystems/quint@${QUINT_VERSION}`]);
	if (npm.status !== 0) throw new Error(`npm install failed: ${npm.stderr || npm.stdout}`);
}

/**
 * Install what is missing and return the paths. Safe to run again.
 * @param {{ log?: (line: string) => void, dir?: string }} [options]
 */
export async function setup(options = {}) {
	const log = options.log ?? (() => {});
	const dir = options.dir ?? cacheDir();
	mkdirSync(dir, { recursive: true });
	let java = findJava(dir);
	if (!java) {
		await installJre(dir, log);
		java = javaInCache(dir);
	}
	if (!existsSync(quintBin(dir))) installQuint(dir, log);
	const version = run(quintBin(dir), ["--version"]);
	if (version.status !== 0 || version.stdout.trim() !== QUINT_VERSION) throw new Error(`quint did not run: ${version.stderr || version.stdout}`);
	return { java, quint: quintBin(dir), dir };
}

/** PATH with the chosen java first, for quint's child processes. */
export function envWithJava(java, env = process.env) {
	if (java === "java") return { ...env };
	const bin = java.slice(0, java.lastIndexOf("/"));
	return { ...env, PATH: `${bin}:${env.PATH ?? ""}` };
}

/** Files under the cache, for a status line. */
export function installed(dir = cacheDir()) {
	return existsSync(dir) ? readdirSync(dir) : [];
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}
