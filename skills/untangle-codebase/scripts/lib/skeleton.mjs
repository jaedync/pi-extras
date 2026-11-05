// Prints a codebase with the function bodies left out, so that its whole shape
// fits in one context. It reads indentation, not syntax, so it works the same for
// TypeScript, JavaScript and Python, and it is approximate on odd formatting.
import { languageOf, listSourceFiles, readSource } from "./files.mjs";
import { lex } from "./lex.mjs";

const DECLARATION = [
	/^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace)\b/,
	// `const f = (a) => ...`, `const f = async x => ...`, or a parameter list that goes on.
	/^\s*(export\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)\s*(:[^=]+)?=>|\([^)]*$|[\w$]+\s*=>)/,
	// A method: `name(args): T {`, `constructor(x) {}`, or `name(` with parameters on the next lines.
	/^\s*(public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|override\s+)*(constructor|#?[\w$]+)\s*(<[^>]*>)?\((.*\)\s*(:[^{]+)?\{\s*\}?|[^)]*)\s*$/,
	/^\s*(async\s+)?def\s+\w+|^\s*class\s+\w+/,
	/^\s*@\w/,
];
// Declarations whose members are part of the shape: keep their whole body.
const TYPE_BODY = /^\s*(export\s+)?(declare\s+)?(interface|enum|type)\b/;
const CONTROL_WORD = /^\s*(if|for|while|switch|catch|return|else|try|do|with|await|throw|yield|new)\b/;

/** Width of one indent level: a tab, or the smallest space indent of a code line. */
function indentUnit(codeLines) {
	let unit = Infinity;
	for (const line of codeLines) {
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

/** Open brackets minus closed ones on a lexed code line. */
function bracketBalance(line) {
	let n = 0;
	for (const c of line) {
		if (c === "(" || c === "[") n++;
		else if (c === ")" || c === "]") n--;
	}
	return n;
}

/**
 * The kept lines of one file, each with its line number.
 * @param {string} text
 * @param {{ depth?: number, lang?: "js" | "py" }} [options] depth: keep every line at or above this depth
 * @returns {string[]}
 */
export function skeletonOf(text, { depth = 0, lang = "js" } = {}) {
	const lines = text.split("\n");
	const codeLines = lex(text, lang).code.split("\n");
	const unit = indentUnit(codeLines);
	const width = String(lines.length).length;
	const out = [];
	let gap = false;
	let open = 0; // brackets still open from a kept signature
	let typeBodyDepth = -1; // keep lines deeper than this while inside a type body
	codeLines.forEach((code, i) => {
		if (!code.trim()) return; // blank, or only a comment
		const d = depthOf(code, unit);
		if (typeBodyDepth >= 0 && d <= typeBodyDepth && !/^\s*[|&]/.test(code)) typeBodyDepth = -1;
		const declaration = d <= depth + 2 && !CONTROL_WORD.test(code) && DECLARATION.some((re) => re.test(code));
		const keep = open > 0 || typeBodyDepth >= 0 || d <= depth || declaration;
		if (!keep) {
			gap = true;
			return;
		}
		if (gap) out.push(`${" ".repeat(width)}| …`);
		out.push(`${String(i + 1).padStart(width)}| ${lines[i].trimEnd()}`);
		gap = false;
		open = Math.max(0, open + bracketBalance(code));
		if (TYPE_BODY.test(code) && typeBodyDepth < 0 && !/[;}]\s*$/.test(code)) typeBodyDepth = d;
	});
	return out;
}

/**
 * @param {string} root
 * @param {{ depth?: number, includeTests?: boolean, only?: string }} [options] only: one file under root
 */
export function skeleton(root, { depth = 0, includeTests = false, only } = {}) {
	const files = only ? [only] : listSourceFiles(root, { includeTests });
	return files.map((file) => {
		const text = readSource(root, file);
		return { file, lines: text.split("\n").length, skeleton: skeletonOf(text, { depth, lang: languageOf(file) ?? "js" }) };
	});
}
