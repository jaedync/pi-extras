#!/usr/bin/env node
// Instruments for the formal-verification skill: install the checker, run every
// check of a verification record (fv.json) and compare each result with what
// the record expects, make traces for a conformance test, and tell when the
// covered code changed after the last sync. Node 22 or later; no dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { applyReplacements, invariantsFor, manifestProblems, replacementsFor } from "./lib/manifest.mjs";
import { formatTrace, parseTlcOutput } from "./lib/tlc-output.mjs";
import { envWithJava, QUINT_VERSION, readJson, setup } from "./lib/tools.mjs";

const USAGE = `usage: fv.mjs <command> [record] [options]

  record is a folder that holds fv.json, or the fv.json file itself.

commands:
  setup                 install Quint ${QUINT_VERSION} and, when no Java 17+ is on PATH, a
                        pinned Temurin 21 JRE into ~/.cache/pi-formal-verification
  check <record>        run each check with TLC (exhaustive within the spec's bounds)
                        and compare with its "expect"; exit 1 on any mismatch
      --only <name>     run one check (repeatable)
      --trace           print the counterexample of each violation
      --workers <n>     TLC workers (default: 1 for a check that expects a violation,
                        so its trace is the shortest; "auto" for one that expects a pass)
      --save <file>     write the results as JSON
  traces <record>       write random traces of the "traces.check" variant (quint run
                        --mbt) to one gzip file, one ITF JSON document per line, for a
                        conformance test that replays them against the code
                        "traces.witnesses" names invariants that must break: for each,
                        the simulator adds one run that reaches that rare state
      --n <n> --steps <n> --seed <hex> --out <file.itf.jsonl.gz>   override fv.json "traces"
  drift <record>        list covered files changed after syncCommit (committed or
                        not); exit 1 when any changed
  --json                print JSON
`;

function fail(message) {
	process.stderr.write(`fv: ${message}\n`);
	process.exit(2);
}

function loadRecord(path) {
	if (!path) fail("give the record folder or its fv.json");
	const file = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "fv.json") : path;
	let manifest;
	try {
		manifest = readJson(file);
	} catch (error) {
		fail(`cannot read ${file}: ${error.message}`);
	}
	const problems = manifestProblems(manifest);
	if (problems.length > 0) fail(`${file} is not valid:\n  ${problems.join("\n  ")}`);
	if (manifest.quint !== undefined && manifest.quint !== QUINT_VERSION) {
		process.stderr.write(`fv: warning: ${file} was checked with Quint ${manifest.quint}; this script runs ${QUINT_VERSION}\n`);
	}
	return { manifest, dir: dirname(resolve(file)) };
}

function variantSource(record, checkName) {
	const source = readFileSync(join(record.dir, record.manifest.spec), "utf8");
	return applyReplacements(source, replacementsFor(record.manifest, checkName));
}

/** Run quint in a scratch folder: it writes _apalache-out into its working folder. */
function inScratch(record, source, body) {
	const scratch = mkdtempSync(join(tmpdir(), "fv-"));
	try {
		const specFile = join(scratch, basename(record.manifest.spec));
		writeFileSync(specFile, source);
		return body(scratch, specFile);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function runTlc(tools, record, source, invariants, workers) {
	return inScratch(record, source, (scratch, specFile) => {
		const config = join(scratch, "tlc.json");
		writeFileSync(config, JSON.stringify({ workers, maxHeap: "-Xmx4G" }));
		const started = Date.now();
		const result = spawnSync(tools.quint, ["verify", specFile, "--backend=tlc", "--verbosity=3", `--tlc-config=${config}`, `--invariant=${invariants.join(",")}`], {
			cwd: scratch, encoding: "utf8", env: envWithJava(tools.java), maxBuffer: 256 * 1024 * 1024,
		});
		const report = parseTlcOutput(`${result.stdout}\n${result.stderr}`, result.status);
		return { ...report, seconds: (Date.now() - started) / 1000 };
	});
}

function expectText(expect) {
	return expect === "pass" ? "pass" : `violates ${expect.violates}`;
}

async function check(path, values) {
	const record = loadRecord(path);
	const tools = await setup({ log: (line) => process.stderr.write(`fv: ${line}\n`) });
	const only = new Set(values.only ?? []);
	const checks = record.manifest.checks.filter((c) => only.size === 0 || only.has(c.name));
	if (checks.length === 0) fail(`no check named ${[...only].join(", ")}`);
	// A violation is shown with its shortest trace, which needs one worker. A pass
	// has no trace, so it can use every core.
	const workersFor = (item) => values.workers ?? (item.expect === "pass" ? "auto" : "1");
	const results = [];
	for (const item of checks) {
		const source = variantSource(record, item.name);
		const invariants = invariantsFor(record.manifest, item);
		const run = runTlc(tools, record, source, invariants, workersFor(item));
		let violated = item.expect === "pass" ? null : item.expect.violates;
		// A pass check that fails: find which invariant broke, so the report names it.
		if (item.expect === "pass" && run.result === "violation" && invariants.length > 1) {
			violated = invariants.find((inv) => runTlc(tools, record, source, [inv], "1").result === "violation") ?? null;
		}
		const ok = item.expect === "pass" ? run.result === "pass" : run.result === "violation";
		results.push({ name: item.name, expect: expectText(item.expect), result: run.result, violated: run.result === "violation" ? violated : null, ok, ...run });
		if (!values.json) printResult(results.at(-1), item, values.trace || !ok);
	}
	if (values.save) writeFileSync(values.save, `${JSON.stringify({ quint: QUINT_VERSION, results }, null, 2)}\n`);
	if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
	else process.stdout.write(`\n${results.filter((r) => r.ok).length} of ${results.length} checks gave the expected result\n`);
	process.exit(results.every((r) => r.ok) ? 0 : 1);
}

function printResult(result, item, showTrace) {
	const states = result.distinct === null ? "" : `, ${result.distinct} distinct states, depth ${result.depth}`;
	const got = result.result === "violation" ? `violation${result.violated ? ` of ${result.violated}` : ""}` : result.result;
	process.stdout.write(`${result.ok ? "ok  " : "MISMATCH"} ${item.name}: expected ${result.expect}, got ${got}${states} (${result.seconds.toFixed(1)} s)\n`);
	if (item.mirrors) process.stdout.write(`     mirrors: ${item.mirrors}\n`);
	if (result.message) process.stdout.write(`     ${result.message}\n`);
	if (showTrace && result.trace.length > 0) process.stdout.write(`${formatTrace(result.trace).replace(/^/gm, "     ")}\n`);
}

async function traces(path, values) {
	const record = loadRecord(path);
	const settings = record.manifest.traces;
	if (!settings && !values.out) fail('fv.json has no "traces" settings; give --out');
	const checkName = settings?.check ?? record.manifest.checks[0].name;
	const out = resolve(record.dir, values.out ?? settings.out);
	if (!out.endsWith(".itf.jsonl.gz")) fail("the traces file name must end in .itf.jsonl.gz");
	const n = Number(values.n ?? settings?.n ?? 20);
	const steps = Number(values.steps ?? settings?.steps ?? 30);
	const seed = values.seed ?? settings?.seed ?? "0x1";
	const tools = await setup({ log: (line) => process.stderr.write(`fv: ${line}\n`) });
	const witnesses = settings?.witnesses ?? [];
	const lines = inScratch(record, variantSource(record, checkName), (scratch, specFile) => {
		const quintRun = (extra, out) => spawnSync(tools.quint, ["run", specFile, "--mbt", `--max-steps=${steps}`, `--seed=${seed}`, "--backend=rust", `--out-itf=${out}`, ...extra], {
			cwd: scratch, encoding: "utf8", env: envWithJava(tools.java), maxBuffer: 64 * 1024 * 1024,
		});
		const random = quintRun([`--n-traces=${n}`, `--max-samples=${n}`], join(scratch, "trace_{seq}.itf.json"));
		if (random.status !== 0) fail(`quint run failed:\n${random.stdout}\n${random.stderr}`);
		// One ITF document per line, in trace order. The metadata drops the time and
		// the scratch path, so the same seed gives the same file.
		const read = (file, meta) => {
			const doc = JSON.parse(readFileSync(file, "utf8"));
			return JSON.stringify({ ...doc, "#meta": { format: "ITF", source: record.manifest.spec, check: checkName, seed, ...meta } });
		};
		const docs = Array.from({ length: n }, (_, i) => read(join(scratch, `trace_${i}.itf.json`), { index: i }));
		for (const witness of witnesses) {
			// A witness is an invariant that must break: the run that breaks it reaches a rare state.
			const file = join(scratch, `witness_${witness}.itf.json`);
			const found = quintRun([`--invariant=${witness}`, "--max-samples=200000"], file);
			if (found.status === 0 || !existsSync(file)) fail(`no run reaches the witness ${witness} within ${steps} steps; the state may be unreachable`);
			docs.push(read(file, { witness }));
		}
		return docs;
	});
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, gzipSync(`${lines.join("\n")}\n`, { level: 9 }));
	process.stdout.write(`wrote ${lines.length} traces of ${checkName} (${n} random, ${lines.length - n} witnesses; up to ${steps} steps, seed ${seed}) to ${relative(process.cwd(), out)}\n`);
}

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

function drift(path, values) {
	const record = loadRecord(path);
	const root = git(record.dir, ["rev-parse", "--show-toplevel"]).trim();
	const paths = record.manifest.covers.map((c) => c.path);
	const committed = git(root, ["log", "--format=%h %s", `${record.manifest.syncCommit}..HEAD`, "--", ...paths]).trim().split("\n").filter(Boolean);
	const files = git(root, ["diff", "--name-only", record.manifest.syncCommit, "--", ...paths]).trim().split("\n").filter(Boolean);
	const report = { syncCommit: record.manifest.syncCommit, commits: committed, files };
	if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else if (files.length === 0) process.stdout.write(`in sync: no covered file changed after ${record.manifest.syncCommit}\n`);
	else {
		process.stdout.write(`covered code changed after ${record.manifest.syncCommit}; check that the spec still describes it:\n`);
		for (const file of files) process.stdout.write(`  ${file}\n`);
		for (const line of committed) process.stdout.write(`  commit ${line}\n`);
	}
	process.exit(files.length === 0 ? 0 : 1);
}

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			only: { type: "string", multiple: true }, trace: { type: "boolean" }, workers: { type: "string" },
			save: { type: "string" }, json: { type: "boolean" }, n: { type: "string" }, steps: { type: "string" },
			seed: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
		},
	});
	const [command, target] = positionals;
	if (values.help || !command) return void process.stdout.write(USAGE);
	if (command === "setup") {
		const tools = await setup({ log: (line) => process.stderr.write(`fv: ${line}\n`) });
		return void process.stdout.write(`quint ${QUINT_VERSION}: ${tools.quint}\njava: ${tools.java}\n`);
	}
	if (command === "check") return check(target, values);
	if (command === "traces") return traces(target, values);
	if (command === "drift") return drift(target, values);
	fail(`unknown command ${command}\n${USAGE}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
