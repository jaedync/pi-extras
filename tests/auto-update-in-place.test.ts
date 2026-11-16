import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedInPlace, packageRoot } from "../lib/auto-update/in-place.ts";
import { removeTree } from "./support/auto-update-fixtures.ts";

// Ahead of the clock: the change time (ctime) of each new fixture file is now, so only the set mtimes decide.
const START = Date.now() + 10 * 86_400_000;

function file(path: string, mtimeMs: number): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x");
	utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "au-inplace-"));
	t.after(() => removeTree(root));
	const pkg = join(root, "release", "node_modules", "ext");
	file(join(pkg, "package.json"), START + 5000);
	file(join(pkg, "dist", "old.js"), START - 5000);
	file(join(pkg, "dist", "index.js"), START + 5000);
	file(join(pkg, "dist", "config.mjs"), START + 5000);
	file(join(pkg, "src", "index.ts"), START + 5000);
	file(join(pkg, ".git", "hooks", "x.js"), START + 5000);
	file(join(pkg, "node_modules", "dep", "lib.cjs"), START + 5000);
	return { root, pkg };
}

test("changedInPlace: native-loaded files newer than the start, in the package and its own dependencies; not .ts, .json or .git", (t) => {
	const { pkg } = fixture(t);
	assert.deepEqual(changedInPlace([pkg], START).map((f) => f.slice(pkg.length + 1)).sort(), ["dist/config.mjs", "dist/index.js", "node_modules/dep/lib.cjs"]);
	assert.deepEqual(changedInPlace([pkg], START + 10_000), [], "nothing newer than a later start");
});

test("changedInPlace: a loaded file path finds its package; a missing path or an empty list gives nothing", (t) => {
	const { pkg, root } = fixture(t);
	assert.equal(packageRoot(join(pkg, "dist", "index.js")), pkg);
	assert.equal(changedInPlace([join(pkg, "dist", "index.js")], START).length, 3);
	assert.deepEqual(changedInPlace([join(root, "gone")], START), []);
	assert.deepEqual(changedInPlace([], START), []);
});

test("changedInPlace: one package named twice is walked once; the result stops at the limit", (t) => {
	const { pkg } = fixture(t);
	assert.equal(changedInPlace([pkg, join(pkg, "dist", "index.js")], START).length, 3);
	assert.equal(changedInPlace([pkg], START, { maxResults: 1 }).length, 1);
});

test("changedInPlace: a symlinked folder inside a package is not followed (no loop)", (t) => {
	const { pkg } = fixture(t);
	symlinkSync(pkg, join(pkg, "dist", "loop"));
	assert.equal(changedInPlace([pkg], START).length, 3);
});
