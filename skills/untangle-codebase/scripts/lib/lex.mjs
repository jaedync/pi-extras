// A small lexer that splits source into code and comments. Both outputs keep the
// length and the line breaks of the input, so offsets and line numbers still
// match. In `code`, comments become spaces and the inside of each string, template
// and regex literal becomes spaces (the quote marks stay). In `comments`, only the
// comment text stays. It is not a parser: it only needs to know what is a string.

// After one of these characters, a `/` starts a regex literal, not a division.
const REGEX_BEFORE = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_AFTER_WORD = /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** @param {string[]} code @param {string[]} comments @param {number} from @param {number} to */
function moveToComments(code, comments, from, to) {
	for (let i = from; i < to; i++) {
		if (code[i] === "\n") continue;
		comments[i] = code[i];
		code[i] = " ";
	}
}

/** @param {string[]} code @param {number} from @param {number} to */
function blank(code, from, to) {
	for (let i = from; i < to; i++) if (code[i] !== "\n") code[i] = " ";
}

/** End index (exclusive) of a quoted string that starts at `start`. Stops at a line break. */
function endOfQuoted(text, start) {
	const quote = text[start];
	let i = start + 1;
	while (i < text.length && text[i] !== quote && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
	return Math.min(i + 1, text.length);
}

function endOfRegex(text, start) {
	let i = start + 1;
	let inClass = false;
	while (i < text.length && text[i] !== "\n") {
		if (text[i] === "\\") i++;
		else if (text[i] === "[") inClass = true;
		else if (text[i] === "]") inClass = false;
		else if (text[i] === "/" && !inClass) return i + 1;
		i++;
	}
	return i;
}

/** True when the `)` at index j closes the condition of `if (...)`, `while (...)` or `for (...)`. */
function closesCondition(text, j) {
	let depth = 0;
	for (let k = j; k >= 0; k--) {
		if (text[k] === ")") depth++;
		else if (text[k] === "(" && --depth === 0) return /\b(if|while|for|with)\s*$/.test(text.slice(Math.max(0, k - 8), k));
	}
	return false;
}

function startsRegex(text, i) {
	let j = i - 1;
	while (j >= 0 && (text[j] === " " || text[j] === "\t")) j--;
	if (j < 0 || text[j] === "\n") return true;
	if (text[j] === ")") return closesCondition(text, j);
	return REGEX_BEFORE.has(text[j]) || REGEX_AFTER_WORD.test(text.slice(Math.max(0, j - 10), j + 1));
}

/** @param {string} text */
function lexJs(text) {
	const code = [...text];
	const comments = Array.from(text, (c) => (c === "\n" ? "\n" : " "));
	// Each entry is the brace depth at which a `${` of a template opened.
	const templates = [];
	let depth = 0;
	let i = 0;
	const template = (from) => {
		// Reads template text from `from` to its closing backtick or the next `${`.
		let j = from;
		while (j < text.length && text[j] !== "`" && !(text[j] === "$" && text[j + 1] === "{")) j += text[j] === "\\" ? 2 : 1;
		// A backtick with no end is not a template (JSX text, a stray mark): read on as code.
		if (j >= text.length) return from;
		blank(code, from, j);
		if (text[j] === "$") {
			templates.push(depth);
			depth++;
			return j + 2;
		}
		return j + 1;
	};
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === "/" && next === "/") {
			const end = text.indexOf("\n", i);
			const stop = end === -1 ? text.length : end;
			moveToComments(code, comments, i, stop);
			i = stop;
		} else if (c === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end === -1) {
				i += 2; // a `/*` with no end is not a comment (JSX text): read on as code
				continue;
			}
			moveToComments(code, comments, i, end + 2);
			i = end + 2;
		} else if (c === '"' || c === "'") {
			const stop = endOfQuoted(text, i);
			blank(code, i + 1, stop - 1);
			i = stop;
		} else if (c === "`") {
			i = template(i + 1);
		} else if (c === "/" && startsRegex(text, i)) {
			const stop = endOfRegex(text, i);
			blank(code, i + 1, stop - 1);
			i = stop;
		} else if (c === "{") {
			depth++;
			i++;
		} else if (c === "}") {
			depth--;
			i++;
			if (templates.length && templates[templates.length - 1] === depth) {
				templates.pop();
				i = template(i);
			}
		} else {
			i++;
		}
	}
	return { code: code.join(""), comments: comments.join("") };
}

const PY_STRING_START = /^[rRbBuUfF]{0,2}("""|'''|"|')/;

/** @param {string} text */
function lexPy(text) {
	const code = [...text];
	const comments = Array.from(text, (c) => (c === "\n" ? "\n" : " "));
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "#") {
			const end = text.indexOf("\n", i);
			const stop = end === -1 ? text.length : end;
			moveToComments(code, comments, i, stop);
			i = stop;
			continue;
		}
		const prev = text[i - 1] ?? " ";
		const match = /[\w]/.test(prev) ? null : PY_STRING_START.exec(text.slice(i, i + 5));
		if (!match) {
			i++;
			continue;
		}
		const quote = match[1];
		const open = i + match[0].length;
		let j = open;
		if (quote.length === 3) {
			const end = text.indexOf(quote, open);
			j = end === -1 ? text.length : end;
		} else {
			while (j < text.length && text[j] !== quote && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
		}
		blank(code, open, Math.min(j, text.length));
		i = Math.min(j + quote.length, text.length);
	}
	return { code: code.join(""), comments: comments.join("") };
}

/**
 * @param {string} text @param {"js" | "py" | null} lang
 * @returns {{ code: string, comments: string }}
 */
export function lex(text, lang) {
	if (lang === "js") return lexJs(text);
	if (lang === "py") return lexPy(text);
	return { code: text, comments: text.replace(/[^\n]/g, " ") };
}
