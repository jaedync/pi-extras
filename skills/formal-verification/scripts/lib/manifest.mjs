// The verification record (fv.json): which spec, which checks, what each check
// expects, and which code the spec describes. Pure functions, so tests can run
// them without Java or Quint.

/** @typedef {{ from: string, to: string }} Replacement */
/** @typedef {{ name: string, base?: string, why?: string, mirrors?: string, replace?: Replacement[], invariants?: string[], expect: "pass" | { violates: string } }} Check */
/** @typedef {{ path: string, what?: string }} Cover */
/** @typedef {{ spec: string, quint?: string, invariants: string[], checks: Check[], covers: Cover[], syncCommit: string, traces?: { check?: string, out: string, n?: number, steps?: number, seed?: string } }} Manifest */

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Check the shape of a parsed fv.json. Returns a list of problems, empty when it is valid.
 * @param {unknown} value
 * @returns {string[]}
 */
export function manifestProblems(value) {
	const problems = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return ["fv.json must hold an object"];
	const m = /** @type {Record<string, unknown>} */ (value);
	if (typeof m.spec !== "string" || !m.spec.endsWith(".qnt")) problems.push("spec must name a .qnt file next to fv.json");
	if (typeof m.syncCommit !== "string" || !/^[0-9a-f]{7,40}$/.test(m.syncCommit)) problems.push("syncCommit must be a git commit hash");
	if (!Array.isArray(m.invariants) || m.invariants.length === 0 || !m.invariants.every((i) => typeof i === "string" && IDENT.test(i))) {
		problems.push("invariants must be a non-empty list of Quint definition names");
	}
	if (!Array.isArray(m.covers) || m.covers.length === 0 || !m.covers.every((c) => typeof c?.path === "string" && c.path.length > 0)) {
		problems.push("covers must list at least one { path } of covered code");
	}
	if (!Array.isArray(m.checks) || m.checks.length === 0) {
		problems.push("checks must list at least one check");
		return problems;
	}
	const names = new Set();
	for (const [index, check] of m.checks.entries()) {
		const at = `checks[${index}]`;
		if (typeof check?.name !== "string" || !NAME.test(check.name)) { problems.push(`${at}.name must be lowercase words joined by -`); continue; }
		if (names.has(check.name)) problems.push(`${at}: the name ${check.name} is used twice`);
		names.add(check.name);
		if (check.base !== undefined && !names.has(check.base)) problems.push(`${at}.base must name an earlier check`);
		const expect = check.expect;
		const expectOk = expect === "pass" || (typeof expect?.violates === "string" && IDENT.test(expect.violates));
		if (!expectOk) problems.push(`${at}.expect must be "pass" or { "violates": "<invariant>" }`);
		if (check.replace !== undefined) {
			if (!Array.isArray(check.replace) || !check.replace.every((r) => typeof r?.from === "string" && r.from.length > 0 && typeof r?.to === "string")) {
				problems.push(`${at}.replace must be a list of { from, to } strings`);
			}
		}
		if (check.name.startsWith("mutant-") && typeof check.mirrors !== "string") {
			problems.push(`${at}: a mutant must say which code change it mirrors (mirrors)`);
		}
	}
	return problems;
}

/**
 * The full list of replacements for a check: those of its base chain first.
 * @param {Manifest} manifest
 * @param {string} name
 * @returns {Replacement[]}
 */
export function replacementsFor(manifest, name) {
	const byName = new Map(manifest.checks.map((c) => [c.name, c]));
	const chain = [];
	const seen = new Set();
	for (let current = byName.get(name); current; current = current.base ? byName.get(current.base) : undefined) {
		if (seen.has(current.name)) throw new Error(`check ${name} has a base loop`);
		seen.add(current.name);
		chain.unshift(current);
	}
	if (chain.length === 0) throw new Error(`no check named ${name}`);
	return chain.flatMap((c) => c.replace ?? []);
}

/**
 * Apply text replacements. Each `from` must occur exactly once, so that a spec
 * edit cannot turn a mutant silently into the unchanged spec.
 * @param {string} source
 * @param {Replacement[]} replacements
 * @returns {string}
 */
export function applyReplacements(source, replacements) {
	let text = source;
	for (const { from, to } of replacements) {
		const first = text.indexOf(from);
		if (first === -1) throw new Error(`replacement text not found in the spec: ${JSON.stringify(from.slice(0, 80))}`);
		if (text.indexOf(from, first + 1) !== -1) throw new Error(`replacement text occurs more than once: ${JSON.stringify(from.slice(0, 80))}`);
		text = text.slice(0, first) + to + text.slice(first + from.length);
	}
	return text;
}

/**
 * The invariants that one run checks: the expected violation alone, or all of them.
 * @param {Manifest} manifest
 * @param {Check} check
 * @returns {string[]}
 */
export function invariantsFor(manifest, check) {
	if (check.expect !== "pass") return [check.expect.violates];
	return check.invariants ?? manifest.invariants;
}
