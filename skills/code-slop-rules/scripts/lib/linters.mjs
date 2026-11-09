/**
 * Finds the linters a repository already runs, and when a linter can print its resolved config, which of the
 * rules that overlap the catalog it enforces. A pattern that a linter already fails on needs no ast-grep rule.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ESLINT_FILES = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts",
	".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"];
const BIOME_FILES = ["biome.json", "biome.jsonc"];
const RUFF_FILES = ["ruff.toml", ".ruff.toml"];

/** @param {string} path */
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/**
 * @typedef {{ name: string, config: string, enforced: Set<string> | null, note?: string }} Linter
 * `enforced` is null when the linter is configured but its rule state could not be read.
 */

/** @param {string} root @param {string | undefined} sampleFile */
function eslint(root, sampleFile) {
	const pkg = read(join(root, "package.json"));
	const config = ESLINT_FILES.find((file) => existsSync(join(root, file))) ?? (/"eslintConfig"\s*:/.test(pkg) ? "package.json eslintConfig" : null);
	if (!config) return null;
	const bin = join(root, "node_modules", ".bin", "eslint");
	if (!existsSync(bin) || !sampleFile) return { name: "eslint", config, enforced: null, note: "install dependencies to read the rule state" };
	const result = spawnSync(bin, ["--print-config", sampleFile], { cwd: root, encoding: "utf8", timeout: 60_000 });
	try {
		/** @type {Record<string, unknown>} */
		const rules = JSON.parse(result.stdout).rules ?? {};
		const on = Object.entries(rules).filter(([, value]) => {
			const level = Array.isArray(value) ? value[0] : value;
			return level !== 0 && level !== "off";
		}).map(([rule]) => rule);
		return { name: "eslint", config, enforced: new Set(on) };
	} catch {
		return { name: "eslint", config, enforced: null, note: `eslint --print-config failed: ${result.stderr.trim().split("\n")[0] ?? ""}` };
	}
}

/** @param {string} root @param {string | undefined} sampleFile */
function ruff(root, sampleFile) {
	const config = RUFF_FILES.find((file) => existsSync(join(root, file))) ?? (/^\[tool\.ruff/m.test(read(join(root, "pyproject.toml"))) ? "pyproject.toml [tool.ruff]" : null);
	if (!config) return null;
	const result = spawnSync("ruff", ["check", "--show-settings", sampleFile ?? "."], { cwd: root, encoding: "utf8", timeout: 60_000 });
	if (result.status !== 0 || !result.stdout) return { name: "ruff", config, enforced: null, note: "ruff is not on PATH; rule state unknown" };
	const block = /linter\.rules\.enabled = \[([\s\S]*?)\]/.exec(result.stdout)?.[1] ?? "";
	return { name: "ruff", config, enforced: new Set([...block.matchAll(/\(([A-Z]+\d+)\)/g)].map((m) => m[1])) };
}

/** @param {string} root */
function configOnly(root) {
	/** @type {Linter[]} */
	const found = [];
	const biome = BIOME_FILES.find((file) => existsSync(join(root, file)));
	if (biome) found.push({ name: "biome", config: biome, enforced: null, note: "check the rules named in the overlap column" });
	// tsc checks types, not these syntax patterns: no catalog rule overlaps it, so it is listed only to say so.
	if (existsSync(join(root, "tsconfig.json"))) found.push({ name: "tsc", config: "tsconfig.json", enforced: null, note: "no catalog rule overlaps tsc" });
	const pyproject = read(join(root, "pyproject.toml"));
	if (existsSync(join(root, "mypy.ini")) || /^\[tool\.mypy/m.test(pyproject)) found.push({ name: "mypy", config: "mypy config", enforced: null });
	if (existsSync(join(root, ".flake8")) || /^\[flake8\]/m.test(read(join(root, "setup.cfg")))) found.push({ name: "flake8", config: "flake8 config", enforced: null });
	if (existsSync(join(root, ".pylintrc")) || /^\[tool\.pylint/m.test(pyproject)) found.push({ name: "pylint", config: "pylint config", enforced: null });
	return found;
}

/**
 * @param {string} root
 * @param {{ js?: string, py?: string }} samples one source file per language, for the linters that resolve config per file
 * @returns {Linter[]}
 */
export function detectLinters(root, samples) {
	return /** @type {Linter[]} */ ([eslint(root, samples.js), ruff(root, samples.py), ...configOnly(root)].filter(Boolean));
}

/**
 * The overlap verdict of one rule: which configured linter enforces it, or may.
 * @param {Record<string, string[]> | undefined} overlap from the rule's metadata
 * @param {Linter[]} linters
 */
export function overlapOf(overlap, linters) {
	/** @type {string[]} */
	const enforcedBy = [];
	/** @type {string[]} */
	const unknown = [];
	for (const linter of linters) {
		const rules = overlap?.[linter.name] ?? [];
		if (!rules.length) continue;
		if (!linter.enforced) { unknown.push(`${linter.name}: ${rules.join(", ")}`); continue; }
		const on = rules.filter((rule) => linter.enforced?.has(rule));
		if (on.length) enforcedBy.push(`${linter.name}: ${on.join(", ")}`);
	}
	return { enforcedBy, unknown };
}
