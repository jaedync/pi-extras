// Read what `quint verify --backend=tlc --verbosity=3` prints: the result, the
// state counts, and the counterexample as a list of steps.

/** @typedef {{ action: string, vars: Record<string, string> }} TraceStep */
/** @typedef {{ result: "pass" | "violation" | "error", distinct: number | null, generated: number | null, depth: number | null, trace: TraceStep[], message: string | null }} TlcReport */

const STATE = /^State (\d+): <(.+?)(?: line \d+, col \d+ to line \d+, col \d+ of module \w+)?>\s*$/;
const VAR = /^\/\\ (\w+) = (.*)$/;

/**
 * @param {string} text
 * @param {number | null} exitCode
 * @returns {TlcReport}
 */
export function parseTlcOutput(text, exitCode) {
	const lines = text.split(/\r?\n/);
	/** @type {TraceStep[]} */
	const trace = [];
	let current = null;
	for (const line of lines) {
		const state = STATE.exec(line);
		if (state) {
			current = { action: state[2] === "Initial predicate" ? "init" : state[2], vars: {} };
			trace.push(current);
			continue;
		}
		const variable = VAR.exec(line);
		if (variable && current) {
			current.vars[variable[1]] = variable[2];
			continue;
		}
		// A value that wraps continues on the next line.
		if (current && line.startsWith("   ") && Object.keys(current.vars).length > 0) {
			const last = Object.keys(current.vars).at(-1);
			current.vars[last] += ` ${line.trim()}`;
			continue;
		}
		if (line.trim() === "") current = null;
	}
	const counts = /(\d+) states generated, (\d+) distinct states found/.exec(text);
	const depth = /The depth of the complete state graph search is (\d+)/.exec(text);
	const passed = text.includes("Model checking completed. No error has been found.");
	const violated = /Error: Invariant \S+ is violated|Error: Temporal properties were violated|\[violation\]/.test(text);
	const result = passed && exitCode === 0 ? "pass" : violated ? "violation" : "error";
	const errorLine = lines.find((l) => /\berror\b:/i.test(l) && !/Invariant \S+ is violated|The behavior up to this point/.test(l));
	return {
		result,
		generated: counts ? Number(counts[1]) : null,
		distinct: counts ? Number(counts[2]) : null,
		depth: depth ? Number(depth[1]) : null,
		trace: result === "violation" ? trace : [],
		message: result === "error" ? (errorLine?.trim() ?? `exit code ${exitCode}`) : null,
	};
}

/**
 * The trace as numbered steps with the variables that changed.
 * @param {TraceStep[]} trace
 * @returns {string}
 */
export function formatTrace(trace) {
	const out = [];
	let previous = {};
	for (const [index, step] of trace.entries()) {
		const changed = Object.entries(step.vars).filter(([name, value]) => previous[name] !== value);
		out.push(`${index}. ${step.action}`);
		for (const [name, value] of changed) out.push(`     ${name} = ${value}`);
		previous = step.vars;
	}
	return out.join("\n");
}
