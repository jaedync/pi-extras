/**
 * Finds and runs ast-grep. The order: $AST_GREP_BIN, the repository's own node_modules (a pinned devDependency,
 * so CI and every clone count with the same version), the pinned cache that `slop.mjs setup` fills, then PATH.
 * Only the name `ast-grep` is used: on Linux, `sg` is often the shadow-utils group command.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const AST_GREP_VERSION = "0.51.1";
/** The oldest version whose output and rule syntax the catalog tests passed on. */
export const MIN_VERSION = [0, 51, 0];
export const SETUP_HINT = "run `node <skill-dir>/scripts/slop.mjs setup` (it installs @ast-grep/cli into ~/.cache/pi-code-slop-rules), or add @ast-grep/cli as a pinned devDependency";
const MAX_OUTPUT = 512 * 1024 * 1024;

/** @param {NodeJS.ProcessEnv} env @param {string} home */
export function cacheRoot(env = process.env, home = homedir()) {
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), "pi-code-slop-rules");
}

/**
 * The native binary of an @ast-grep/cli install, found through the package's own resolver. Without its
 * postinstall (npm ci --ignore-scripts), the package's `ast-grep` file is a Node shim that resolves the binary on
 * every call; calling the binary directly skips that.
 * @param {string} nodeModulesParent the folder that holds node_modules
 */
function cliBinary(nodeModulesParent) {
	const shim = join(nodeModulesParent, "node_modules", "@ast-grep", "cli", "ast-grep");
	if (!existsSync(shim)) return null;
	const require = createRequire(join(nodeModulesParent, "package.json"));
	/** @type {{ resolveBinaryPath?: () => string | null }} */
	let resolver = {};
	try {
		resolver = require("@ast-grep/cli/postinstall.js");
	} catch (error) {
		// An older package has no resolver; its shim still works. Any other error is real.
		if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")) throw error;
	}
	const binary = resolver.resolveBinaryPath?.();
	if (binary && existsSync(binary)) return { command: binary, args: [] };
	return { command: process.execPath, args: [shim] };
}

/** @param {string} dir */
function* ancestors(dir) {
	for (let current = resolve(dir); ; current = dirname(current)) {
		yield current;
		if (dirname(current) === current) return;
	}
}

/** @param {string} root @param {NodeJS.ProcessEnv} env */
export function candidates(root, env = process.env) {
	/** @type {{ source: string, command: string, args: string[] }[]} */
	const found = [];
	if (env.AST_GREP_BIN) found.push({ source: "$AST_GREP_BIN", command: env.AST_GREP_BIN, args: [] });
	for (const dir of ancestors(root)) {
		const cli = cliBinary(dir);
		if (cli) { found.push({ source: join(dir, "node_modules"), ...cli }); break; }
	}
	const cached = cliBinary(cacheRoot(env));
	if (cached) found.push({ source: cacheRoot(env), ...cached });
	found.push({ source: "PATH", command: "ast-grep", args: [] });
	return found;
}

/** @param {string} text */
export function parseVersion(text) {
	const match = /ast-grep\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {number[]} a @param {number[]} b */
const atLeast = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

/**
 * @param {string} root
 * @returns {{ tool: { source: string, command: string, args: string[], version: string } | null, error: string }}
 */
export function findAstGrep(root, env = process.env) {
	/** @type {string[]} */
	const tried = [];
	for (const candidate of candidates(root, env)) {
		const result = spawnSync(candidate.command, [...candidate.args, "--version"], { encoding: "utf8", timeout: 30_000 });
		const version = result.status === 0 ? parseVersion(result.stdout) : null;
		if (!version) { tried.push(`${candidate.source}: ${result.error ? result.error.message : "no version"}`); continue; }
		if (!atLeast(version, MIN_VERSION)) { tried.push(`${candidate.source}: ${version.join(".")} is older than ${MIN_VERSION.join(".")}`); continue; }
		return { tool: { ...candidate, version: version.join(".") }, error: "" };
	}
	return { tool: null, error: `ast-grep ${MIN_VERSION.join(".")} or later was not found (${tried.join("; ")}). To fix: ${SETUP_HINT}.` };
}

/**
 * Installs the pinned @ast-grep/cli into the cache. `--ignore-scripts` keeps npm from running the package's
 * postinstall; the resolver above finds the native binary without it.
 * @param {(line: string) => void} log
 */
export function setup(log, env = process.env) {
	const root = cacheRoot(env);
	mkdirSync(root, { recursive: true });
	const manifest = join(root, "package.json");
	if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ private: true, name: "pi-code-slop-rules-cache" }, null, 2)}\n`);
	log(`Installing @ast-grep/cli@${AST_GREP_VERSION} into ${root}`);
	const result = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--save-exact", `@ast-grep/cli@${AST_GREP_VERSION}`],
		{ cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10 * 60_000 });
	if (result.status !== 0) throw new Error(`npm install failed: ${(result.stderr || result.error?.message || "").trim()}`);
}

/**
 * @param {{ command: string, args: string[] }} tool
 * @param {string[]} args
 * @param {string} cwd
 */
export function run(tool, args, cwd) {
	const result = spawnSync(tool.command, [...tool.args, ...args], { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: 10 * 60_000 });
	if (result.error) throw new Error(`ast-grep could not run: ${result.error.message}`);
	return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Scans with one config. The rule list comes from ast-grep's own `--inspect entity` lines, so a rule with no
 * findings is still known and a YAML file that ast-grep skipped is not counted.
 * @param {{ command: string, args: string[] }} tool
 * @param {{ config: string, cwd: string, paths?: string[], metadata?: boolean }} options
 */
export function scan(tool, { config, cwd, paths = [], metadata = false }) {
	const args = ["scan", "--config", config, "--json=stream", "--inspect", "entity", ...(metadata ? ["--include-metadata"] : []), ...paths];
	const result = run(tool, args, cwd);
	/** @type {string[]} */
	const ruleIds = [];
	/** @type {string[]} */
	const errors = [];
	for (const line of result.stderr.split("\n")) {
		const rule = /^sg: entity\|rule\|([^:]+):/.exec(line);
		if (rule) ruleIds.push(rule[1]);
		else if (line.trim() && !line.startsWith("sg: ")) errors.push(line);
	}
	// ast-grep exits 1 when an error-severity rule matched; that is a finding, not a failed run.
	if (result.status !== 0 && (result.status !== 1 || errors.length)) {
		throw new Error(`ast-grep scan failed (exit ${result.status}): ${errors.join("\n").trim() || result.stdout.trim()}`);
	}
	const findings = result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
	return { ruleIds, findings };
}

/**
 * Runs the rule tests (each rule's valid and invalid cases). Snapshot tests are skipped: they pin label output,
 * which this skill does not use.
 * @param {{ command: string, args: string[] }} tool
 * @param {{ config: string, cwd: string }} options
 */
export function testRules(tool, { config, cwd }) {
	const result = run(tool, ["test", "--config", config, "--skip-snapshot-tests"], cwd);
	const summary = /test result: (\w+)\. (\d+) passed; (\d+) failed/.exec(result.stdout);
	return { ok: result.status === 0, passed: Number(summary?.[2] ?? 0), failed: Number(summary?.[3] ?? 0), output: `${result.stdout}${result.stderr}` };
}
