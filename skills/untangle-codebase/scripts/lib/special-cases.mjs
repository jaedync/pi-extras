// Counts the code shapes that usually mark a special case: a requirement that the
// design does not cover. The count is a trend number for one codebase (before and
// after), not a score to compare across projects. Patterns read single lines, so a
// few hits are false; the same rules run before and after, so the change is fair.
import { languageOf, listSourceFiles, readSource } from "./files.mjs";

/**
 * inTotal: false marks a weak signal. A literal comparison is often a good
 * discriminated-union branch, so it is shown but kept out of the progress number.
 * @type {{ id: string, title: string, inTotal: boolean, js?: RegExp[], py?: RegExp[], multiline?: { js?: RegExp[], py?: RegExp[] } }[]}
 */
export const CATEGORIES = [
	{
		id: "swallowed-error",
		title: "Swallowed exception",
		inTotal: true,
		js: [/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/, /\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)/],
		py: [/^\s*except\b[^:]*:\s*(pass|\.\.\.)\s*(#.*)?$/],
		multiline: {
			js: [/\bcatch\s*(\([^)]*\))?\s*\{\s*(\/\/[^\n]*\s*)*\}/g],
			py: [/^[ \t]*except\b[^:\n]*:[ \t]*(#[^\n]*)?\n[ \t]*(pass|\.\.\.)[ \t]*$/gm],
		},
	},
	{
		id: "sleep-or-retry",
		title: "Retry, sleep or fixed wait",
		inTotal: true,
		js: [/\bsetTimeout\([^;]*,\s*\d+\s*\)/, /\b(sleep|delay|wait)\(\s*\d+/, /\bretr(y|ies|ying)\b/i],
		py: [/\btime\.sleep\(/, /\basyncio\.sleep\(\s*\d/, /\bretr(y|ies|ying)\b/i],
	},
	{
		id: "disabled-test",
		title: "Disabled or skipped test",
		inTotal: true,
		js: [/\b(it|test|describe)\.(skip|todo)\b/, /\bx(it|describe|test)\(/, /\bskip:\s*(true|["'`])/],
		py: [/@(pytest\.mark\.skip|pytest\.mark\.xfail|unittest\.skip)/],
	},
	{
		id: "suppression",
		title: "Type or lint check turned off",
		inTotal: true,
		js: [/@ts-(ignore|expect-error|nocheck)\b/, /eslint-disable/, /[\w)\]]\s+as\s+any\b(?!\s+\w)/, /:\s*any\b(?=\s*[;,)=\]>|{]|\s*$)/],
		py: [/#\s*type:\s*ignore/, /#\s*noqa/, /#\s*pylint:\s*disable/],
	},
	{
		id: "workaround-note",
		title: "TODO, FIXME, HACK or workaround note",
		inTotal: true,
		js: [/\/\/.*\b(TODO|FIXME|HACK|XXX)\b|\/\/.*\bworkaround\b/i],
		py: [/#.*\b(TODO|FIXME|HACK|XXX)\b|#.*\bworkaround\b/i],
	},
	{
		id: "literal-branch",
		title: "Branch on one literal value (weak signal)",
		inTotal: false,
		js: [/\bif\s*\(.*[!=]==?\s*["'`][^"'`]+["'`]/],
		py: [/^\s*(el)?if\b.*[!=]=\s*["'][^"']+["']/],
	},
];

/** Hits for one file: one entry per line and category, so a line counts once per category. */
export function scanText(file, text) {
	const lang = languageOf(file);
	if (!lang) return [];
	const lines = text.split("\n");
	const hits = [];
	for (const category of CATEGORIES) {
		const seen = new Set();
		lines.forEach((line, i) => {
			if ((category[lang] ?? []).some((re) => re.test(line))) seen.add(i + 1);
		});
		// Multi-line shapes such as `catch {\n}` are found on the whole text.
		for (const re of category.multiline?.[lang] ?? []) {
			for (const match of text.matchAll(re)) seen.add(text.slice(0, match.index).split("\n").length);
		}
		for (const line of [...seen].sort((a, b) => a - b)) {
			hits.push({ category: category.id, file, line, text: lines[line - 1].trim().slice(0, 160) });
		}
	}
	return hits;
}

/**
 * @param {string} root
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
		files: fileCount,
		total: hits.filter((h) => counted.has(h.category)).length,
		byCategory,
		byFile: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
		hits,
	};
}

/**
 * Compares two scans. `worse` is true when the progress number went up.
 * @param {ReturnType<typeof summarize>} before @param {ReturnType<typeof summarize>} after
 */
export function compare(before, after) {
	const categories = CATEGORIES.map((c) => ({
		id: c.id,
		inTotal: c.inTotal,
		before: before.byCategory[c.id] ?? 0,
		after: after.byCategory[c.id] ?? 0,
	}));
	const key = (h) => `${h.category}\n${h.file}\n${h.text}`;
	const old = new Set(before.hits.map(key));
	const added = after.hits.filter((h) => !old.has(key(h)) && CATEGORIES.find((c) => c.id === h.category).inTotal);
	return { before: before.total, after: after.total, worse: after.total > before.total, categories, added };
}
