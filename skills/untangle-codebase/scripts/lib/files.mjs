// Source file discovery shared by every untangle command.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

export const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
export const PY_EXTENSIONS = [".py"];
const SOURCE_EXTENSIONS = new Set([...JS_EXTENSIONS, ...PY_EXTENSIONS]);

// Folders that hold build output, vendored code or caches, never hand-written source.
const SKIPPED_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo",
	"vendor", "third_party", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
]);
const GENERATED_FILE = /(\.min\.(js|mjs|cjs)$|\.d\.ts$|\.generated\.|\.gen\.)/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;

/** @param {string} file */
export function languageOf(file) {
	const ext = extname(file);
	if (JS_EXTENSIONS.includes(ext)) return "js";
	if (PY_EXTENSIONS.includes(ext)) return "py";
	return null;
}

/** @param {string} file a path relative to the root, with forward slashes */
export function isTestFile(file) {
	return TEST_FILE.test(file);
}

/** @param {string} file */
function isSource(file) {
	if (!SOURCE_EXTENSIONS.has(extname(file)) || GENERATED_FILE.test(file)) return false;
	return !file.split("/").some((part) => SKIPPED_DIRS.has(part));
}

/** @param {string} root */
function gitFiles(root) {
	try {
		const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
			cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024,
		});
		return out.split("\0").filter(Boolean);
	} catch {
		return null; // not a git checkout: the caller walks the folder instead
	}
}

/** @param {string} root @param {string} dir @param {string[]} acc */
function walk(root, dir, acc) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) walk(root, join(dir, entry.name), acc);
		} else if (entry.isFile()) {
			acc.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
		}
	}
	return acc;
}

/**
 * Lists hand-written source files under root, relative to root, sorted.
 * @param {string} root
 * @param {{ includeTests?: boolean }} [options]
 */
export function listSourceFiles(root, { includeTests = false } = {}) {
	const all = gitFiles(root) ?? walk(root, root, []);
	return all
		.filter(isSource)
		.filter((file) => includeTests || !isTestFile(file))
		.filter((file) => {
			try {
				return statSync(join(root, file)).isFile();
			} catch {
				return false; // listed by git but deleted in the working tree
			}
		})
		.sort();
}

/** @param {string} root @param {string} file */
export function readSource(root, file) {
	return readFileSync(join(root, file), "utf8");
}
