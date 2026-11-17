#!/usr/bin/env node
/**
 * speed-up-ci: measure where CI time goes, pack test shards by recorded time, and decide when a PR must run everything.
 *
 *   ci audit [--repo o/r] [--runs 150] [--workflow f] [--event e] [--branch b] [--save f] [--from f] [--success-only] [--json]
 *   ci timings <report...> [--out timings.json] [--root dir] [--prefix path/]
 *   ci shards --timings f [--files list | stdin] (--shard i/n | --count n [--matrix])
 *   ci select [--base ref] [--triggers file] [--github-output]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatReport, summarize } from "./lib/audit.mjs";
import { fetchRuns, REPO } from "./lib/github.mjs";
import { planShards } from "./lib/shards.mjs";
import { mergeTimings, parseJsonReport, parseJunit, prefixTimings } from "./lib/timings.mjs";
import { DEFAULT_TRIGGERS, decide, parseTriggerFile } from "./lib/triggers.mjs";

const HELP = {
	audit: `ci audit [--repo owner/name] [--runs 150] [--workflow file.yml] [--event pull_request] [--branch b]
         [--save runs.json] [--from runs.json] [--target 120,180] [--setup-pattern regex] [--success-only] [--json]
  Pulls the last completed runs with gh (default: the repository of the current directory) and splits every job into
  waiting, setup and running at p50 and p95. Cancelled and skipped runs are left out; --success-only keeps only
  successful runs. --save keeps the pulled runs; --from reads a saved file instead of gh.`,
	timings: `ci timings <report...> [--out timings.json] [--root dir] [--prefix path/]
  Reads JUnit XML or Vitest/Jest JSON reports and writes {"version":1,"files":{path: seconds}}. Absolute paths become
  relative to --root (default: the current directory). --prefix goes before relative names, for a package whose test
  runner names files relative to the package.`,
	shards: `ci shards --timings timings.json [--files list.txt] (--shard i/n | --count n [--matrix | --json])
  Packs test files onto n shards by recorded seconds. --shard prints the files of shard i, one per line; --count
  prints the plan; --matrix prints a GitHub Actions matrix ({"include":[{shard, of, files}]}) without empty shards.
  The file list comes from --files or stdin. Missing timings give an even split by count. Every shard must use the
  same timings file: compute the plan once (--matrix in one job) when the shards could restore different files.`,
	select: `ci select [--base origin/main] [--triggers .ci/full-run.txt] [--github-output]
  Prints "full" when the diff against the merge base touches a full-run trigger (or cannot be computed), else
  "affected". Reasons go to stderr. --github-output also appends mode=<mode> to $GITHUB_OUTPUT.`,
};

/** @param {string} message @returns {never} */
function fail(message) {
	console.error(message);
	process.exit(2);
}

/**
 * @param {string[]} argv @param {Record<string, any>} options @param {boolean} [positionals]
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
function args(argv, options, positionals = false) {
	try {
		return parseArgs({ args: argv, options: { ...options, help: { type: "boolean" } }, allowPositionals: positionals });
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

/** @param {string} value @param {string} flag */
function positive(value, flag) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) fail(`${flag} must be a positive whole number, not ${value}`);
	return number;
}

function currentRepo() {
	const result = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" });
	if (result.status !== 0) fail(`Cannot find the repository with gh; pass --repo owner/name.\n${result.stderr ?? ""}`);
	return result.stdout.trim();
}

/** @param {string[]} argv */
async function audit(argv) {
	const { values } = args(argv, {
		repo: { type: "string" }, runs: { type: "string", default: "150" }, workflow: { type: "string" },
		event: { type: "string" }, branch: { type: "string" }, save: { type: "string" }, from: { type: "string" },
		target: { type: "string", default: "120,180" }, "setup-pattern": { type: "string" }, json: { type: "boolean" },
		"success-only": { type: "boolean" },
	});
	if (values.help) return console.log(HELP.audit);
	if (values.repo !== undefined && !REPO.test(values.repo)) fail(`--repo must be owner/name, not ${JSON.stringify(values.repo)}`);
	const [p50, p95] = values.target.split(",").map((part) => positive(part, "--target"));
	let runs;
	if (values.from) {
		runs = JSON.parse(readFileSync(values.from, "utf8")).runs;
	} else {
		const repo = values.repo ?? currentRepo();
		const limit = positive(values.runs, "--runs");
		console.error(`Pulling ${limit} completed runs of ${repo}...`);
		runs = await fetchRuns({ repo, limit, workflow: values.workflow, event: values.event, branch: values.branch });
		if (values.save) mkdirSync(dirname(resolve(values.save)), { recursive: true });
		if (values.save) writeFileSync(values.save, `${JSON.stringify({ version: 1, repo, pulled: new Date().toISOString(), runs })}\n`);
	}
	let setup;
	try {
		setup = values["setup-pattern"] ? new RegExp(values["setup-pattern"], "i") : undefined;
	} catch (error) {
		fail(`--setup-pattern: ${error instanceof Error ? error.message : error}`);
	}
	const summary = summarize(runs, setup, { successOnly: values["success-only"] });
	console.log(values.json ? JSON.stringify(summary, null, 2) : formatReport(summary, { p50, p95: p95 ?? p50 }, { successOnly: values["success-only"] }));
}

/** @param {string} path @param {string} root */
function readReport(path, root) {
	const text = readFileSync(path, "utf8");
	if (text.trimStart().startsWith("<")) return parseJunit(text, root);
	try {
		return parseJsonReport(JSON.parse(text), root);
	} catch (error) {
		return fail(`${path}: not JUnit XML or a JSON report (${error instanceof Error ? error.message : error})`);
	}
}

/** @param {string[]} argv */
function timings(argv) {
	const { values, positionals } = args(argv, { out: { type: "string" }, root: { type: "string" }, prefix: { type: "string" } }, true);
	if (values.help) return console.log(HELP.timings);
	if (positionals.length === 0) fail(HELP.timings);
	const root = resolve(values.root ?? process.cwd());
	const files = prefixTimings(mergeTimings(positionals.map((path) => readReport(path, root))), values.prefix ?? "");
	const text = `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
	if (values.out) writeFileSync(values.out, text);
	else process.stdout.write(text);
	console.error(`${Object.keys(files).length} test files timed.`);
}

/** @param {string | undefined} path */
function loadTimings(path) {
	if (!path || !existsSync(path)) {
		console.error(`No timings at ${path ?? "(none given)"}; shards split evenly by file count.`);
		return {};
	}
	try {
		const files = JSON.parse(readFileSync(path, "utf8")).files;
		return files && typeof files === "object" ? files : {};
	} catch (error) {
		console.error(`Timings at ${path} are unreadable (${error instanceof Error ? error.message : error}); shards split evenly by file count.`);
		return {};
	}
}

/** @param {string[]} argv */
function shards(argv) {
	const { values } = args(argv, {
		timings: { type: "string" }, files: { type: "string" }, shard: { type: "string" }, count: { type: "string" },
		json: { type: "boolean" }, matrix: { type: "boolean" },
	});
	if (values.help) return console.log(HELP.shards);
	const list = readFileSync(values.files ?? 0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
	const timed = loadTimings(values.timings);
	if (Object.keys(timed).length > 0 && !list.some((file) => typeof timed[file] === "number")) {
		console.error("Warning: no listed file has a recorded time, so the split is by count. Check the paths (see timings --prefix).");
	}
	if (values.shard) {
		const match = /^(\d+)\/(\d+)$/.exec(values.shard);
		if (!match) fail(`--shard must be i/n, not ${values.shard}`);
		const [index, count] = [positive(match[1], "--shard"), positive(match[2], "--shard")];
		if (index > count) fail(`--shard ${values.shard}: the index is above the count`);
		const plan = planShards(list, timed, count);
		for (const file of plan[index - 1].files) console.log(file);
		return;
	}
	if (!values.count) fail(HELP.shards);
	const plan = planShards(list, timed, positive(values.count, "--count"));
	if (values.matrix) {
		const include = plan.filter((shard) => shard.files.length > 0).map((shard) => ({ shard: shard.index, of: plan.length, files: shard.files }));
		return console.log(JSON.stringify({ include }));
	}
	if (values.json) return console.log(JSON.stringify(plan, null, 2));
	for (const shard of plan) console.log(`shard ${shard.index}/${plan.length}: ${Math.round(shard.seconds)} s, ${shard.files.length} files`);
}

/** @param {string[]} gitArgs */
function git(gitArgs) {
	return execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * --no-renames lists both sides of a rename, so a moved lockfile still counts. -z and core.quotePath=false give raw
 * paths: git would quote a non-ASCII path, and a quoted path matches no glob.
 * @param {string} base
 */
function changedFiles(base) {
	const fields = git(["-c", "core.quotePath=false", "diff", "-z", "--name-status", "--no-renames", "--end-of-options", `${base}...HEAD`])
		.split("\0").filter(Boolean);
	const out = [];
	for (let i = 0; i + 1 < fields.length; i += 2) out.push({ status: fields[i], path: fields[i + 1] });
	return out;
}

/** @param {string[]} argv */
function select(argv) {
	const { values } = args(argv, { base: { type: "string" }, triggers: { type: "string" }, "github-output": { type: "boolean" } });
	if (values.help) return console.log(HELP.select);
	const base = values.base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
	if (base.startsWith("-")) fail(`--base must be a git revision, not ${JSON.stringify(base)}`);
	// Outside a work tree rev-parse fails; the diff below then fails too, and that gives a full run.
	const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	const top = topLevel.status === 0 ? topLevel.stdout.trim() : process.cwd();
	const own = join(top, ".ci", "full-run.txt");
	const extra = values.triggers ?? (existsSync(own) ? own : undefined);
	let parsed;
	try {
		parsed = extra ? parseTriggerFile(readFileSync(extra, "utf8")) : { globs: [], defaults: true };
	} catch (error) {
		fail(`${extra}: ${error instanceof Error ? error.message : error}`);
	}
	const globs = [...(parsed.defaults ? DEFAULT_TRIGGERS : []), ...parsed.globs];
	let decision;
	try {
		decision = decide(changedFiles(base), globs);
	} catch (error) {
		const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : String(error);
		decision = { mode: "full", reasons: [{ file: `no diff against ${base}: ${detail}`, glob: "(error)" }] };
	}
	for (const reason of decision.reasons) {
		console.error(`full run: ${reason.file} ${reason.glob.startsWith("(") ? reason.glob : `(${reason.glob})`}`);
	}
	if (values["github-output"]) {
		if (!process.env.GITHUB_OUTPUT) fail("--github-output needs GITHUB_OUTPUT");
		appendFileSync(process.env.GITHUB_OUTPUT, `mode=${decision.mode}\n`);
	}
	console.log(decision.mode);
}

const COMMANDS = { audit, timings, shards, select };
const [command, ...rest] = process.argv.slice(2);
if (!command || !(command in COMMANDS)) {
	console.log(Object.values(HELP).join("\n\n"));
	process.exit(command && command !== "--help" ? 2 : 0);
}
try {
	await COMMANDS[command](rest);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
