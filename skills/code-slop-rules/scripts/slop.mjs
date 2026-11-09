#!/usr/bin/env node
/**
 * code-slop-rules: measure slop patterns, adopt the ones with real sites as ast-grep rules, and ratchet the counts.
 *
 *   slop setup [--check]                 install the pinned ast-grep into ~/.cache/pi-code-slop-rules
 *   slop measure [paths...]              run the catalog, mine fix commits, check linter overlap; print the table
 *   slop adopt <rule-id...>              copy catalog rules and their tests into the repository
 *   slop ratchet                         run the rule tests, count sites, fail when a count is above the baseline
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findAstGrep, scan, setup, testRules } from "./lib/ast-grep.mjs";
import { measureReport } from "./lib/measure.mjs";
import { changedRules, compareCounts, countFindings, nextBaseline, worstFiles } from "./lib/counts.mjs";
import { CONFIG_KEY, ruleSetHashes } from "./lib/rule-set.mjs";

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(SKILL, "catalog");
const DEFAULT_DIR = "lint/slop";
export const TEST_GLOBS = ["tests/**", "test/**", "spec/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"];

const HELP = {
	setup: "slop setup [--check]\n  Installs @ast-grep/cli into ~/.cache/pi-code-slop-rules. --check only reports which ast-grep the commands use.",
	measure: `slop measure [paths...] [--history n] [--samples n] [--json file]
  Runs every catalog rule over the paths (default: the repository, .gitignore respected), mines the last n fix
  commits (default 300) for sites they removed or added, and reads the linters' rule state. Prints a markdown table
  with a verdict for each rule: adopt, sample (low precision), skip (a linter enforces it) or skip (no sites).`,
	adopt: `slop adopt <rule-id...> [--dir ${DEFAULT_DIR}] [--exclude-tests id,id] [--tsx]
  Copies each catalog rule into <dir>/rules and its test into <dir>/rule-tests, and writes sgconfig.yml at the
  repository root when it is missing. --exclude-tests adds ignores for test files to the named rules. --tsx also
  writes a tsx copy (<id>-tsx) of each TypeScript rule.`,
	ratchet: `slop ratchet [--config sgconfig.yml] [--dir ${DEFAULT_DIR}] [--update] [--allow-increase] [--no-test] [--json]
  Runs the rule tests, then counts the sites of every rule. Exit 1 when a rule has more sites than
  <dir>/baseline.json records, has no recorded count, or was removed or changed (the baseline keeps a hash of each
  rule and of sgconfig.yml). --update writes the counts; it refuses a higher count, a removed rule and a changed
  rule unless --allow-increase is given too.`,
};

/** @param {string} message @returns {never} */
function fail(message) {
	console.error(message);
	process.exit(2);
}

/** @param {string} root */
function tool(root) {
	const { tool: found, error } = findAstGrep(root);
	if (!found) return fail(error);
	return found;
}

/** @param {string} start */
function repoRoot(start) {
	for (let dir = resolve(start); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return resolve(start);
	}
}

/** Tracked files that match, or none outside a git repository. @param {string} root @param {RegExp} pattern */
function trackedFiles(root, pattern) {
	const result = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return result.status === 0 ? result.stdout.split("\n").filter((file) => pattern.test(file)) : [];
}

/** The catalog's TypeScript rules as tsx copies with `-tsx` ids, for repositories with .tsx or .jsx files. */
function tsxCopies() {
	const dir = join(CATALOG, "typescript");
	return readdirSync(dir).filter((file) => file.endsWith(".yml")).map((file) => ({
		file: file.replace(/\.yml$/, "-tsx.yml"),
		text: readFileSync(join(dir, file), "utf8").replace(/^id: (\S+)$/m, "id: $1-tsx").replace(/^language: typescript$/m, "language: tsx"),
	}));
}

/** @param {string[]} argv */
async function measure(argv) {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
		options: { history: { type: "string", default: "300" }, samples: { type: "string", default: "3" }, json: { type: "string" }, help: { type: "boolean" } } });
	if (values.help) return console.log(HELP.measure);
	const root = repoRoot(process.cwd());
	const ast = tool(root);
	const work = mkdtempSync(join(tmpdir(), "code-slop-measure-"));
	try {
		const hasTsx = trackedFiles(root, /\.(tsx|jsx)$/).length > 0;
		const ruleDirs = [join(CATALOG, "typescript"), join(CATALOG, "python")];
		if (hasTsx) {
			const tsx = join(work, "tsx");
			mkdirSync(tsx);
			for (const { file, text } of tsxCopies()) writeFileSync(join(tsx, file), text);
			ruleDirs.push(tsx);
		}
		const config = join(work, "sgconfig.yml");
		writeFileSync(config, [
			`ruleDirs:\n${ruleDirs.map((dir) => `  - ${JSON.stringify(dir)}`).join("\n")}`,
			"languageGlobs:\n  typescript: ['*.ts', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs']",
			...(hasTsx ? ["  tsx: ['*.tsx', '*.jsx']"] : []), ""].join("\n"));
		const samples = {
			js: trackedFiles(root, /\.(ts|mts|js|mjs)$/)[0],
			py: trackedFiles(root, /\.py$/)[0],
		};
		const report = measureReport(ast, { root, config, paths: positionals.length ? positionals : ["."], historyLimit: Number(values.history),
			sampleCount: Number(values.samples), samples, testGlobs: TEST_GLOBS });
		if (values.json) writeFileSync(values.json, `${JSON.stringify(report.data, null, 2)}\n`);
		console.log(report.markdown);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** @param {string[]} argv */
function adopt(argv) {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
		options: { dir: { type: "string", default: DEFAULT_DIR }, "exclude-tests": { type: "string", default: "" }, tsx: { type: "boolean" }, help: { type: "boolean" } } });
	if (values.help || !positionals.length) return console.log(HELP.adopt);
	const root = repoRoot(process.cwd());
	const rulesDir = join(root, values.dir, "rules");
	const testsDir = join(root, values.dir, "rule-tests");
	mkdirSync(rulesDir, { recursive: true });
	mkdirSync(testsDir, { recursive: true });
	const excluded = new Set(values["exclude-tests"].split(",").map((id) => id.trim()).filter(Boolean));
	for (const id of positionals) {
		const lang = ["typescript", "python"].find((l) => existsSync(join(CATALOG, l, `${id}.yml`)));
		if (!lang) fail(`No catalog rule ${id}. The catalog is in ${relative(process.cwd(), CATALOG)}.`);
		let text = readFileSync(join(CATALOG, /** @type {string} */ (lang), `${id}.yml`), "utf8");
		if (excluded.has(id)) text = text.replace(/^(severity: .*)$/m, `$1\nignores:\n${TEST_GLOBS.map((glob) => `  - ${JSON.stringify(glob)}`).join("\n")}`);
		writeFileSync(join(rulesDir, `${id}.yml`), text);
		const testText = readFileSync(join(CATALOG, "tests", `${id}-test.yml`), "utf8");
		writeFileSync(join(testsDir, `${id}-test.yml`), testText);
		if (values.tsx && lang === "typescript") {
			writeFileSync(join(rulesDir, `${id}-tsx.yml`), text.replace(/^id: (\S+)$/m, "id: $1-tsx").replace(/^language: typescript$/m, "language: tsx"));
			writeFileSync(join(testsDir, `${id}-tsx-test.yml`), testText.replace(/^id: (\S+)$/m, "id: $1-tsx"));
		}
		console.log(`adopted ${id}${excluded.has(id) ? " (test files ignored)" : ""}`);
	}
	const config = join(root, "sgconfig.yml");
	const wanted = `ruleDirs:\n  - ${values.dir}/rules\ntestConfigs:\n  - testDir: ${values.dir}/rule-tests\n` +
		"# One TypeScript rule set covers JavaScript too: the TypeScript grammar parses plain JS.\n" +
		"languageGlobs:\n  typescript: ['*.ts', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs']\n";
	if (!existsSync(config)) { writeFileSync(config, wanted); console.log("wrote sgconfig.yml"); }
	else if (!readFileSync(config, "utf8").includes(`${values.dir}/rules`)) console.log(`sgconfig.yml exists: add this to it\n${wanted}`);
	console.log(`Next: node ${relative(root, join(SKILL, "scripts", "slop.mjs"))} ratchet --update`);
}

/**
 * @param {ReturnType<typeof compareCounts>} result
 * @param {import("./lib/counts.mjs").Counts} baseline
 * @param {import("./lib/counts.mjs").Counts} current
 * @param {{ ruleId: string, file: string, range: { start: { line: number } }, message: string }[]} findings
 */
function formatRatchet(result, baseline, current, findings) {
	const lines = ["| Rule | Baseline | Now |", "| --- | ---: | ---: |"];
	for (const [rule, { count }] of Object.entries(current)) lines.push(`| ${rule} | ${baseline[rule]?.count ?? "none"} | ${count} |`);
	for (const { rule, before, now, files } of result.rose) {
		lines.push("", `FAIL ${rule}: ${before} -> ${now} sites.`);
		for (const { file, before: was, now: is } of files) {
			// The baseline keeps counts, not lines, so all sites of the file are listed; the new one is among them.
			lines.push(`  ${file}: ${was} -> ${is}. The sites in this file now:`);
			for (const f of findings.filter((x) => x.ruleId === rule && x.file === file)) lines.push(`    ${file}:${f.range.start.line + 1} ${f.message}`);
		}
	}
	if (result.unrecorded.length) lines.push("", `FAIL no baseline for: ${result.unrecorded.join(", ")}. Run the ratchet with --update to record the counts.`);
	if (result.removed.length) lines.push("", `FAIL removed since the baseline: ${result.removed.join(", ")}. A rule that is gone (deleted, renamed, severity off) no longer guards its sites.`);
	if (result.changed.length) lines.push("", `FAIL changed since the baseline: ${result.changed.join(", ")}. A changed rule or sgconfig.yml can hide sites.`);
	if (result.rose.length) lines.push("", "Fix the new sites. If a site is right, run the ratchet with --update --allow-increase and give the reason in the commit message.");
	if (result.removed.length || result.changed.length) lines.push("", "If the rule change is right, run the ratchet with --update --allow-increase and say in the commit message that the rules changed.");
	if (result.fell.length) lines.push("", `Fewer sites: ${result.fell.map(({ rule, before, now }) => `${rule} ${before} -> ${now}`).join(", ")}. Run the ratchet with --update to lock the gain.`);
	return lines.join("\n");
}

/** @param {string[]} argv */
function ratchet(argv) {
	const { values } = parseArgs({ args: argv, options: { config: { type: "string" }, dir: { type: "string", default: DEFAULT_DIR },
		update: { type: "boolean" }, "allow-increase": { type: "boolean" }, "no-test": { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" } } });
	if (values.help) return console.log(HELP.ratchet);
	const config = resolve(values.config ?? join(repoRoot(process.cwd()), "sgconfig.yml"));
	if (!existsSync(config)) fail(`No ${config}. Run \`slop adopt <rule-id...>\` first.`);
	const root = dirname(config);
	const ast = tool(root);
	if (!values["no-test"]) {
		const tested = testRules(ast, { config, cwd: root });
		if (!tested.ok) { console.error(tested.output); console.error("Rule tests failed: fix the rule or its test cases first."); process.exit(1); }
		if (!values.json) console.log(`Rule tests: ${tested.passed} passed.`);
	}
	const { ruleIds, findings, scannedFiles } = scan(ast, { config, cwd: root });
	if (scannedFiles === 0) fail(`ast-grep scan gave incomplete output: it read no files under ${root}.`);
	const current = countFindings(findings, ruleIds);
	const ruleSet = ruleSetHashes(config);
	const baselinePath = join(root, values.dir, "baseline.json");
	const saved = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { rules: {} };
	/** @type {import("./lib/counts.mjs").Counts} */
	const baseline = saved.rules ?? {};
	// A baseline from before rule hashes existed cannot show what changed: treat its whole rule set as changed.
	const changed = saved.ruleSet ? changedRules(saved.ruleSet, ruleSet) : Object.keys(baseline).length ? [CONFIG_KEY] : [];
	if (values.update) {
		const next = nextBaseline(baseline, current, { allowIncrease: Boolean(values["allow-increase"]), changed });
		if (!next.ok) {
			const why = [next.rose.length ? `more sites than the baseline for ${next.rose.join(", ")}` : "",
				next.removedOrChanged.length ? `rules removed or changed: ${next.removedOrChanged.join(", ")}` : ""].filter(Boolean).join("; ");
			fail(`Refused: ${why}. Add --allow-increase to accept them.`);
		}
		const doc = { about: "Site counts per ast-grep rule. `slop.mjs ratchet` fails when a count goes up or a rule changes. Lower counts with --update.",
			worstFiles: worstFiles(next.baseline, 10).map(({ file, count }) => `${file}: ${count}`), ruleSet, rules: next.baseline };
		mkdirSync(dirname(baselinePath), { recursive: true });
		writeFileSync(baselinePath, `${JSON.stringify(doc, null, "\t")}\n`);
		console.log(`Wrote ${relative(process.cwd(), baselinePath)}: ${Object.entries(next.baseline).map(([rule, { count }]) => `${rule} ${count}`).join(", ")}`);
		return;
	}
	const result = compareCounts(baseline, current, changed);
	if (values.json) console.log(JSON.stringify({ ...result, current: Object.fromEntries(Object.entries(current).map(([r, c]) => [r, c.count])) }, null, 2));
	else console.log(formatRatchet(result, baseline, current, findings));
	process.exitCode = result.ok ? 0 : 1;
}

/** @param {string[]} argv */
function setupCommand(argv) {
	const { values } = parseArgs({ args: argv, options: { check: { type: "boolean" }, help: { type: "boolean" } } });
	if (values.help) return console.log(HELP.setup);
	const root = repoRoot(process.cwd());
	const before = findAstGrep(root);
	if (before.tool) return console.log(`ast-grep ${before.tool.version} from ${before.tool.source}`);
	if (values.check) return fail(before.error);
	setup(console.log);
	const after = findAstGrep(root);
	if (!after.tool) return fail(after.error);
	console.log(`ast-grep ${after.tool.version} from ${after.tool.source}`);
}

const COMMANDS = { setup: setupCommand, measure, adopt, ratchet };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...rest] = process.argv.slice(2);
	const run = COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)];
	if (!run) {
		console.log(Object.values(HELP).join("\n\n"));
		process.exit(command && command !== "--help" ? 2 : 0);
	}
	try {
		await run(rest);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
