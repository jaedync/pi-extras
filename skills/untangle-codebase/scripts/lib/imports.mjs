// Finds the local files that a source file imports. Package imports are ignored:
// the graph is about how this codebase's own pieces depend on each other.
import { dirname, posix } from "node:path";
import { JS_EXTENSIONS, languageOf } from "./files.mjs";

const JS_PATTERNS = [
	/(?:^|[;\s}])import\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g,
	/(?:^|[;\s}])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g,
	/\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
	/\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[\w \t,*]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;

/** @param {string} text */
function stripJsComments(text) {
	// Keeps line breaks so that later line numbers stay right; good enough for import lines.
	return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** @param {string} text @returns {{ specifier: string }[]} */
function jsSpecifiers(text) {
	const clean = stripJsComments(text);
	const out = [];
	for (const pattern of JS_PATTERNS) {
		for (const match of clean.matchAll(pattern)) out.push({ specifier: match[1] });
	}
	return out;
}

/**
 * @param {string} file @param {Set<string>} known
 * @param {string} specifier
 */
function resolveJs(file, known, specifier) {
	if (!specifier.startsWith(".")) return null;
	const base = posix.normalize(posix.join(dirname(file), specifier));
	const stem = base.replace(/\.(m|c)?js$|\.jsx$/, "");
	const candidates = [base, ...JS_EXTENSIONS.map((ext) => stem + ext), ...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
	return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** @param {string} modulePath dotted, with no leading dots @param {string} baseDir @param {Set<string>} known */
function resolvePyFrom(modulePath, baseDir, known) {
	const path = modulePath ? posix.join(baseDir, ...modulePath.split(".")) : baseDir;
	return [`${path}.py`, `${path}/__init__.py`].map((p) => posix.normalize(p)).find((p) => known.has(p)) ?? null;
}

/** Absolute Python imports: try the root and each folder above the importing file. */
function resolvePyAbsolute(file, modulePath, known) {
	const dirs = [];
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		dirs.push(dir === "." ? "" : dir);
		if (dir === "." || dir === "/" || dir === "") break;
	}
	for (const dir of dirs) {
		const hit = resolvePyFrom(modulePath, dir || ".", known);
		if (hit) return hit.replace(/^\.\//, "");
	}
	return null;
}

/** @param {string} file @param {string} text @param {Set<string>} known */
function pyImports(file, text, known) {
	const out = [];
	for (const match of text.matchAll(PY_FROM)) {
		const [, dots, modulePath, names] = match;
		if (dots) {
			let baseDir = dirname(file);
			for (let i = 1; i < dots.length; i++) baseDir = dirname(baseDir);
			const target = resolvePyFrom(modulePath, baseDir, known);
			// `from . import a, b` imports sibling modules, not the package file.
			const subs = names.replace(/[()]/g, "").split(",").map((n) => n.trim().split(/\s+/)[0]).filter(Boolean);
			const subTargets = subs.map((n) => resolvePyFrom(modulePath ? `${modulePath}.${n}` : n, baseDir, known)).filter(Boolean);
			out.push(...(subTargets.length ? subTargets : [target]));
		} else {
			out.push(resolvePyAbsolute(file, modulePath, known));
		}
	}
	for (const match of text.matchAll(PY_IMPORT)) {
		for (const name of match[1].split(",")) out.push(resolvePyAbsolute(file, name.trim(), known));
	}
	return out.map((p) => (p ? p.replace(/^\.\//, "") : p));
}

/**
 * The local files that `file` imports, without duplicates and without itself.
 * @param {string} file @param {string} text @param {Set<string>} known all files in the graph
 * @returns {string[]}
 */
export function localImports(file, text, known) {
	const lang = languageOf(file);
	const targets = lang === "js"
		? jsSpecifiers(text).map(({ specifier }) => resolveJs(file, known, specifier))
		: lang === "py" ? pyImports(file, text, known) : [];
	return [...new Set(targets.filter((t) => t && t !== file))];
}
