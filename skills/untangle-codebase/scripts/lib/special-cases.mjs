// Counts the code shapes that usually mark a special case: a requirement that the
// design does not cover. The count is a trend number for one codebase (before and
// after), not a score to compare across projects. Code patterns run on lexed code,
// where comments and string contents are blank; note patterns run on comments only.
import { languageOf, listSourceFiles, readSource } from "./files.mjs";
import { lex } from "./lex.mjs";

/**
 * Each category has per-language patterns on `code` lines, on `comments` lines, and
 * `block` patterns (global regexes) on the whole lexed code for shapes that span lines.
 * inTotal: false marks a weak signal. A literal comparison is often a good
 * discriminated-union branch, so it is shown but kept out of the progress number.
 * @typedef {{ code?: RegExp[], comments?: RegExp[], block?: RegExp[] }} Patterns
 * @type {{ id: string, title: string, inTotal: boolean, js: Patterns, py: Patterns }[]}
 */
export const CATEGORIES = [
	{
		id: "swallowed-error",
		title: "Swallowed exception or fallback value",
		inTotal: true,
		js: {
			code: [/\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|undefined|null|void 0|\[\]|""|''|false|true|-?\d+)\s*\)/],
			// `catch {}` and `catch (e) { return <value>; }`: the error goes nowhere.
			block: [/\bcatch\s*(\([^)]*\))?\s*\{\s*(return\b[^;{}\n]*;?\s*)?\}/g],
		},
		py: {
			block: [/^[ \t]*except\b[^:\n]*:[ \t]*(\n[ \t]*)?(pass|\.\.\.|return\b[^\n]*|continue)[ \t]*$/gm],
		},
	},
	{
		id: "sleep-or-retry",
		title: "Retry, sleep or fixed wait",
		inTotal: true,
		js: { code: [/\bsetTimeout\([^;]*,\s*\d+\s*\)/, /\b(sleep|delay|wait)\(\s*\d+/, /retr(y|ies|ying)/i] },
		py: { code: [/\btime\.sleep\(/, /\basyncio\.sleep\(\s*\d/, /retr(y|ies|ying)/i] },
	},
	{
		id: "disabled-test",
		title: "Disabled or skipped test",
		inTotal: true,
		js: { code: [/\b(it|test|describe)\.(skip|todo)\b/, /\bx(it|describe|test)\(/, /\bskip:\s*(true|["'`])/] },
		py: { code: [/@(pytest\.mark\.skip|pytest\.mark\.xfail|unittest\.skip)/] },
	},
	{
		id: "suppression",
		title: "Type or lint check turned off",
		inTotal: true,
		js: {
			code: [/[\w)\]]\s+as\s+any\b/, /:\s*any\b(?=\s*[;,)=\]>|{]|\s*$)/],
			comments: [/@ts-(ignore|expect-error|nocheck)\b/, /eslint-disable/],
		},
		py: { comments: [/#\s*type:\s*ignore/, /#\s*noqa/, /#\s*pylint:\s*disable/] },
	},
	{
		id: "workaround-note",
		title: "TODO, FIXME, HACK or workaround note",
		inTotal: true,
		js: { comments: [/\b(TODO|FIXME|HACK|XXX)\b/, /\bworkaround\b/i] },
		py: { comments: [/\b(TODO|FIXME|HACK|XXX)\b/, /\bworkaround\b/i] },
	},
	{
		id: "literal-branch",
		title: "Branch on one literal value (weak signal)",
		inTotal: false,
		js: { code: [/\bif\s*\(.*[!=]==?\s*["'`]/] },
		py: { code: [/^\s*(el)?if\b.*[!=]=\s*["']/] },
	},
];

/** Hits for one file: one entry per line and category, so a line counts once per category. */
export function scanText(file, text) {
	const lang = languageOf(file);
	if (!lang) return [];
	const { code, comments } = lex(text, lang);
	const lines = text.split("\n");
	const codeLines = code.split("\n");
	const commentLines = comments.split("\n");
	const hits = [];
	for (const category of CATEGORIES) {
		const patterns = category[lang];
		const seen = new Set();
		for (const [source, list] of [[codeLines, patterns.code], [commentLines, patterns.comments]]) {
			if (!list) continue;
			source.forEach((line, i) => {
				if (list.some((re) => re.test(line))) seen.add(i + 1);
			});
		}
		for (const re of patterns.block ?? []) {
			for (const match of code.matchAll(re)) seen.add(code.slice(0, match.index).split("\n").length);
		}
		for (const line of [...seen].sort((a, b) => a - b)) {
			hits.push({ category: category.id, file, line, text: lines[line - 1].trim().slice(0, 160) });
		}
	}
	return hits;
}

/**
 * @param {string} root a folder, or one file
 * @param {{ includeTests?: boolean }} [options] tests hold most disabled-test hits, so they are in by default
 */
export function scan(root, { includeTests = true } = {}) {
	const files = listSourceFiles(root, { includeTests });
	const hits = files.flatMap((file) => scanText(file, readSource(root, file)));
	return summarize(hits, files.length);
}

/** @param {{ category: string, file: string, line: number, text: string }[]} hits @param {number} fileCount */
export function summarize(hits, fileCount) {
	const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, hits.filter((h) => h.category === c.id).length]));
	const counted = new Set(CATEGORIES.filter((c) => c.inTotal).map((c) => c.id));
	const byFile = {};
	for (const hit of hits) if (counted.has(hit.category)) byFile[hit.file] = (byFile[hit.file] ?? 0) + 1;
	return {
		kind: "special-cases",
		files: fileCount,
		total: hits.filter((h) => counted.has(h.category)).length,
		byCategory,
		byFile: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
		hits,
	};
}

/**
 * Compares two scans. `worse` is true when the progress number went up. New hits
 * are matched by category, file and text as a multiset, so moved lines are not
 * new, but a second copy of an old line is.
 * @param {ReturnType<typeof summarize>} before @param {ReturnType<typeof summarize>} after
 */
export function compare(before, after) {
	const counted = new Set(CATEGORIES.filter((c) => c.inTotal).map((c) => c.id));
	const categories = CATEGORIES.map((c) => ({ id: c.id, inTotal: c.inTotal, before: before.byCategory[c.id] ?? 0, after: after.byCategory[c.id] ?? 0 }));
	const key = (h) => `${h.category}\n${h.file}\n${h.text}`;
	const remaining = new Map();
	for (const h of before.hits) remaining.set(key(h), (remaining.get(key(h)) ?? 0) + 1);
	const added = [];
	for (const h of after.hits) {
		const left = remaining.get(key(h)) ?? 0;
		if (left > 0) remaining.set(key(h), left - 1);
		else if (counted.has(h.category)) added.push(h);
	}
	return { before: before.total, after: after.total, worse: after.total > before.total, categories, added };
}
