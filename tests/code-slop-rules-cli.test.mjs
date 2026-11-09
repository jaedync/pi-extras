import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findAstGrep } from "../skills/code-slop-rules/scripts/lib/ast-grep.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "skills", "code-slop-rules", "scripts", "slop.mjs");
const CATALOG_CONFIG = join(ROOT, "skills", "code-slop-rules", "catalog", "sgconfig.yml");
const { tool, error } = findAstGrep(ROOT);
assert.ok(tool, error);
const env = { ...process.env, AST_GREP_BIN: tool.command };
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "code-slop-cli-"));
	temps.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "commit.gpgsign", "false");
	return dir;
}
/** @param {string} dir @param {...string} args */
function git(dir, ...args) {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}
/** @param {string} dir @param {string} path @param {string} text */
function put(dir, path, text) {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
}
/** @param {string} dir @param {...string} args */
const slop = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });

test("catalog: every rule passes its own valid and invalid cases", () => {
	const result = spawnSync(tool.command, [...tool.args, "test", "--config", CATALOG_CONFIG, "--skip-snapshot-tests"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /test result: ok\. \d+ passed; 0 failed/);
});

test("ratchet: a new site fails with its file and line, an update refuses it, --allow-increase records it", () => {
	const dir = repo();
	put(dir, "src/a.ts", "export function f() {\n  try { g(); } catch {}\n}\n");
	put(dir, "tests/a.test.ts", "const x = y as any;\n");
	assert.equal(slop(dir, "adopt", "ts-swallowed-catch", "ts-as-any", "--exclude-tests", "ts-as-any").status, 0);
	const recorded = slop(dir, "ratchet", "--update");
	assert.equal(recorded.status, 0, recorded.stderr);
	const baseline = JSON.parse(readFileSync(join(dir, "lint/slop/baseline.json"), "utf8"));
	assert.equal(baseline.rules["ts-swallowed-catch"].count, 1);
	assert.equal(baseline.rules["ts-as-any"].count, 0, "the test file is ignored for ts-as-any");
	assert.equal(slop(dir, "ratchet").status, 0);

	put(dir, "src/b.ts", "export const b = () => {\n  try { h(); } catch (error) { /* fine */ }\n};\n");
	const failed = slop(dir, "ratchet");
	assert.equal(failed.status, 1, failed.stdout);
	assert.match(failed.stdout, /FAIL ts-swallowed-catch: 1 -> 2 sites/);
	assert.match(failed.stdout, /src\/b\.ts:2 /);

	const refused = slop(dir, "ratchet", "--update");
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /Refused: more sites than the baseline for ts-swallowed-catch/);
	assert.equal(slop(dir, "ratchet", "--update", "--allow-increase").status, 0);
	assert.equal(slop(dir, "ratchet").status, 0);
});

test("ratchet: fewer sites pass and say how to lock the gain", () => {
	const dir = repo();
	put(dir, "a.ts", "try { g(); } catch {}\ntry { g(); } catch {}\n");
	slop(dir, "adopt", "ts-swallowed-catch");
	slop(dir, "ratchet", "--update");
	put(dir, "a.ts", "try { g(); } catch {}\n");
	const result = slop(dir, "ratchet");
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Fewer sites: ts-swallowed-catch 2 -> 1\. Run the ratchet with --update/);
});

test("ratchet: a broken rule test fails before any count", () => {
	const dir = repo();
	slop(dir, "adopt", "ts-swallowed-catch");
	put(dir, "lint/slop/rule-tests/ts-swallowed-catch-test.yml", "id: ts-swallowed-catch\nvalid:\n  - 'try { f(); } catch {}'\ninvalid: []\n");
	const result = slop(dir, "ratchet");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Rule tests failed/);
});

test("measure: counts sites apart for source and tests, and credits a fix commit that removed a site", () => {
	const dir = repo();
	put(dir, "src/a.ts", "export function f() {\n  try { g(); } catch {}\n  try { g(); } catch {}\n}\n");
	put(dir, "tests/a.test.ts", "try { g(); } catch {}\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "feat: start");
	put(dir, "src/a.ts", "export function f() {\n  try { g(); } catch (error) { report(error); }\n  try { g(); } catch {}\n}\n");
	git(dir, "commit", "-qam", "fix: report the first failure\n\nFound-by: review");
	const json = join(dir, "measure.json");
	const result = slop(dir, "measure", "--json", json);
	assert.equal(result.status, 0, result.stderr);
	const data = JSON.parse(readFileSync(json, "utf8"));
	const rule = data.rules.find((/** @type {any} */ r) => r.id === "ts-swallowed-catch");
	assert.equal(rule.sites, 2);
	assert.equal(rule.source, 1);
	assert.equal(rule.tests, 1);
	assert.equal(rule.verdict, "adopt");
	assert.deepEqual({ fixes: rule.fixes.fixesRemoving, sites: rule.fixes.sitesRemoved, by: rule.fixes.removingFoundBy }, { fixes: 1, sites: 1, by: { review: 1 } });
	assert.equal(data.history.withFoundBy, 1);
	assert.equal(data.rules.find((/** @type {any} */ r) => r.id === "ts-todo-comment").verdict, "skip: no sites");
	assert.match(result.stdout, /\| ts-swallowed-catch \| swallowed-error \| high \| 2 \| 1 \| 1 \| 1 \(review 1\) \|/);
});

test("measure: a rule that a configured ESLint enforces is a skip, and a repository with no linter says so", () => {
	const dir = repo();
	put(dir, "a.ts", "try { g(); } catch {}\n");
	put(dir, "eslint.config.js", "export default [];\n");
	put(dir, "node_modules/.bin/eslint", "#!/bin/sh\necho '{\"rules\":{\"no-empty\":[\"error\"],\"no-console\":\"off\"}}'\n");
	spawnSync("chmod", ["+x", join(dir, "node_modules/.bin/eslint")]);
	git(dir, "add", "a.ts", "eslint.config.js");
	git(dir, "commit", "-qm", "feat: start");
	const json = join(dir, "measure.json");
	assert.equal(slop(dir, "measure", "--json", json, "--history", "0").status, 0);
	const data = JSON.parse(readFileSync(json, "utf8"));
	const rule = data.rules.find((/** @type {any} */ r) => r.id === "ts-swallowed-catch");
	assert.equal(rule.verdict, "skip: linter");
	assert.deepEqual(rule.enforcedBy, ["eslint: no-empty"]);

	const bare = repo();
	put(bare, "a.ts", "const a = 1;\n");
	assert.match(slop(bare, "measure", "--history", "0").stdout, /Linters: none configured/);
});

test("measure: tsx files get the TypeScript rules too", () => {
	const dir = repo();
	put(dir, "a.tsx", "export const A = () => { try { g(); } catch {} return <div />; };\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "feat: start");
	const json = join(dir, "measure.json");
	assert.equal(slop(dir, "measure", "--json", json, "--history", "0").status, 0);
	assert.equal(JSON.parse(readFileSync(json, "utf8")).rules.find((/** @type {any} */ r) => r.id === "ts-swallowed-catch").sites, 1);
});

test("setup --check names the ast-grep that the commands use", () => {
	const result = slop(ROOT, "setup", "--check");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^ast-grep 0\.51\.\d+ from \$AST_GREP_BIN/);
});

// Review findings H1, H2, M1, M4 (2026-11-09): each test below failed before its fix.

/** A stand-in ast-grep: `--version` answers as the real one, every other call runs `body`. @param {string} body */
function fakeAstGrep(body) {
	const dir = mkdtempSync(join(tmpdir(), "code-slop-fake-"));
	temps.push(dir);
	const path = join(dir, "ast-grep");
	writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "${tool.command}" --version; fi\n${body}\n`, { mode: 0o755 });
	return path;
}

/** @param {string} dir */
function adoptedRepo(dir) {
	put(dir, "src/a.ts", "export function f() {\n  try { g(); } catch {}\n  try { g(); } catch {}\n}\n");
	assert.equal(slop(dir, "adopt", "ts-swallowed-catch", "ts-lint-disable").status, 0);
	assert.equal(slop(dir, "ratchet", "--update").status, 0);
}

test("ratchet: a scan that a signal stops, or that prints nothing, is an error and never a pass", () => {
	const dir = repo();
	adoptedRepo(dir);
	const before = readFileSync(join(dir, "lint/slop/baseline.json"), "utf8");
	const killed = fakeAstGrep(`"${tool.command}" "$@" | head -n 1; kill -KILL $$`);
	const empty = fakeAstGrep("exit 0");
	// Whole output, then a signal: only the signal tells that the run did not end well.
	const killedAfter = fakeAstGrep(`"${tool.command}" "$@"; kill -KILL $$`);
	for (const fake of [killed, empty, killedAfter]) {
		for (const args of [["ratchet", "--no-test"], ["ratchet", "--no-test", "--update"]]) {
			const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...env, AST_GREP_BIN: fake }, encoding: "utf8" });
			assert.equal(result.status, 2, `${fake} ${args.join(" ")}: ${result.stdout}${result.stderr}`);
			assert.match(result.stderr, /ast-grep scan (failed|stopped|gave incomplete output)/);
		}
	}
	assert.equal(readFileSync(join(dir, "lint/slop/baseline.json"), "utf8"), before, "a failed scan writes no baseline");
});

test("ratchet: an ast-grep-ignore comment that hides a new site is itself a new site", () => {
	const dir = repo();
	adoptedRepo(dir);
	put(dir, "src/b.ts", "export function h() {\n  // ast-grep-ignore\n  try { g(); } catch {}\n}\n");
	const result = slop(dir, "ratchet");
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stdout, /FAIL ts-lint-disable: 0 -> 1 sites/);
});

test("ratchet: a removed, renamed or changed rule fails, and --update accepts it only with --allow-increase", () => {
	const dir = repo();
	adoptedRepo(dir);
	const rule = join(dir, "lint/slop/rules/ts-swallowed-catch.yml");
	const text = readFileSync(rule, "utf8");

	writeFileSync(rule, text.replace(/^(severity: .*)$/m, "$1\nfiles: ['nothing/**']"));
	const narrowed = slop(dir, "ratchet");
	assert.equal(narrowed.status, 1, narrowed.stdout);
	assert.match(narrowed.stdout, /FAIL changed since the baseline: ts-swallowed-catch/);
	assert.equal(slop(dir, "ratchet", "--update").status, 2, "an update must not accept a changed rule by itself");

	writeFileSync(rule, text.replace(/^id: ts-swallowed-catch$/m, "id: ts-empty-catch"));
	const renamed = slop(dir, "ratchet", "--no-test");
	assert.equal(renamed.status, 1);
	assert.match(renamed.stdout, /FAIL removed since the baseline: ts-swallowed-catch/);
	const refused = slop(dir, "ratchet", "--update", "--no-test");
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /removed or changed: ts-swallowed-catch/);

	rmSync(rule);
	assert.equal(slop(dir, "ratchet", "--no-test").status, 1, "a deleted rule fails");
	assert.equal(slop(dir, "ratchet", "--update", "--allow-increase", "--no-test").status, 0);
	assert.equal(slop(dir, "ratchet", "--no-test").status, 0);
});

test("ratchet: a change to sgconfig.yml (for example a narrower languageGlobs) fails as a changed rule set", () => {
	const dir = repo();
	adoptedRepo(dir);
	const config = join(dir, "sgconfig.yml");
	writeFileSync(config, readFileSync(config, "utf8").replace("'*.mjs', ", ""));
	const result = slop(dir, "ratchet");
	assert.equal(result.status, 1);
	assert.match(result.stdout, /FAIL changed since the baseline: sgconfig\.yml/);
});

test("measure: a fix commit to a file whose name git quotes still counts", () => {
	const dir = repo();
	put(dir, "café.ts", "try { g(); } catch {}\n");
	put(dir, "a b.ts", "try { g(); } catch {}\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "feat: start");
	put(dir, "café.ts", "try { g(); } catch (e) { report(e); }\n");
	put(dir, "a b.ts", "try { g(); } catch (e) { report(e); }\n");
	git(dir, "commit", "-qam", "fix: report both failures");
	const json = join(dir, "measure.json");
	assert.equal(slop(dir, "measure", "--json", json).status, 0);
	const rule = JSON.parse(readFileSync(json, "utf8")).rules.find((/** @type {any} */ r) => r.id === "ts-swallowed-catch");
	assert.equal(rule.fixes.sitesRemoved, 2);
});

test("an AST_GREP_BIN that does not work is an error, not a quiet fall back to another ast-grep", () => {
	const found = findAstGrep(ROOT, { ...process.env, AST_GREP_BIN: "/nonexistent/ast-grep" });
	assert.equal(found.tool, null);
	assert.match(found.error, /\$AST_GREP_BIN/);
});
