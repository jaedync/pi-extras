import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyReplacements, invariantsFor, manifestProblems, replacementsFor } from "../skills/formal-verification/scripts/lib/manifest.mjs";
import { formatTrace, parseTlcOutput } from "../skills/formal-verification/scripts/lib/tlc-output.mjs";
import { cacheDir, envWithJava, javaMajor, jreBuild, JRE_BUILDS } from "../skills/formal-verification/scripts/lib/tools.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/formal-verification/${name}`, import.meta.url), "utf8");
const CLI = new URL("../skills/formal-verification/scripts/fv.mjs", import.meta.url).pathname;
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

function manifest(overrides = {}) {
	return {
		spec: "m.qnt", invariants: ["safe"], syncCommit: "abc1234", covers: [{ path: "src/a.ts" }],
		checks: [{ name: "base", expect: "pass" }],
		...overrides,
	};
}

test("manifest: a valid record has no problems", () => {
	assert.deepEqual(manifestProblems(manifest()), []);
	assert.deepEqual(manifestProblems(readJson("../formal/shell-jobs-delivery/fv.json")), []);
});

function readJson(relative) {
	return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

test("manifest: names each problem", () => {
	assert.deepEqual(manifestProblems(null), ["fv.json must hold an object"]);
	const problems = manifestProblems(manifest({
		spec: "m.tla", syncCommit: "main", invariants: [], covers: [],
		checks: [
			{ name: "Bad Name", expect: "pass" },
			{ name: "a", expect: "fails" },
			{ name: "a", expect: "pass", base: "later" },
			{ name: "mutant-x", expect: { violates: "safe" } },
			{ name: "b", expect: "pass", replace: [{ from: "", to: "x" }] },
		],
	}));
	for (const part of ["spec must name a .qnt", "syncCommit must be", "invariants must be", "covers must list", "lowercase words", "expect must be", "is used twice", "base must name an earlier", "must say which code change", "replace must be"]) {
		assert.ok(problems.some((p) => p.includes(part)), `missing problem: ${part}\n${problems.join("\n")}`);
	}
});

test("replacements: a check gets its base chain first, and a loop is an error", () => {
	const m = manifest({ checks: [
		{ name: "a", expect: "pass", replace: [{ from: "1", to: "2" }] },
		{ name: "b", base: "a", expect: "pass", replace: [{ from: "2", to: "3" }] },
		{ name: "c", base: "b", expect: { violates: "safe" }, replace: [{ from: "x", to: "y" }] },
	] });
	assert.deepEqual(replacementsFor(m, "c").map((r) => r.from), ["1", "2", "x"]);
	assert.equal(applyReplacements("1 x", replacementsFor(m, "c")), "3 y");
	assert.throws(() => replacementsFor(m, "missing"), /no check named missing/);
	const loop = manifest({ checks: [{ name: "a", base: "b", expect: "pass" }, { name: "b", base: "a", expect: "pass" }] });
	assert.throws(() => replacementsFor(loop, "a"), /base loop/);
});

test("replacements: text must occur exactly once", () => {
	assert.throws(() => applyReplacements("abc", [{ from: "z", to: "y" }]), /not found/);
	assert.throws(() => applyReplacements("aa", [{ from: "a", to: "b" }]), /more than once/);
	assert.equal(applyReplacements("guard and act", [{ from: "guard and ", to: "" }]), "act");
});

test("invariants: a violation check runs only its invariant", () => {
	const m = manifest({ invariants: ["a", "b"] });
	assert.deepEqual(invariantsFor(m, { name: "x", expect: "pass" }), ["a", "b"]);
	assert.deepEqual(invariantsFor(m, { name: "x", expect: "pass", invariants: ["b"] }), ["b"]);
	assert.deepEqual(invariantsFor(m, { name: "x", expect: { violates: "b" } }), ["b"]);
});

test("tlc output: a pass gives counts and no trace", () => {
	const report = parseTlcOutput(fixture("tlc-pass.txt"), 0);
	assert.equal(report.result, "pass");
	assert.equal(report.distinct, 4);
	assert.equal(report.generated, 7);
	assert.equal(report.depth, 4);
	assert.deepEqual(report.trace, []);
	assert.equal(parseTlcOutput(fixture("tlc-pass.txt"), 1).result, "error", "a pass message with a failing exit code is not a pass");
});

test("tlc output: a violation gives the trace with action names", () => {
	const report = parseTlcOutput(fixture("tlc-violation.txt"), 1);
	assert.equal(report.result, "violation");
	assert.deepEqual(report.trace.map((s) => s.action), ["init", "inc", "inc"]);
	assert.deepEqual(report.trace[2].vars, { x: "2", log: '<<"inc", "inc">>' });
	const text = formatTrace(report.trace);
	assert.match(text, /^0\. init\n {5}x = 0/);
	assert.match(text, /2\. inc\n {5}x = 2\n {5}log = <<"inc", "inc">>$/);
});

test("tlc output: a parse failure is an error with its message", () => {
	const report = parseTlcOutput("m.qnt:3:5 - error: [QNT404] Name 'foo' not found\nerror: parsing failed\n", 1);
	assert.equal(report.result, "error");
	assert.match(report.message, /QNT404/);
});

test("tools: java versions, pinned builds and the cache folder", () => {
	assert.equal(javaMajor('openjdk version "21.0.13" 2026-10-20 LTS'), 21);
	assert.equal(javaMajor('java version "1.8.0_402"'), 8);
	assert.equal(javaMajor("no java here"), null);
	assert.equal(jreBuild("linux", "x64"), JRE_BUILDS["linux-x64"]);
	assert.equal(jreBuild("win32", "x64"), null);
	for (const build of Object.values(JRE_BUILDS)) assert.match(build.sha256, /^[0-9a-f]{64}$/);
	assert.equal(cacheDir({ XDG_CACHE_HOME: "/c" }), "/c/pi-formal-verification");
	assert.equal(envWithJava("/opt/jre/bin/java", { PATH: "/usr/bin" }).PATH, "/opt/jre/bin:/usr/bin");
	assert.equal(envWithJava("java", { PATH: "/usr/bin" }).PATH, "/usr/bin");
});

function gitRepo() {
	const dir = mkdtempSync(join(tmpdir(), "fv-drift-"));
	temps.push(dir);
	const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
	git("init", "-q");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
	writeFileSync(join(dir, "m.qnt"), "module m {}\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const sync = git("rev-parse", "--short", "HEAD");
	writeFileSync(join(dir, "fv.json"), JSON.stringify(manifest({ syncCommit: sync, covers: [{ path: "a.ts" }] })));
	return { dir, git };
}

test("drift: in sync, then a committed and an uncommitted change to covered code", () => {
	const { dir, git } = gitRepo();
	const run = () => spawnSync(process.execPath, [CLI, "drift", dir, "--json"], { encoding: "utf8" });
	let result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout).files, []);
	writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
	git("commit", "-qam", "uncovered change");
	assert.equal(run().status, 0, "a change to uncovered code is not drift");
	writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
	result = run();
	assert.equal(result.status, 1);
	assert.deepEqual(JSON.parse(result.stdout).files, ["a.ts"]);
	git("commit", "-qam", "covered change");
	const report = JSON.parse(run().stdout);
	assert.deepEqual(report.files, ["a.ts"]);
	assert.equal(report.commits.length, 1);
	assert.match(report.commits[0], /covered change/);
});

test("cli: an invalid record is refused before any tool runs", () => {
	const dir = mkdtempSync(join(tmpdir(), "fv-bad-"));
	temps.push(dir);
	writeFileSync(join(dir, "fv.json"), JSON.stringify({ spec: "x.tla" }));
	const result = spawnSync(process.execPath, [CLI, "check", dir], { encoding: "utf8" });
	assert.equal(result.status, 2);
	assert.match(result.stderr, /is not valid/);
});
