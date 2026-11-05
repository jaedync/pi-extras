import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listSourceFiles } from "../skills/untangle-codebase/scripts/lib/files.mjs";
import { analyze, cycles } from "../skills/untangle-codebase/scripts/lib/graph.mjs";
import { coChangePairs } from "../skills/untangle-codebase/scripts/lib/history.mjs";
import { localImports } from "../skills/untangle-codebase/scripts/lib/imports.mjs";
import { skeletonOf } from "../skills/untangle-codebase/scripts/lib/skeleton.mjs";
import { compare, scanText, summarize } from "../skills/untangle-codebase/scripts/lib/special-cases.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../skills/untangle-codebase/scripts/untangle.mjs");
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "untangle-test-"));
	temps.push(dir);
	return dir;
}

function put(root, files) {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}

const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

function commit(root, files, message) {
	put(root, files);
	git(root, "add", "-A");
	git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", message);
}

const ids = (file, text) => scanText(file, text).map((h) => h.category);

test("js imports: relative, .js to .ts, index, re-export, dynamic, require; not packages or comments", () => {
	const known = new Set(["src/a.ts", "src/b.ts", "src/c/index.ts", "src/d.mjs", "src/e.ts", "src/f.ts", "src/g.ts", "src/lodash.ts"]);
	const text = [
		'import x from "./b.js";',
		'import { y,\n  z } from "./c";',
		'export * from "./d.mjs";',
		'const e = await import("./e");',
		'const f = require("./f");',
		'// import g from "./g";',
		'import fs from "node:fs";',
		'import _ from "lodash";',
		'import type { T } from "./a";',
	].join("\n");
	assert.deepEqual(localImports("src/a.ts", text, known).sort(), ["src/b.ts", "src/c/index.ts", "src/d.mjs", "src/e.ts", "src/f.ts"]);
});

test("python imports: relative modules, `from . import name` and absolute package paths", () => {
	const known = new Set(["pkg/__init__.py", "pkg/a.py", "pkg/b.py", "pkg/sub/c.py", "pkg/sub/__init__.py"]);
	const text = "from . import b\nfrom .sub.c import thing\nimport pkg.a\nimport os\n";
	assert.deepEqual(localImports("pkg/a.py", text, known).sort(), ["pkg/b.py", "pkg/sub/c.py"]);
	assert.deepEqual(localImports("pkg/b.py", "import pkg.a\n", known), ["pkg/a.py"]);
});

test("cycles finds each strongly connected group once, with no single nodes", () => {
	const edges = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["d", ["a"]], ["e", []]]);
	assert.deepEqual(cycles(["a", "b", "c", "d", "e"], edges), [["a", "b", "c"]]);
});

test("co-change pairs skip large commits and need shared commits and confidence", () => {
	const big = Array.from({ length: 30 }, (_, i) => `f${i}`);
	const commits = [["a", "b"], ["a", "b"], ["a", "b", "c"], ["c"], ["c"], ["c"], big, big, big];
	const pairs = coChangePairs(commits);
	assert.deepEqual(pairs.map((p) => [p.a, p.b, p.shared, p.confidence]), [["a", "b", 3, 1]]);
});

test("analyze: a cycle, an import of volatile code and a hidden link in a real git history", () => {
	const root = tempDir();
	git(root, "init", "-q");
	commit(root, {
		"src/stable.ts": 'import { v } from "./volatile";\nexport const s = v;\n',
		"src/volatile.ts": "export const v = 1;\n",
		"src/ping.ts": 'import { pong } from "./pong";\nexport const ping = () => pong;\n',
		"src/pong.ts": 'import { ping } from "./ping";\nexport const pong = () => ping;\n',
		"src/left.ts": "export const left = 1;\n",
		"src/right.ts": "export const right = 1;\n",
		"src/api.ts": 'import { impl } from "./impl";\nexport const api = impl;\n',
		"src/impl.ts": "export const impl = 1;\n",
		"tests/left.test.ts": 'import { left } from "../src/left";\n',
	}, "start");
	for (let i = 2; i <= 5; i++) commit(root, { "src/volatile.ts": `export const v = ${i};\n` }, `volatile ${i}`);
	for (let i = 2; i <= 4; i++) commit(root, { "src/left.ts": `export const left = ${i};\n`, "src/right.ts": `export const right = ${i};\n` }, `pair ${i}`);
	// api imports impl and both change together: a visible link, not a hidden one, and not more volatile.
	for (let i = 2; i <= 4; i++) commit(root, { "src/api.ts": `import { impl } from "./impl";\nexport const api = impl + ${i};\n`, "src/impl.ts": `export const impl = ${i};\n` }, `api ${i}`);
	const result = analyze(root);
	assert.equal(result.files, 8, "tests are left out by default");
	assert.deepEqual(result.cycles, [["src/ping.ts", "src/pong.ts"]]);
	assert.deepEqual(result.volatileImports.map((v) => [v.from, v.to]), [["src/stable.ts", "src/volatile.ts"]]);
	assert.deepEqual(result.hiddenLinks.map((p) => [p.a, p.b]), [["src/left.ts", "src/right.ts"]]);
	const byDir = analyze(root, { by: "dir", includeTests: true });
	assert.deepEqual(byDir.modulesTable.map((m) => m.name), ["src", "tests"]);
	assert.deepEqual(byDir.modulesTable.find((m) => m.name === "tests").imports, ["src"]);
});

test("analyze works outside git: no history numbers, graph still built", () => {
	const root = tempDir();
	put(root, { "a.js": 'import "./b.js";\n', "b.js": 'import "./a.js";\n', "node_modules/x/index.js": "" });
	const result = analyze(root);
	assert.equal(result.files, 2);
	assert.equal(result.volatileImports, null);
	assert.equal(result.hiddenLinks, null);
	assert.deepEqual(result.cycles, [["a.js", "b.js"]]);
	assert.deepEqual(listSourceFiles(root), ["a.js", "b.js"]);
});

test("special cases: each category fires on its shape", () => {
	assert.deepEqual(ids("a.ts", "try { go(); } catch {}"), ["swallowed-error"]);
	assert.deepEqual(ids("a.ts", "try {\n  go();\n} catch (error) {\n  // fine\n}\n"), ["swallowed-error"]);
	assert.deepEqual(ids("a.ts", "p.catch(() => {});"), ["swallowed-error"]);
	assert.deepEqual(ids("a.py", "try:\n    go()\nexcept Exception:\n    pass\n"), ["swallowed-error"]);
	assert.deepEqual(ids("a.ts", "setTimeout(() => focus(), 100);"), ["sleep-or-retry"]);
	assert.deepEqual(ids("a.py", "time.sleep(0.5)"), ["sleep-or-retry"]);
	assert.deepEqual(ids("a.test.ts", 'test.skip("x", () => {});'), ["disabled-test"]);
	assert.deepEqual(ids("a.ts", "// @ts-ignore\nconst x = y as any;"), ["suppression", "suppression"]);
	assert.deepEqual(ids("a.ts", "// TODO remove after the proxy update"), ["workaround-note"]);
	assert.deepEqual(ids("a.ts", 'if (order.provider === "paypal") {'), ["literal-branch"]);
});

test("special cases: prose and normal code do not fire", () => {
	assert.deepEqual(ids("a.ts", "// works the same as any other tool"), []);
	assert.deepEqual(ids("a.ts", "// Note: any value is fine"), []);
	assert.deepEqual(ids("a.ts", "try { go(); } catch (error) { log(error); }"), []);
	assert.deepEqual(ids("a.ts", "const value = compute(input);"), []);
	assert.deepEqual(ids("a.md", "catch {}"), [], "only source languages are read");
});

test("compare: the literal-branch signal stays out of the total; a new hit makes it worse", () => {
	const before = summarize(scanText("a.ts", 'if (kind === "x") go();'), 1);
	assert.equal(before.total, 0);
	const after = summarize([...before.hits, ...scanText("b.ts", "catch {}")], 2);
	const diff = compare(before, after);
	assert.equal(diff.worse, true);
	assert.deepEqual(diff.added.map((h) => h.file), ["b.ts"]);
	assert.equal(compare(after, before).worse, false);
});

test("skeleton keeps declarations with line numbers and leaves out bodies", () => {
	const text = [
		'import { a } from "./a";',
		"export function run(input: string): number {",
		"  const x = input.length;",
		"  if (x > 2) {",
		"    return x;",
		"  }",
		"  return 0;",
		"}",
		"export class Box {",
		"  private open(): void {",
		"    this.state = 1;",
		"  }",
		"}",
	].join("\n");
	const out = skeletonOf(text).join("\n");
	assert.match(out, /^ 1\| import/m);
	assert.match(out, /^ 2\| export function run/m);
	assert.match(out, /^10\|   private open\(\): void \{/m);
	assert.doesNotMatch(out, /input\.length|return x|this\.state/);
	assert.match(out, /…/);
});

test("cli: special-cases --compare exits 1 when the total goes up; bad options exit 2", () => {
	const root = tempDir();
	put(root, { "a.ts": "export const a = 1;\n" });
	const saved = join(root, "before.json");
	const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
	assert.equal(run("special-cases", ".", "--save", saved).status, 0);
	put(root, { "b.ts": "try { go(); } catch {}\n" });
	const worse = run("special-cases", ".", "--compare", saved);
	assert.equal(worse.status, 1);
	assert.match(worse.stdout, /special cases: 0 -> 1 {2}\(WORSE\)/);
	assert.match(worse.stdout, /b\.ts:1/);
	const bad = run("graph", ".", "--by", "layer");
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /--by must be file or dir/);
	assert.equal(run("nope").status, 2);
	assert.match(run("skeleton", ".").stdout, /== a\.ts \(2 lines\)/);
});
