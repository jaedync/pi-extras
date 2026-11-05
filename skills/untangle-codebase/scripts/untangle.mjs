#!/usr/bin/env node
// Instruments for the untangle-codebase skill. No dependencies: it runs in any
// checkout with Node 22 or later and git.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "./lib/graph.mjs";
import { skeleton } from "./lib/skeleton.mjs";
import { CATEGORIES, compare, scan, scanText, summarize } from "./lib/special-cases.mjs";

const USAGE = `usage: untangle.mjs <command> [path] [options]

commands:
  graph [folder]        import graph: cycles, stable code that imports volatile code,
                        files that change together with no import (hidden links),
                        files outside the folder that import it
      --by file|dir     group by file (default) or by folder
      --since <date>    git history window (default "12 months ago")
      --min-age <days>  an importer younger than this is not judged stable (default 60)
      --tests           include test files
      --limit <n>       rows to print for each list (default 20)
      --save <file>     write the result as JSON
      --compare <file>  compare with a saved result; exit 1 when more modules are in
                        cycles (history numbers are shown, not judged)
  special-cases [path]  count special cases (swallowed errors, retries and sleeps,
                        disabled tests, turned-off checks, TODO notes, literal branches)
                        in a folder or one file
      --no-tests        leave test files out
      --list <id|all>   print each hit of one category
      --save <file>     write the result as JSON
      --compare <file>  compare with a saved result; exit 1 when the total went up
  skeleton [path]       print a folder or one file with function bodies left out
      --depth <n>       also keep lines this many levels deep (default 0)
      --tests           include test files

  --json                print JSON instead of text
`;

/** @satisfies {import("node:util").ParseArgsOptionsConfig} */
const OPTIONS = /** @type {const} */ ({
	by: { type: "string", default: "file" },
	since: { type: "string", default: "12 months ago" },
	"min-age": { type: "string", default: "60" },
	tests: { type: "boolean", default: false },
	"no-tests": { type: "boolean", default: false },
	limit: { type: "string", default: "20" },
	save: { type: "string" },
	compare: { type: "string" },
	list: { type: "string" },
	depth: { type: "string", default: "0" },
	json: { type: "boolean", default: false },
	help: { type: "boolean", short: "h", default: false },
});

class UsageError extends Error {}

/** @param {string} value @param {string} name */
function integer(value, name) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} needs a whole number, got "${value}"`);
	return n;
}

/** @param {string} file @param {string} kind */
function readSaved(file, kind) {
	let saved;
	try {
		saved = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new UsageError(`cannot read the saved result ${file}: ${error.message}`);
	}
	if (saved?.kind !== kind) throw new UsageError(`${file} is not a saved ${kind} result`);
	return saved;
}

/** A folder, or with allowFile one file: { root, only } where only is the file name. */
function target(path, { allowFile = false } = {}) {
	const full = resolve(path);
	let stat;
	try {
		stat = statSync(full);
	} catch {
		throw new UsageError(`no such folder${allowFile ? " or file" : ""}: ${path}`);
	}
	if (stat.isDirectory()) return { root: full, only: undefined };
	if (allowFile && stat.isFile()) return { root: dirname(full), only: basename(full) };
	throw new UsageError(`${path} is not a folder`);
}

function graphSummary(result) {
	return {
		cycles: result.cycles.length,
		modulesInCycles: result.cycles.reduce((n, c) => n + c.length, 0),
		volatileImports: result.volatileImports?.length ?? null,
		hiddenLinks: result.hiddenLinks?.length ?? null,
		outsideImporters: result.outsideImporters?.length ?? null,
		edges: result.edges,
	};
}

/**
 * Only the number of modules in cycles decides. Splitting one cycle into two is
 * progress, and the history numbers grow with the refactor's own commits.
 */
function compareGraph(before, after) {
	const a = graphSummary(before);
	const b = graphSummary(after);
	const rows = Object.keys(a).map((key) => ({ key, before: a[key], after: b[key] }));
	return { rows, worse: b.modulesInCycles > a.modulesInCycles, baseHead: before.head, head: after.head };
}

function printGraph(result, limit) {
	const s = graphSummary(result);
	const lines = [
		`${result.files} files, ${result.modules} modules (by ${result.by}), ${result.edges} import edges between modules`,
		`git window: since ${result.since}${result.volatileImports === null ? " (no git history: churn and hidden links skipped)" : ""}`,
		"",
		`Cycles: ${s.cycles} (${s.modulesInCycles} modules)`,
		...result.cycles.slice(0, limit).map((c) => `  - ${c.join(" -> ")}`),
	];
	if (result.volatileImports) {
		lines.push("", `Imports of more volatile code: ${s.volatileImports} (changes per month: importer -> imported)`);
		if (result.youngModules) lines.push(`  (${result.youngModules} of ${result.modules} modules have no commit older than ${result.minAgeDays} days: not judged as importers)`);
		lines.push(...result.volatileImports.slice(0, limit).map((v) => `  - ${v.from} (${v.perMonthFrom}) -> ${v.to} (${v.perMonthTo})`));
	}
	if (result.hiddenLinks) {
		lines.push("", `Hidden links (change together, no import either way): ${s.hiddenLinks}`);
		lines.push(...result.hiddenLinks.slice(0, limit).map((p) => `  - ${p.a} + ${p.b}: ${p.shared} shared commits, confidence ${p.confidence}`));
	}
	if (result.outsideImporters) {
		const files = new Set(result.outsideImporters.map((o) => o.to));
		lines.push("", `Imported from outside the folder: ${files.size} files, by ${new Set(result.outsideImporters.map((o) => o.from)).size} files`);
		lines.push(...result.outsideImporters.slice(0, limit).map((o) => `  - ${o.from} -> ${o.to}`));
	}
	const hubs = [...result.modulesTable].sort((x, y) => y.fanIn - x.fanIn).slice(0, Math.min(limit, 10));
	lines.push("", "Most imported (fan-in, fan-out, instability, changes):");
	lines.push(...hubs.map((m) => `  - ${m.name}: ${m.fanIn} in, ${m.fanOut} out, I=${m.instability}, ${m.changes} changes`));
	return lines.join("\n");
}

function printScan(result, list) {
	const lines = [`${result.files} files, ${result.total} special cases (the progress number)`, ""];
	for (const c of CATEGORIES) lines.push(`  ${c.id.padEnd(16)} ${String(result.byCategory[c.id]).padStart(5)}${c.inTotal ? "" : "  (not in the total)"}`);
	lines.push("", "Files with the most:", ...Object.entries(result.byFile).slice(0, 15).map(([f, n]) => `  ${String(n).padStart(4)}  ${f}`));
	if (list) {
		const hits = result.hits.filter((h) => list === "all" || h.category === list);
		lines.push("", ...hits.map((h) => `${h.file}:${h.line}  [${h.category}]  ${h.text}`));
	}
	return lines.join("\n");
}

function printScanCompare(diff) {
	const lines = [`special cases: ${diff.before} -> ${diff.after}${diff.worse ? "  (WORSE)" : ""}`];
	for (const c of diff.categories) lines.push(`  ${c.id.padEnd(16)} ${String(c.before).padStart(5)} -> ${String(c.after).padStart(5)}${c.inTotal ? "" : "  (not in the total)"}`);
	if (diff.added.length) lines.push("", "New hits:", ...diff.added.map((h) => `  ${h.file}:${h.line}  [${h.category}]  ${h.text}`));
	return lines.join("\n");
}

function runGraph(path, values) {
	if (!["file", "dir"].includes(values.by)) throw new UsageError(`--by must be file or dir, got "${values.by}"`);
	const { root } = target(path);
	const minAgeDays = integer(values["min-age"], "min-age");
	const result = { kind: "graph", ...analyze(root, { by: values.by, since: values.since, includeTests: values.tests, minAgeDays }) };
	if (values.save) writeFileSync(values.save, JSON.stringify(result, null, "\t"));
	if (values.compare) {
		const diff = compareGraph(readSaved(values.compare, "graph"), result);
		const text = diff.rows.map((r) => `  ${r.key.padEnd(16)} ${String(r.before).padStart(5)} -> ${String(r.after).padStart(5)}`).join("\n");
		return { output: values.json ? diff : `graph${diff.worse ? "  (WORSE)" : ""}\n${text}`, code: diff.worse ? 1 : 0 };
	}
	return { output: values.json ? result : printGraph(result, integer(values.limit, "limit")), code: 0 };
}

function runScan(path, values) {
	if (values.list && values.list !== "all" && !CATEGORIES.some((c) => c.id === values.list)) {
		throw new UsageError(`--list must be all or one of: ${CATEGORIES.map((c) => c.id).join(", ")}`);
	}
	const { root, only } = target(path, { allowFile: true });
	const result = only ? summarize(scanText(only, readFileSync(resolve(root, only), "utf8")), 1) : scan(root, { includeTests: !values["no-tests"] });
	if (values.save) writeFileSync(values.save, JSON.stringify(result, null, "\t"));
	if (values.compare) {
		const diff = compare(readSaved(values.compare, "special-cases"), result);
		return { output: values.json ? diff : printScanCompare(diff), code: diff.worse ? 1 : 0 };
	}
	return { output: values.json ? result : printScan(result, values.list), code: 0 };
}

function runSkeleton(path, values) {
	const { root, only } = target(path, { allowFile: true });
	const files = skeleton(root, { depth: integer(values.depth, "depth"), includeTests: values.tests, only });
	if (values.json) return { output: files, code: 0 };
	const text = files.map((f) => [`== ${f.file} (${f.lines} lines)`, ...f.skeleton].join("\n")).join("\n\n");
	return { output: text, code: 0 };
}

const COMMANDS = { graph: runGraph, "special-cases": runScan, skeleton: runSkeleton };

/** @param {string[]} argv @returns {{ output: unknown, code: number }} */
export function main(argv) {
	const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
	const [command, path = "."] = positionals;
	if (values.help || !command) return { output: USAGE, code: command || values.help ? 0 : 2 };
	const run = COMMANDS[command];
	if (!run) throw new UsageError(`unknown command "${command}"`);
	return run(path, values);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("untangle.mjs")) {
	try {
		const { output, code } = main(process.argv.slice(2));
		process.stdout.write(typeof output === "string" ? `${output}\n` : `${JSON.stringify(output, null, "\t")}\n`);
		process.exitCode = code;
	} catch (error) {
		const usage = error instanceof UsageError || error?.code?.startsWith?.("ERR_PARSE_ARGS");
		process.stderr.write(`untangle: ${error.message}\n${usage ? "\nrun untangle.mjs --help for the options\n" : ""}`);
		process.exitCode = 2;
	}
}
