/**
 * Splits a shell command into the steps of its top-level list: the commands
 * joined by `&&`, `||`, `;` and newlines. A pipeline is one step; anything
 * inside quotes, substitutions, subshells, `{ }` groups or `[[ ]]` stays in
 * its step.
 *
 * The splitter is deliberately conservative. Its output decides how a command
 * is rewritten before it runs, so whatever it doesn't fully understand
 * (heredocs, compound commands like `if` and `for`, background `&`, function
 * definitions, and commands whose meaning depends on the shell's own state,
 * like `exit`, `set` or `$LINENO`) returns undefined and the command runs
 * untouched.
 */

export type ChainOp = "&&" | "||" | ";";

export interface ChainStep {
	/** The operator before this step; null for the first. */
	readonly op: ChainOp | null;
	readonly text: string;
	readonly start: number;
	readonly end: number;
	/** A leading `cd <dir>`, shown as a location rather than a step. */
	readonly cd?: true;
}

export interface Chain {
	readonly steps: readonly ChainStep[];
	/** The directory of a leading `cd`. */
	readonly cd?: string;
}

/** Longer scripts are left alone: a step list that long reads worse than the script. */
export const MAX_STEPS = 12;

type Context = "sq" | "ansi" | "dq" | "bt" | "paren" | "brace" | "group" | "test";

// Compound commands would be split at their own `;`, and these change how the rest of the list runs.
const UNSAFE_FIRST_WORDS = new Set([
	"if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select",
	"function", "coproc", "exit", "exec", "return", "trap", "set",
]);
// Values the rewrite would change: the step wrapper runs commands of its own and moves line numbers.
const SHELL_STATE = /\$\{?(?:PIPESTATUS|LINENO|BASH_LINENO|BASH_COMMAND)\b|\$_(?![A-Za-z0-9_])|\$\{_\}/;
const CD = /^cd\s+(?:"([^"$`\\]*)"|'([^']*)'|([^\s"'$`\\;&|()<>]+))$/;
const WORD_BREAK = /[\s;&|()]/;

class Unsplittable extends Error {}

const fail = (): never => {
	throw new Unsplittable();
};

export function splitChain(command: string): Chain | undefined {
	if (SHELL_STATE.test(command)) return undefined;
	try {
		return scan(command);
	} catch (error) {
		if (error instanceof Unsplittable) return undefined;
		throw error;
	}
}

function scan(s: string): Chain | undefined {
	const stack: Context[] = [];
	const steps: ChainStep[] = [];
	let stepStart = 0;
	let pending: ChainOp | null = null;

	const finish = (end: number, next: ChainOp | null) => {
		const raw = s.slice(stepStart, end);
		const lead = raw.length - raw.trimStart().length;
		const body = raw.replace(/(?:\s|\\\n)+$/, "");
		const text = body.slice(lead);
		// A comment runs to the end of its line, so a step that starts with one is only a comment.
		if (text === "" || text.startsWith("#")) {
			// `&&` or `||` with nothing before it is a syntax error; a blank line just continues.
			if (next === "&&" || next === "||") fail();
			return;
		}
		steps.push({ op: steps.length === 0 ? null : pending, text, start: stepStart + lead, end: stepStart + body.length });
		pending = next;
	};

	const wordStart = (i: number) => i === 0 || WORD_BREAK.test(s[i - 1]!);
	const prevSolid = (i: number) => {
		let j = i - 1;
		while (j >= 0 && (s[j] === " " || s[j] === "\t")) j--;
		return j < 0 ? "" : s[j]!;
	};

	let i = 0;
	while (i < s.length) {
		const ch = s[i]!;
		const next = s[i + 1];
		const top = stack.at(-1);

		if (top === "sq") {
			if (ch === "'") stack.pop();
			i++;
			continue;
		}
		if (top === "ansi") {
			if (ch === "\\") i += 2;
			else {
				if (ch === "'") stack.pop();
				i++;
			}
			continue;
		}
		if (top === "bt") {
			if (ch === "\\") i += 2;
			else {
				if (ch === "`") stack.pop();
				i++;
			}
			continue;
		}
		if (top === "dq") {
			if (ch === "\\") i += 2;
			else if (ch === "\"") { stack.pop(); i++; }
			else if (ch === "`") { stack.push("bt"); i++; }
			else if (ch === "$" && next === "(") { stack.push("paren"); i += 2; }
			else if (ch === "$" && next === "{") { stack.push("brace"); i += 2; }
			else i++;
			continue;
		}

		// Code: the top level, or inside a substitution, subshell, group or test.
		if (ch === "\\") { i += 2; continue; }
		if (ch === "'") { stack.push("sq"); i++; continue; }
		if (ch === "\"") { stack.push("dq"); i++; continue; }
		if (ch === "`") { stack.push("bt"); i++; continue; }
		if (ch === "$" && next === "'") { stack.push("ansi"); i += 2; continue; }
		if (ch === "$" && next === "(") { stack.push("paren"); i += 2; continue; }
		if (ch === "$" && next === "{") { stack.push("brace"); i += 2; continue; }
		if (ch === "#" && wordStart(i)) {
			while (i < s.length && s[i] !== "\n") i++;
			continue;
		}
		if (ch === "<" && next === "<") {
			if (s[i + 2] === "<") { i += 3; continue; }
			fail();
		}
		if (ch === "(") {
			if (stack.length === 0 && s.slice(i + 1).trimStart().startsWith(")")) fail();
			stack.push("paren");
			i++;
			continue;
		}
		if (ch === ")") {
			if (top !== "paren") fail();
			stack.pop();
			i++;
			continue;
		}
		if (ch === "{" && wordStart(i) && next !== undefined && /\s/.test(next) && top !== "brace") {
			stack.push("group");
			i++;
			continue;
		}
		if (ch === "}") {
			if (top === "brace") stack.pop();
			else if (top === "group" && wordStart(i) && /[;\n&]/.test(prevSolid(i))) stack.pop();
			i++;
			continue;
		}
		if (ch === "[" && next === "[" && wordStart(i) && /\s/.test(s[i + 2] ?? "")) {
			stack.push("test");
			i += 2;
			continue;
		}
		if (ch === "]" && next === "]" && top === "test" && /\s/.test(s[i - 1] ?? "")) {
			stack.pop();
			i += 2;
			continue;
		}
		if (stack.length > 0) {
			i++;
			continue;
		}

		// Top-level list operators.
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			finish(i, ch === "&" ? "&&" : "||");
			i += 2;
			stepStart = i;
			continue;
		}
		if (ch === ";") {
			if (next === ";" || next === "&") fail();
			finish(i, ";");
			stepStart = ++i;
			continue;
		}
		if (ch === "\n") {
			finish(i, ";");
			stepStart = ++i;
			continue;
		}
		if (ch === "&" && !/[<>|&]/.test(s[i - 1] ?? "") && next !== ">") fail();
		i++;
	}
	if (stack.length > 0) return undefined;
	finish(s.length, null);

	if (steps.length < 2 || steps.length > MAX_STEPS) return undefined;
	for (const step of steps) {
		const word = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([^\s;&|()<>]+)/.exec(step.text)?.[1];
		if (word !== undefined && UNSAFE_FIRST_WORDS.has(word)) return undefined;
	}
	const cd = CD.exec(steps[0]!.text);
	if (!cd) return { steps };
	const dir = cd[1] ?? cd[2] ?? cd[3]!;
	return { steps: [{ ...steps[0]!, cd: true }, ...steps.slice(1)], cd: dir };
}
