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
