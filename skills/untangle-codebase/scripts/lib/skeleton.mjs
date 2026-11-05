// Prints a codebase with the function bodies left out, so that its whole shape
// fits in one context. It reads indentation, not syntax, so it works the same for
// TypeScript, JavaScript and Python, and it is approximate on odd formatting.
import { listSourceFiles, readSource } from "./files.mjs";

const DECLARATION = [
	/^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace)\b/,
	/^\s*(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:[^=]+)?=>/,
	/^\s*(public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|override\s+)*#?[\w$]+\s*(<[^>]*>)?\([^)]*\)\s*(:[^{]+)?\{\s*$/,
	/^\s*(async\s+)?def\s+\w+|^\s*class\s+\w+/,
	/^\s*@\w/,
];
const CONTROL_WORD = /^\s*(if|for|while|switch|catch|return|else|try|do|with)\b/;
const COMMENT_ONLY = /^\s*(\/\/|#|\*|\/\*|\*\/)/;

/** Width of one indent level: a tab, or the smallest space indent in the file. */
function indentUnit(lines) {
	let unit = Infinity;
	for (const line of lines) {
		const spaces = /^( +)\S/.exec(line);
		if (spaces) unit = Math.min(unit, spaces[1].length);
	}
	return Number.isFinite(unit) ? unit : 4;
}

/** @param {string} line @param {number} unit */
function depthOf(line, unit) {
	const lead = /^[\t ]*/.exec(line)[0];
	const tabs = (lead.match(/\t/g) ?? []).length;
	return tabs + Math.floor((lead.length - tabs) / unit);
}

/**
 * The kept lines of one file, each with its line number.
 * @param {string} text @param {{ depth?: number }} [options] keep every line at or above this depth
 * @returns {string[]}
 */
export function skeletonOf(text, { depth = 0 } = {}) {
	const lines = text.split("\n");
	const unit = indentUnit(lines);
	const width = String(lines.length).length;
	const out = [];
	let gap = false;
	lines.forEach((line, i) => {
		if (!line.trim() || COMMENT_ONLY.test(line)) return;
		const d = depthOf(line, unit);
		const keep = d <= depth || (d <= depth + 2 && !CONTROL_WORD.test(line) && DECLARATION.some((re) => re.test(line)));
		if (keep) {
			if (gap) out.push(`${" ".repeat(width)}| ${" ".repeat((d + 1) * 2)}…`);
			out.push(`${String(i + 1).padStart(width)}| ${line.trimEnd()}`);
			gap = false;
		} else {
			gap = true;
		}
	});
	return out;
}

/** @param {string} root @param {{ depth?: number, includeTests?: boolean }} [options] */
export function skeleton(root, { depth = 0, includeTests = false } = {}) {
	return listSourceFiles(root, { includeTests }).map((file) => {
		const text = readSource(root, file);
		return { file, lines: text.split("\n").length, skeleton: skeletonOf(text, { depth }) };
	});
}
