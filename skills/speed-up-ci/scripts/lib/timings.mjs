import { realpathSync } from "node:fs";
import { byCodePoint } from "./stats.mjs";
import { dirname, basename, isAbsolute, join, relative, sep } from "node:path";

const TEST_FILE = /\.(m?[jt]sx?|c[jt]s|py|rb|go|rs|java|kt|php|ex|exs)$/;

/** The real path, or the path as given when it does not exist. The folder is resolved when the file is gone. */
function real(path) {
	try {
		return realpathSync(path);
	} catch {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return path;
		}
	}
}

/**
 * A repository-relative path with forward slashes, or the path as given when it is outside the root. A test runner
 * can name files through a symlink that the root does not use, or the reverse (on macOS, the temp folder /var is a
 * link to /private/var), so a path outside the root is compared again with both sides resolved.
 */
function normalize(path, root) {
	if (!isAbsolute(path)) return path.split(sep).join("/");
	for (const [from, to] of [[root, path], [real(root), real(path)]]) {
		const rel = relative(from, to);
		if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
	}
	return path.split(sep).join("/");
}

/** @param {string} tag */
function attributes(tag) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[match[1]] = decode(match[2]);
	return out;
}

/** @param {string} text */
function decode(text) {
	return text.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** @param {Map<string, number>} map @param {string} key @param {number} value */
function add(map, key, value) {
	map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * Seconds per test file from JUnit XML. A suite whose test cases carry `file` attributes (Jest, pytest xunit1) adds up
 * those cases; otherwise a suite counts by its `file` attribute, or by its name when the name is a path (Vitest).
 * Suites named after a describe block, with no file, are dropped.
 * @param {string} xml @param {string} root
 */
export function parseJunit(xml, root) {
	/** @type {Map<string, number>} */
	const out = new Map();
	for (const suite of xml.matchAll(/<testsuite\b([^>]*?)(\/>|>([\s\S]*?)<\/testsuite>)/g)) {
		const attrs = attributes(suite[1]);
		const body = suite[3] ?? "";
		const cases = [...body.matchAll(/<testcase\b([^>]*?)\/?>/g)].map((match) => attributes(match[1]));
		const withFile = cases.filter((testCase) => testCase.file);
		if (withFile.length > 0) {
			for (const testCase of withFile) add(out, normalize(testCase.file, root), Number(testCase.time) || 0);
			continue;
		}
		const file = attrs.file ?? (attrs.name && (/[\\/]/.test(attrs.name) || TEST_FILE.test(attrs.name)) ? attrs.name : undefined);
		if (file) add(out, normalize(file, root), Number(attrs.time) || 0);
	}
	return out;
}

/**
 * Seconds per test file from a Vitest or Jest JSON report (`testResults[]` with `startTime`/`endTime` or
 * `perfStats.start`/`perfStats.end` in milliseconds).
 * @param {any} report @param {string} root
 */
export function parseJsonReport(report, root) {
	/** @type {Map<string, number>} */
	const out = new Map();
	for (const result of report?.testResults ?? []) {
		if (typeof result?.name !== "string") continue;
		const start = result.startTime ?? result.perfStats?.start;
		const end = result.endTime ?? result.perfStats?.end;
		if (typeof start !== "number" || typeof end !== "number") continue;
		add(out, normalize(result.name, root), Math.max(0, end - start) / 1000);
	}
	return out;
}

/**
 * Each shard reports only its own files, so a file named twice comes from a re-run; keep the longer time.
 * @param {Map<string, number>[]} maps
 * @returns {Record<string, number>}
 */
export function mergeTimings(maps) {
	/** @type {Map<string, number>} */
	const merged = new Map();
	for (const map of maps) for (const [file, value] of map) merged.set(file, Math.max(merged.get(file) ?? 0, value));
	return Object.fromEntries([...merged].sort(([a], [b]) => byCodePoint(a, b)).map(([file, value]) => [file, Math.round(value * 1000) / 1000]));
}

/**
 * Vitest and others name files relative to their own root. In a package of a monorepo, prefix those names with the
 * package path so that they match the repository paths in the file list. Absolute paths stay as they are.
 * @param {Record<string, number>} files @param {string} prefix
 */
export function prefixTimings(files, prefix) {
	if (!prefix) return files;
	const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
	return Object.fromEntries(Object.entries(files).map(([file, value]) => [isAbsolute(file) ? file : `${base}${file}`, value]));
}
