import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyStep, jobBuckets, runWall, summarize, formatReport } from "../skills/speed-up-ci/scripts/lib/audit.mjs";
import { percentile } from "../skills/speed-up-ci/scripts/lib/stats.mjs";
import { mergeTimings, parseJsonReport, parseJunit, prefixTimings } from "../skills/speed-up-ci/scripts/lib/timings.mjs";
import { planShards } from "../skills/speed-up-ci/scripts/lib/shards.mjs";
import { DEFAULT_TRIGGERS, decide, globToRegExp, parseTriggerFile } from "../skills/speed-up-ci/scripts/lib/triggers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "skills", "speed-up-ci", "scripts", "ci.mjs");
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
function temp() {
	const dir = mkdtempSync(join(tmpdir(), "speed-up-ci-"));
	temps.push(dir);
	return dir;
}
/** @param {string} cwd @param {...string} args */
const ci = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
/** @param {string} dir @param {...string} args */
function git(dir, ...args) {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

const t = (s) => new Date(Date.UTC(2026, 10, 17, 12, 0, s)).toISOString();
const step = (name, from, to) => ({ name, started_at: t(from), completed_at: t(to), conclusion: "success" });
const job = (name, created, started, completed, steps) => ({ name, created_at: t(created), started_at: t(started), completed_at: t(completed), conclusion: "success", steps });

test("percentile uses the nearest rank and is undefined for no values", () => {
	assert.equal(percentile([], 50), undefined);
	assert.equal(percentile([7], 95), 7);
	assert.equal(percentile([1, 2, 3, 4], 50), 2);
	assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
	assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
});

test("setup steps are the runner, checkout, toolchain, cache, install and post steps", () => {
	for (const name of ["Set up job", "Run actions/checkout@v4", "Run actions/setup-node@v4", "Run actions/cache@v4",
		"Run npm ci --ignore-scripts", "Run pnpm install --frozen-lockfile", "Run bun install", "Run uv sync",
		"Post Run actions/checkout@v4", "Complete job", "Initialize containers", "Run oven-sh/setup-bun@v2"]) {
		assert.equal(classifyStep(name), "setup", name);
	}
	for (const name of ["Run npm test", "Run npm run typecheck", "Run oxlint", "Run gitleaks/gitleaks-action@v2", "Typecheck and test with Pi latest"]) {
		assert.equal(classifyStep(name), "running", name);
	}
	assert.equal(classifyStep("Run make deps", /make deps/), "setup");
});

test("a job splits into waiting, setup and running seconds that add up to its time from creation", () => {
	const buckets = jobBuckets(job("test", 0, 12, 100, [
		step("Set up job", 12, 14), step("Run actions/checkout@v4", 14, 20), step("Run npm ci", 20, 40),
		step("Run npm test", 40, 98), step("Post Run actions/checkout@v4", 98, 99), step("Complete job", 99, 100)]));
	assert.deepEqual(buckets, { name: "test", waiting: 12, setup: 30, running: 58, total: 100 });
});

test("a skipped job or one that never started has no buckets", () => {
	assert.equal(jobBuckets({ ...job("x", 0, 0, 0, []), conclusion: "skipped" }), undefined);
	assert.equal(jobBuckets({ ...job("x", 0, 0, 0, []), started_at: null }), undefined);
});

test("run wall time runs from the attempt start to the last job end", () => {
	const run = { id: 1, event: "pull_request", created_at: t(0), run_started_at: t(5), conclusion: "success" };
	assert.equal(runWall(run, [job("a", 5, 6, 50, []), job("b", 5, 7, 80, [])]), 75);
	assert.equal(runWall(run, []), undefined);
});

test("summarize gives per-job percentiles, the critical path buckets and runner minutes", () => {
	const runs = [10, 20, 30].map((wait, i) => ({
		run: { id: i, event: i === 2 ? "push" : "pull_request", created_at: t(0), run_started_at: t(0), conclusion: "success" },
		jobs: [
			job("lint", 0, 2, 12, [step("Set up job", 2, 4), step("Run oxlint", 4, 12)]),
			job("test", 0, wait, wait + 60, [step("Set up job", wait, wait + 20), step("Run npm test", wait + 20, wait + 60)]),
		],
	}));
	const summary = summarize(runs);
	assert.equal(summary.runs, 3);
	assert.deepEqual(summary.wall.all, { n: 3, p50: 80, p95: 90 });
	assert.deepEqual(summary.wall.pull_request, { n: 2, p50: 70, p95: 80 });
	const testJob = summary.jobs.find((entry) => entry.name === "test");
	assert.deepEqual(testJob.waiting, { p50: 20, p95: 30 });
	assert.deepEqual(testJob.setup, { p50: 20, p95: 20 });
	assert.equal(summary.jobs[0].name, "test", "the slowest job comes first");
	assert.deepEqual(summary.criticalPath.waiting, { p50: 20, p95: 30 });
	assert.equal(summary.biggest, "running");
	assert.equal(summary.runnerMinutes.setup, (3 * 2 + 3 * 20) / 60);
	const report = formatReport(summary, { p50: 120, p95: 180 });
	assert.match(report, /\| test \| 3 \|/);
	assert.match(report, /pull_request.*70 s.*80 s.*met/);
	assert.match(report, /Biggest critical-path bucket: running/);
	assert.deepEqual(summary.steps[0], { job: "test", step: "Run npm test", bucket: "running", n: 3, p50: 40, p95: 40 });
	assert.match(report, /\| test \| Run npm test \| running \| 3 \| 40 s \| 40 s \|/);
});

test("JUnit XML gives seconds per file from testcase file attributes or path-like suite names", () => {
	const vitest = `<?xml version="1.0"?><testsuites><testsuite name="src/a.test.ts" tests="2" time="1.5"><testcase classname="src/a.test.ts" name="x" time="1.0"/></testsuite>
		<testsuite name="src/b.test.ts" time="0.25"></testsuite><testsuite name="describe block" time="9"></testsuite></testsuites>`;
	assert.deepEqual(Object.fromEntries(parseJunit(vitest, "/repo")), { "src/a.test.ts": 1.5, "src/b.test.ts": 0.25 });
	const jest = `<testsuites><testsuite name="Login" time="2"><testcase file="/repo/web/login.test.tsx" time="0.5"/><testcase file="/repo/web/login.test.tsx" time="0.75"/></testsuite></testsuites>`;
	assert.deepEqual(Object.fromEntries(parseJunit(jest, "/repo")), { "web/login.test.tsx": 1.25 });
});

test("a Vitest or Jest JSON report gives seconds per file relative to the root", () => {
	const report = { testResults: [
		{ name: "/repo/src/a.test.ts", startTime: 1000, endTime: 3500 },
		{ name: "/repo/src/b.test.ts", perfStats: { start: 0, end: 500 } },
		{ name: "/elsewhere/c.test.ts", startTime: 0, endTime: 1000 },
	] };
	assert.deepEqual(Object.fromEntries(parseJsonReport(report, "/repo")), { "src/a.test.ts": 2.5, "src/b.test.ts": 0.5, "/elsewhere/c.test.ts": 1 });
});

test("a root reached through a symlink still makes report paths relative, as /var and /private/var on macOS", () => {
	const real = temp();
	mkdirSync(join(real, "src"));
	writeFileSync(join(real, "src", "a.test.ts"), "");
	const link = join(temp(), "link");
	symlinkSync(real, link);
	const report = { testResults: [{ name: join(real, "src", "a.test.ts"), startTime: 0, endTime: 1000 }] };
	assert.deepEqual(Object.fromEntries(parseJsonReport(report, link)), { "src/a.test.ts": 1 });
	const viaLink = { testResults: [{ name: join(link, "src", "a.test.ts"), startTime: 0, endTime: 1000 }] };
	assert.deepEqual(Object.fromEntries(parseJsonReport(viaLink, real)), { "src/a.test.ts": 1 });
	assert.deepEqual(Object.fromEntries(parseJunit(`<testsuite name="${join(real, "src", "a.test.ts")}" time="2"></testsuite>`, link)), { "src/a.test.ts": 2 });
});

test("merged timings keep the longest time of a file that two reports name", () => {
	const merged = mergeTimings([new Map([["a", 1], ["b", 2]]), new Map([["a", 3]])]);
	assert.deepEqual(merged, { a: 3, b: 2 });
});

test("shards are packed longest first onto the lightest shard, and new files get the median time", () => {
	const timings = { "a.test.ts": 50, "b.test.ts": 40, "c.test.ts": 30, "d.test.ts": 20, "e.test.ts": 10 };
	const plan = planShards([...Object.keys(timings), "new.test.ts"], timings, 2);
	// The new file gets 30 s, the median. Order: a 50, b 40, c 30, new 30, d 20, e 10.
	assert.deepEqual(plan.map((shard) => shard.files), [["a.test.ts", "e.test.ts", "new.test.ts"], ["b.test.ts", "c.test.ts", "d.test.ts"]]);
	assert.deepEqual(plan.map((shard) => shard.seconds), [90, 90]);
	assert.deepEqual(planShards(["z", "y"], {}, 3).map((shard) => shard.files), [["y"], ["z"], []]);
});

test("ties break by code point, not by the runner's locale, so every runner computes the same plan", () => {
	const plan = planShards(["a.test.ts", "B.test.ts"], {}, 2);
	assert.deepEqual(plan.map((shard) => shard.files), [["B.test.ts"], ["a.test.ts"]]);
	assert.deepEqual(Object.keys(mergeTimings([new Map([["a", 1], ["B", 1]])])), ["B", "a"]);
});

test("a job that fail-fast cancelled stays out of the job and step times", () => {
	const run = { id: 1, event: "push", created_at: t(0), run_started_at: t(0), conclusion: "failure" };
	const summary = summarize([{ run, jobs: [
		{ ...job("test (macos)", 0, 1, 300, [step("Run npm test", 1, 300)]), conclusion: "failure" },
		{ ...job("test (ubuntu)", 0, 1, 20, [step("Run npm test", 1, 20)]), conclusion: "cancelled" },
	] }]);
	assert.deepEqual(summary.jobs.map((entry) => entry.name), ["test (macos)"]);
	assert.ok(summary.steps.every((entry) => entry.job === "test (macos)"));
});

test("the node:test timings reporter writes one suite per file that ci.mjs timings reads", () => {
	const dir = temp();
	writeFileSync(join(dir, "one.test.mjs"), "import { test } from 'node:test'; test('x', () => {});\n");
	const reporter = join(ROOT, "skills", "speed-up-ci", "scripts", "node-test-timings-reporter.mjs");
	// A node --test child of a test run reports to its parent unless it loses the parent's test context.
	const { NODE_TEST_CONTEXT: _parent, ...nested } = process.env;
	let result = spawnSync(process.execPath, ["--test", "--test-reporter", reporter, "--test-reporter-destination", "report.xml", "one.test.mjs"], { cwd: dir, encoding: "utf8", env: nested });
	assert.equal(result.status, 0, result.stderr);
	result = ci(dir, "timings", "report.xml");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(Object.keys(JSON.parse(result.stdout).files), ["one.test.mjs"]);
});

test("the shard plan does not depend on the input order", () => {
	const timings = { a: 5, b: 5, c: 5, d: 1 };
	const one = planShards(["a", "b", "c", "d"], timings, 3);
	const two = planShards(["d", "c", "b", "a"], timings, 3);
	assert.deepEqual(one, two);
});

test("random file sets pack every file once and the largest shard is at most the mean plus the longest file", () => {
	let seed = 7;
	const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
	for (let round = 0; round < 200; round++) {
		const count = 1 + Math.floor(random() * 12);
		const files = Array.from({ length: Math.floor(random() * 60) }, (_, i) => `f${i}.test.ts`);
		const timings = Object.fromEntries(files.filter(() => random() > 0.2).map((file) => [file, Math.round(random() * 1000) / 10]));
		const plan = planShards(files, timings, count);
		assert.equal(plan.length, count);
		assert.deepEqual(plan.flatMap((shard) => shard.files).sort(), [...files].sort());
		const seconds = plan.map((shard) => shard.seconds);
		const total = seconds.reduce((a, b) => a + b, 0);
		const longest = Math.max(0, ...Object.values(timings));
		const known = Object.values(timings);
		const fill = known.length ? [...known].sort((a, b) => a - b)[Math.floor((known.length - 1) / 2)] : 1;
		assert.ok(Math.max(...seconds) <= total / count + Math.max(longest, fill) + 1e-9, `round ${round}`);
	}
});

test("globs match whole paths with *, ** and braces", () => {
	assert.ok(globToRegExp("**/package.json").test("package.json"));
	assert.ok(globToRegExp("**/package.json").test("apps/web/package.json"));
	assert.ok(!globToRegExp("**/package.json").test("apps/web/package.json.bak"));
	assert.ok(globToRegExp(".github/**").test(".github/workflows/ci.yml"));
	assert.ok(globToRegExp("**/tsconfig*.json").test("tsconfig.build.json"));
	assert.ok(!globToRegExp("*.lock").test("sub/yarn.lock"));
	assert.ok(globToRegExp("**/{vite,vitest}.config.*").test("web/vitest.config.ts"));
	assert.ok(globToRegExp("src/?.ts").test("src/a.ts"));
	assert.ok(!globToRegExp("src/?.ts").test("src/ab.ts"));
	assert.ok(globToRegExp("a.b").test("a.b") && !globToRegExp("a.b").test("axb"));
});

test("a change that only touches imported code is affected; a trigger or no diff is full", () => {
	const globs = ["**/package-lock.json", "**/conftest.py"];
	const m = (path) => ({ status: "M", path });
	assert.deepEqual(decide([m("src/a.ts"), m("src/a.test.ts")], globs), { mode: "affected", reasons: [] });
	assert.deepEqual(decide([m("src/a.ts"), m("package-lock.json")], globs), { mode: "full", reasons: [{ file: "package-lock.json", glob: "**/package-lock.json" }] });
	assert.equal(decide([], globs).mode, "full");
	// A deleted module is in no import graph, so no selector finds the tests that imported it.
	assert.deepEqual(decide([m("src/a.test.ts"), { status: "D", path: "src/u.ts" }], globs), { mode: "full", reasons: [{ file: "src/u.ts", glob: "(deleted)" }] });
	// A path that git still quoted cannot match a glob.
	assert.equal(decide([m("\"src/caf\\303\\251.ts\"")], globs).mode, "full");
	// Git quotes a tab, a quote or a backslash also with core.quotePath=false, so Vitest cannot match such a path.
	for (const path of ["src/x\ty/u.ts", "src/q\"d/u.ts", "src/b\\s/u.ts"]) assert.equal(decide([m(path)], globs).mode, "full", JSON.stringify(path));
});

test("a trigger file adds globs, skips comments, and can drop the defaults", () => {
	assert.deepEqual(parseTriggerFile("# generated client\nsrc/api/generated/**\n\n  openapi.yaml  \n"), { globs: ["src/api/generated/**", "**/openapi.yaml"], defaults: true });
	assert.deepEqual(parseTriggerFile("--no-defaults\nfoo/**\n"), { globs: ["foo/**"], defaults: false });
});

test("trigger lines follow gitignore habits: a leading ./ or / is the root, and a name with no slash matches at any depth", () => {
	const { globs } = parseTriggerFile("./cfg/*.json\n/top/*.yml\napp.json\n");
	assert.deepEqual(globs, ["cfg/*.json", "top/*.yml", "**/app.json"]);
	for (const [file, glob] of [["cfg/app.json", globs[0]], ["top/a.yml", globs[1]], ["deep/x/app.json", globs[2]], ["app.json", globs[2]]]) {
		assert.ok(globToRegExp(glob).test(file), `${glob} ${file}`);
	}
	assert.throws(() => globToRegExp("{a,{b,c}}"), /nested/);
});

test("the defaults cover inputs that reach tests with no import edge", () => {
	const m = (path) => ({ status: "M", path });
	for (const path of [".ci/full-run.txt", ".ci/ci.mjs", "patches/react+19.0.0.patch", ".npmrc", "bunfig.toml", ".yarnrc.yml",
		"__mocks__/fs.js", "src/global-setup.ts", "src/globalSetup.ts", "Dockerfile", "docker-compose.yml", "compose.yaml",
		"package-lock.json", "web/vitest.config.ts", ".github/workflows/ci.yml", "db/migrations/001.sql"]) {
		assert.equal(decide([m(path)], DEFAULT_TRIGGERS).mode, "full", path);
	}
	assert.equal(decide([m("src/app/page.tsx")], DEFAULT_TRIGGERS).mode, "affected");
});

test("ci.mjs select reads the diff against the merge base and names the trigger", () => {
	const dir = temp();
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "commit.gpgsign", "false");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "package-lock.json"), "{}\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "base");
	git(dir, "checkout", "-q", "-b", "feature");
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
	git(dir, "commit", "-q", "-am", "code");
	let result = ci(dir, "select", "--base", "main");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "affected");

	git(dir, "mv", "package-lock.json", "old-lock.json");
	git(dir, "commit", "-q", "-m", "rename");
	const output = join(dir, "gh-output");
	result = spawnSync(process.execPath, [CLI, "select", "--base", "main", "--github-output"], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "full");
	assert.match(result.stderr, /package-lock\.json/);
	assert.match(readFileSync(output, "utf8"), /^mode=full$/m);

	git(dir, "checkout", "-q", "-b", "unicode", "main");
	mkdirSync(join(dir, "pkgs", "café"), { recursive: true });
	writeFileSync(join(dir, "pkgs", "café", "package.json"), "{}\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "unicode");
	result = ci(dir, "select", "--base", "main");
	assert.equal(result.stdout.trim(), "full", "a non-ASCII path still matches its trigger");
	assert.match(result.stderr, /pkgs\/café\/package\.json/);

	git(dir, "checkout", "-q", "-b", "delete", "main");
	git(dir, "rm", "-q", "src/a.ts");
	git(dir, "commit", "-q", "-m", "delete");
	result = ci(dir, "select", "--base", "main");
	assert.equal(result.stdout.trim(), "full");
	assert.match(result.stderr, /src\/a\.ts \(deleted\)/);

	git(dir, "checkout", "-q", "-b", "own-trigger", "main");
	mkdirSync(join(dir, ".ci"));
	writeFileSync(join(dir, ".ci", "full-run.txt"), "--no-defaults\nsrc/a.ts\n");
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
	git(dir, "add", "src/a.ts");
	git(dir, "commit", "-q", "-m", "own");
	result = spawnSync(process.execPath, [CLI, "select", "--base", "main"], { cwd: join(dir, "src"), encoding: "utf8" });
	assert.equal(result.stdout.trim(), "full", "the trigger file is found at the repository root from a subfolder");

	result = ci(dir, "select", "--base", "--output=pwned");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--base/);

	result = ci(dir, "select", "--base", "no-such-branch");
	assert.equal(result.status, 0);
	assert.equal(result.stdout.trim(), "full", "a diff that git cannot compute runs everything");
	assert.match(result.stderr, /no-such-branch/);
});

test("ci.mjs timings and shards turn reports into the same plan on every shard", () => {
	const dir = temp();
	writeFileSync(join(dir, "report.json"), JSON.stringify({ testResults: [
		{ name: join(dir, "a.test.ts"), startTime: 0, endTime: 9000 },
		{ name: join(dir, "b.test.ts"), startTime: 0, endTime: 4000 },
		{ name: join(dir, "c.test.ts"), startTime: 0, endTime: 4000 },
	] }));
	let result = ci(dir, "timings", "report.json", "--prefix", "pkg/");
	assert.match(result.stdout, /"pkg\/a\.test\.ts": 9/);
	result = ci(dir, "timings", "report.json", "--out", "timings.json");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "timings.json"), "utf8")), { version: 1, files: { "a.test.ts": 9, "b.test.ts": 4, "c.test.ts": 4 } });
	writeFileSync(join(dir, "files.txt"), "c.test.ts\na.test.ts\nb.test.ts\nd.test.ts\n");
	result = ci(dir, "shards", "--timings", "timings.json", "--files", "files.txt", "--shard", "1/2");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.stdout.trim().split("\n"), ["a.test.ts"]);
	result = ci(dir, "shards", "--timings", "timings.json", "--files", "files.txt", "--shard", "2/2");
	assert.deepEqual(result.stdout.trim().split("\n"), ["b.test.ts", "c.test.ts", "d.test.ts"]);
	result = ci(dir, "shards", "--timings", "timings.json", "--files", "files.txt", "--count", "2");
	assert.match(result.stdout, /shard 1\/2: 9 s, 1 files/);
	result = ci(dir, "shards", "--timings", "timings.json", "--files", "files.txt", "--count", "6", "--matrix");
	assert.equal(result.status, 0, result.stderr);
	const matrix = JSON.parse(result.stdout);
	assert.deepEqual(matrix.include.map((entry) => [entry.shard, entry.of, entry.files]),
		[[1, 6, ["a.test.ts"]], [2, 6, ["b.test.ts"]], [3, 6, ["c.test.ts"]], [4, 6, ["d.test.ts"]]], "empty shards are left out");
	writeFileSync(join(dir, "other.txt"), "x.test.ts\n");
	result = ci(dir, "shards", "--timings", "timings.json", "--files", "other.txt", "--count", "1");
	assert.match(result.stderr, /no listed file has a recorded time/);
	result = ci(dir, "shards", "--timings", "timings.json", "--files", "files.txt", "--shard", "3/2");
	assert.equal(result.status, 2);
	result = ci(dir, "shards", "--timings", "missing.json", "--files", "files.txt", "--shard", "1/2");
	assert.equal(result.status, 0, "missing timings fall back to an even split by count");
	assert.match(result.stderr, /missing\.json/);
});

test("cancelled and skipped runs stay out of the wall time, and the conclusions are counted", () => {
	const base = { event: "pull_request", created_at: t(0), run_started_at: t(0) };
	const runs = [
		{ run: { ...base, id: 1, conclusion: "success" }, jobs: [job("test", 0, 1, 100, [])] },
		{ run: { ...base, id: 2, conclusion: "failure" }, jobs: [job("test", 0, 1, 90, [])] },
		{ run: { ...base, id: 3, conclusion: "cancelled" }, jobs: [job("test", 0, 1, 5, [])] },
	];
	const summary = summarize(runs);
	assert.deepEqual(summary.wall.all, { n: 2, p50: 90, p95: 100 });
	assert.deepEqual(summary.conclusions, { success: 1, failure: 1, cancelled: 1 });
	assert.equal(summary.jobs[0].n, 2);
	assert.deepEqual(summarize(runs, undefined, { successOnly: true }).wall.all, { n: 1, p50: 100, p95: 100 });
});

test("timings of a package get the package path, so they match repository paths", () => {
	assert.deepEqual(prefixTimings({ "src/a.test.ts": 1, "/abs/b.test.ts": 2 }, "apps/web/"), { "apps/web/src/a.test.ts": 1, "/abs/b.test.ts": 2 });
	assert.deepEqual(prefixTimings({ "a.ts": 1 }, ""), { "a.ts": 1 });
});

test("ci.mjs audit reads saved runs and refuses a bad repository name", () => {
	const dir = temp();
	const runs = [{ run: { id: 1, event: "pull_request", created_at: t(0), run_started_at: t(0), conclusion: "success" },
		jobs: [job("test", 0, 3, 63, [step("Set up job", 3, 5), step("Run npm test", 5, 63)])] }];
	writeFileSync(join(dir, "runs.json"), JSON.stringify({ version: 1, repo: "o/r", runs }));
	let result = ci(dir, "audit", "--from", "runs.json");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /\| test \| 1 \|/);
	result = ci(dir, "audit", "--repo", "o/r; rm -rf /");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /owner\/name/);
});
