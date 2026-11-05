import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, test } from "node:test";
import { listSourceFiles } from "../skills/untangle-codebase/scripts/lib/files.mjs";
import { analyze, cycles } from "../skills/untangle-codebase/scripts/lib/graph.mjs";
import { coChangePairs, readHistory } from "../skills/untangle-codebase/scripts/lib/history.mjs";
import { localImports } from "../skills/untangle-codebase/scripts/lib/imports.mjs";
import { CLI, commit, gitInit, put, removeTemps, tempDir } from "./untangle-codebase-support.mjs";

after(removeTemps);

const commitsOf = (...lists) => lists.map((files) => ({ time: 0, size: files.length, files }));

test("js imports: relative, .js to .ts, index, re-export, dynamic, require; not packages or comments", () => {
	const known = new Set(["src/a.ts", "src/b.ts", "src/c/index.ts", "src/d.mjs", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts", "src/lodash.ts"]);
	const text = [
		'import x from "./b.js";',
		'import { y,\n  z } from "./c";',
		'export * from "./d.mjs";',
		'export type { T } from "./h";',
		'const e = await import("./e");',
		'const f = require("./f");',
		'// import g from "./g";',
		'import fs from "node:fs";',
		'import _ from "lodash";',
	].join("\n");
	assert.deepEqual(localImports("src/a.ts", text, known).sort(), ["src/b.ts", "src/c/index.ts", "src/d.mjs", "src/e.ts", "src/f.ts", "src/h.ts"]);
});

test("js imports: strings and templates neither hide nor invent imports", () => {
	const known = new Set(["src/a.ts", "src/b.ts", "src/c.ts", "src/foo.ts"]);
	const text = [
		'const glob = "src/*";',
		'const url = "a//b"; import { b } from "./b";',
		'const code = `import { x } from "./foo"`;',
		'const s = "require(\\"./foo\\")";',
		'const re = /\\/\\*/; import("./c"); // */',
	].join("\n");
	assert.deepEqual(localImports("src/a.ts", text, known).sort(), ["src/b.ts", "src/c.ts"]);
});

test("js imports: `..` reaches the root index file", () => {
	assert.deepEqual(localImports("src/a.ts", 'import x from "..";', new Set(["index.ts", "src/a.ts"])), ["index.ts"]);
});

test("python imports: relative, parent, parenthesized, aliases; absolute only from the root or src", () => {
	const known = new Set(["pkg/__init__.py", "pkg/a.py", "pkg/b.py", "pkg/sub/__init__.py", "pkg/sub/c.py", "pkg/sub/d.py", "pkg/sub/pkg/a.py"]);
	const text = "from . import b\nfrom .sub.c import thing\nimport pkg.a as alias, os\n";
	assert.deepEqual(localImports("pkg/a.py", text, known).sort(), ["pkg/b.py", "pkg/sub/c.py"]);
	assert.deepEqual(localImports("pkg/sub/c.py", "from .. import b\nfrom . import (\n    d,\n)\n", known).sort(), ["pkg/b.py", "pkg/sub/d.py"]);
	assert.deepEqual(localImports("pkg/sub/c.py", "import pkg.a\n", known), ["pkg/a.py"], "not pkg/sub/pkg/a.py");
	assert.deepEqual(localImports("pkg/a.py", '"""\nimport pkg.b\n"""\n', known), [], "a docstring is not an import");
});

test("cycles finds each strongly connected group once, and survives a 20,000-node chain", () => {
	const edges = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["d", ["a"]], ["e", []]]);
	assert.deepEqual(cycles(["a", "b", "c", "d", "e"], edges), [["a", "b", "c"]]);
	const n = 20000;
	const nodes = Array.from({ length: n }, (_, i) => `n${String(i).padStart(5, "0")}`);
	const chain = new Map(nodes.map((v, i) => [v, [nodes[(i + 1) % n]]]));
	assert.equal(cycles(nodes, chain)[0].length, n);
});

test("co-change pairs skip large commits by their full size and need shared commits and confidence", () => {
	const big = Array.from({ length: 30 }, (_, i) => `f${i}`);
	const pairs = coChangePairs(commitsOf(["a", "b"], ["a", "b"], ["a", "b", "c"], ["c"], ["c"], ["c"], big, big, big));
	assert.deepEqual(pairs.map((p) => [p.a, p.b, p.shared, p.confidence]), [["a", "b", 3, 1]]);
	// Two area files inside commits of 32 files: the area filter must not shrink the commit.
	const wide = Array.from({ length: 3 }, () => ({ time: 0, size: 32, files: ["x", "y"] }));
	assert.deepEqual(coChangePairs(wide), []);
});

/** A repo whose git history shows each kind of finding. Times are spread so that ages are real. */
function historyRepo() {
	const root = tempDir();
	gitInit(root);
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
		"main.ts": 'import { api } from "./src/api";\n',
	}, "start");
	for (let i = 2; i <= 5; i++) commit(root, { "src/volatile.ts": `export const v = ${i};\n` }, `volatile ${i}`);
	for (let i = 2; i <= 4; i++) commit(root, { "src/left.ts": `export const left = ${i};\n`, "src/right.ts": `export const right = ${i};\n` }, `pair ${i}`);
	// api imports impl and both change together: a visible link, not a hidden one, and not more volatile.
	for (let i = 2; i <= 4; i++) commit(root, { "src/api.ts": `import { impl } from "./impl";\nexport const api = impl + ${i};\n`, "src/impl.ts": `export const impl = ${i};\n` }, `api ${i}`);
	return root;
}

test("analyze: cycles, volatile imports, hidden links and importers outside the area", () => {
	const root = historyRepo();
	const area = join(root, "src");
	const result = analyze(area, { minAgeDays: 0 });
	assert.equal(result.files, 8);
	assert.deepEqual(result.cycles, [["ping.ts", "pong.ts"]]);
	assert.deepEqual(result.volatileImports.map((v) => [v.from, v.to]), [["stable.ts", "volatile.ts"]]);
	assert.deepEqual(result.hiddenLinks.map((p) => [p.a, p.b]), [["left.ts", "right.ts"]]);
	assert.deepEqual(result.outsideImporters, [{ from: "main.ts", to: "api.ts" }, { from: "tests/left.test.ts", to: "left.ts" }]);
	assert.match(result.head, /^[0-9a-f]{40}$/);
});

test("analyze: a young importer is not called stable", () => {
	const result = analyze(join(historyRepo(), "src"));
	assert.deepEqual(result.volatileImports, [], "every file is minutes old, under the 60-day default");
});

test("analyze by dir: hidden links are folder pairs", () => {
	const root = tempDir();
	gitInit(root);
	commit(root, { "a/x.ts": "1", "a/y.ts": "1", "b/z.ts": "1" });
	for (let i = 2; i <= 4; i++) commit(root, { "a/x.ts": `${i}`, "a/y.ts": `${i}`, "b/z.ts": `${i}` });
	const byDir = analyze(root, { by: "dir" });
	assert.deepEqual(byDir.hiddenLinks.map((p) => [p.a, p.b]), [["a", "b"]]);
});

test("history: a repo with no commits, non-ASCII paths and a subfolder", () => {
	const empty = tempDir();
	gitInit(empty);
	put(empty, { "a.ts": 'import "./b";\n', "b.ts": "" });
	assert.equal(analyze(empty).hiddenLinks, null);
	const root = tempDir();
	gitInit(root);
	for (let i = 1; i <= 4; i++) commit(root, { "my dir/café.ts": `${i}`, "my dir/a b.ts": `${i}` });
	const history = readHistory(join(root, "my dir"));
	assert.equal(history.commits.length, 4);
	assert.deepEqual(history.commits[0].files.sort(), ["a b.ts", "café.ts"]);
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

const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

test("cli graph --compare: only more files in cycles is worse; history numbers are shown, not judged", () => {
	const root = tempDir();
	gitInit(root);
	commit(root, { "src/a.ts": 'import "./b";\n', "src/b.ts": 'import "./a";\n', "src/c.ts": "", "src/d.ts": "" });
	const saved = join(root, "before.json");
	assert.equal(run(root, "graph", "src", "--save", saved).status, 0);
	for (let i = 1; i <= 3; i++) commit(root, { "src/c.ts": `${i}`, "src/d.ts": `${i}` });
	const same = run(root, "graph", "src", "--compare", saved);
	assert.equal(same.status, 0, same.stdout);
	put(root, { "src/c.ts": 'import "./d";\n', "src/d.ts": 'import "./c";\n' });
	const split = run(root, "graph", "src", "--compare", saved);
	assert.equal(split.status, 1);
	assert.match(split.stdout, /modulesInCycles\s+2 ->\s+4/);
	const wrong = run(root, "graph", "src", "--compare", join(root, "nope.json"));
	assert.equal(wrong.status, 2);
});

test("cli: special-cases --compare, bad options and bad paths", () => {
	const root = tempDir();
	put(root, { "a.ts": "export const a = 1;\n" });
	const saved = join(root, "before.json");
	assert.equal(run(root, "special-cases", ".", "--save", saved).status, 0);
	put(root, { "b.ts": "try { go(); } catch {}\n" });
	const worse = run(root, "special-cases", ".", "--compare", saved);
	assert.equal(worse.status, 1);
	assert.match(worse.stdout, /special cases: 0 -> 1 {2}\(WORSE\)/);
	assert.match(worse.stdout, /b\.ts:1/);
	const graphJson = run(root, "graph", ".", "--compare", saved);
	assert.equal(graphJson.status, 2, "a special-cases file is not a graph result");
	assert.match(graphJson.stderr, /not a saved graph result/);
	const bad = run(root, "graph", ".", "--by", "layer");
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /--by must be file or dir/);
	assert.equal(run(root, "nope").status, 2);
	const missing = run(root, "graph", "missing");
	assert.equal(missing.status, 2);
	assert.match(missing.stderr, /no such folder/);
	assert.match(run(root, "skeleton", ".").stdout, /== a\.ts \(2 lines\)/);
	assert.match(run(root, "skeleton", "b.ts").stdout, /== b\.ts/, "skeleton takes one file");
});
