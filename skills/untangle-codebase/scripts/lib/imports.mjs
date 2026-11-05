// Finds the local files that a source file imports. Package imports are ignored:
// the graph is about how this codebase's own pieces depend on each other.
import { dirname, posix } from "node:path";
import { JS_EXTENSIONS, languageOf } from "./files.mjs";
import { lex } from "./lex.mjs";

// These run on lexed code, where string contents are spaces: a pattern can only
// match real import syntax, and the specifier is read back from the original text
// at the same offsets.
const JS_PATTERNS = [
	/(?:^|[;\s}])import\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?(["'])( *)\1/dg,
	/(?:^|[;\s}])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(["'])( *)\1/dg,
	/\bimport\(\s*(["'])( *)\1\s*\)/dg,
	/\brequire\(\s*(["'])( *)\1\s*\)/dg,
];
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[\w \t,*]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
// Python finds absolute imports from the folders on sys.path. For a repository
// that is usually its root, or `src` in the src layout.
const PY_ROOTS = ["", "src"];

/** @param {string} text */
function jsSpecifiers(text) {
	const { code } = lex(text, "js");
	const out = [];
	for (const pattern of JS_PATTERNS) {
		for (const match of code.matchAll(pattern)) {
			const [start, end] = match.indices[2];
			out.push(text.slice(start, end));
		}
	}
	return out;
}

/** @param {string} file @param {Set<string>} known @param {string} specifier */
function resolveJs(file, known, specifier) {
	if (!specifier.startsWith(".")) return null;
	const base = posix.normalize(posix.join(dirname(file), specifier));
	const stem = base.replace(/\.(m|c)?js$|\.jsx$/, "");
	const candidates = [base, ...JS_EXTENSIONS.map((ext) => stem + ext), ...JS_EXTENSIONS.map((ext) => posix.join(base, `index${ext}`))];
	return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** @param {string} modulePath dotted, with no leading dots @param {string} baseDir @param {Set<string>} known */
function resolvePyModule(modulePath, baseDir, known) {
	const path = modulePath ? posix.join(baseDir || ".", ...modulePath.split(".")) : baseDir || ".";
	return [`${path}.py`, `${path}/__init__.py`].map((p) => posix.normalize(p)).find((p) => known.has(p)) ?? null;
}

/** @param {string} file @param {string} text @param {Set<string>} known */
function pyImports(file, text, known) {
	const { code } = lex(text, "py");
	const out = [];
	for (const [, dots, modulePath, names] of code.matchAll(PY_FROM)) {
		if (!dots) {
			out.push(...PY_ROOTS.map((root) => resolvePyModule(modulePath, root, known)));
			continue;
		}
		let baseDir = dirname(file);
		for (let i = 1; i < dots.length; i++) baseDir = dirname(baseDir);
		// `from . import a, b` imports sibling modules; names that are not modules
		// are functions or classes of the package file itself.
		const subs = names.replace(/[()]/g, "").split(",").map((n) => n.trim().split(/\s+/)[0]).filter(Boolean);
		const subTargets = subs.map((n) => resolvePyModule(modulePath ? `${modulePath}.${n}` : n, baseDir, known)).filter(Boolean);
		out.push(...(subTargets.length ? subTargets : [resolvePyModule(modulePath, baseDir, known)]));
	}
	for (const [, list] of code.matchAll(PY_IMPORT)) {
		for (const part of list.split(",")) {
			const name = part.trim().split(/\s+/)[0];
			out.push(...PY_ROOTS.map((root) => resolvePyModule(name, root, known)));
		}
	}
	return out;
}

/**
 * The local files that `file` imports, without duplicates and without itself.
 * @param {string} file @param {string} text @param {Set<string>} known all files that can be targets
 * @returns {string[]}
 */
export function localImports(file, text, known) {
	const lang = languageOf(file);
	const targets = lang === "js"
		? jsSpecifiers(text).map((specifier) => resolveJs(file, known, specifier))
		: lang === "py" ? pyImports(file, text, known) : [];
	return [...new Set(targets.filter((t) => t && t !== file))];
}
