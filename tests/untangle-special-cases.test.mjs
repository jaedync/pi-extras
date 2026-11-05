import assert from "node:assert/strict";
import { test } from "node:test";
import { lex } from "../skills/untangle-codebase/scripts/lib/lex.mjs";
import { skeletonOf } from "../skills/untangle-codebase/scripts/lib/skeleton.mjs";
import { compare, scanText, summarize } from "../skills/untangle-codebase/scripts/lib/special-cases.mjs";

const ids = (file, text) => scanText(file, text).map((h) => h.category);

test("lex keeps length and line breaks, blanks strings in code and keeps only comments in comments", () => {
	const text = 'const a = "x // y"; // note\nconst t = `a ${b} c`; /* d\n e */ const r = /"/g;';
	const { code, comments } = lex(text, "js");
	assert.equal(code.length, text.length);
	assert.equal(comments.length, text.length);
	assert.deepEqual(code.split("\n").length, 3);
	assert.match(code, /const a = " {6}";/);
	assert.doesNotMatch(code, /note|x \/\/ y| d$/m);
	assert.match(comments, /\/\/ note/);
	assert.match(comments, /\/\* d\n e \*\//);
	assert.match(code, /const r = \/ \/g;/, "a regex literal is not a string start");
	const py = lex('x = "#no"  # yes\ns = """\nretry\n"""\n', "py");
	assert.doesNotMatch(py.code, /retry|yes|#no/);
	assert.match(py.comments, /# yes/);
});

test("special cases: each category fires on its shape", () => {
	assert.deepEqual(ids("a.ts", "try { go(); } catch {}"), ["swallowed-error"]);
	assert.deepEqual(ids("a.ts", "try {\n  go();\n} catch (error) {\n  // fine\n}\n"), ["swallowed-error"]);
	assert.deepEqual(ids("a.ts", "try {\n  return read();\n} catch {\n  return undefined;\n}\n"), ["swallowed-error"]);
	assert.deepEqual(ids("a.ts", "p.catch(() => {});"), ["swallowed-error"]);
	assert.deepEqual(ids("a.py", "try:\n    go()\nexcept Exception:\n    pass\n"), ["swallowed-error"]);
	assert.deepEqual(ids("a.ts", "setTimeout(() => focus(), 100);"), ["sleep-or-retry"]);
	assert.deepEqual(ids("a.ts", "for (let attempt = 0; attempt < maxRetries; attempt++) {"), ["sleep-or-retry"]);
	assert.deepEqual(ids("a.py", "time.sleep(0.5)"), ["sleep-or-retry"]);
	assert.deepEqual(ids("a.test.ts", 'test.skip("x", () => {});'), ["disabled-test"]);
	assert.deepEqual(ids("a.test.ts", 'test("x", { skip: "flaky" }, () => {});'), ["disabled-test"]);
	assert.deepEqual(ids("a.ts", "// @ts-ignore\nconst x = y as any;"), ["suppression", "suppression"]);
	assert.deepEqual(ids("a.ts", "// TODO remove after the proxy update"), ["workaround-note"]);
	assert.deepEqual(ids("a.ts", 'if (order.provider === "paypal") {'), ["literal-branch"]);
});

test("special cases: prose, strings and normal code do not fire", () => {
	assert.deepEqual(ids("a.ts", "// works the same as any other tool"), []);
	assert.deepEqual(ids("a.ts", "// Note: any value is fine"), []);
	assert.deepEqual(ids("a.ts", "// a retry here would hide the error"), []);
	assert.deepEqual(ids("a.ts", 'throw new Error("retry the call later");'), []);
	assert.deepEqual(ids("a.ts", 'const fixture = "try { go(); } catch {}";'), []);
	assert.deepEqual(ids("a.ts", "const s = `test.skip(x)`;"), []);
	assert.deepEqual(ids("a.ts", "// a todo list is fine"), []);
	assert.deepEqual(ids("a.ts", "try { go(); } catch (error) { log(error); }"), []);
	assert.deepEqual(ids("a.ts", "const value = compute(input);"), []);
	assert.deepEqual(ids("a.md", "catch {}"), [], "only source languages are read");
});

test("compare: literal-branch stays out of the total; a new copy of an old line is a new hit", () => {
	const before = summarize([...scanText("a.ts", 'if (kind === "x") go();'), ...scanText("b.ts", "catch {}")], 2);
	assert.equal(before.total, 1);
	const after = summarize([...before.hits, ...scanText("b.ts", "\n\ncatch {}")], 2);
	const diff = compare(before, after);
	assert.equal(diff.worse, true);
	assert.deepEqual(diff.added.map((h) => [h.file, h.line]), [["b.ts", 3]]);
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
	assert.match(out, /^10\| {3}private open\(\): void \{/m);
	assert.doesNotMatch(out, /input\.length|return x|this\.state/);
	assert.match(out, /…/);
});

test("skeleton keeps multi-line signatures, constructors and type members; JSDoc does not set the indent", () => {
	const text = [
		"/**",
		" * Docs.",
		" */",
		"export function run(",
		"  input: string,",
		"  options: Options,",
		"): number {",
		"  return 0;",
		"}",
		"export interface Options {",
		"  depth: number;",
		"  name?: string;",
		"}",
		"export type Phase =",
		'  | "idle"',
		'  | "busy";',
		"class Store {",
		"  constructor(private db: Db) {}",
		"  get(): void {",
		"    if (x) {",
		"      deep();",
		"    }",
		"  }",
		"}",
	].join("\n");
	const out = skeletonOf(text).join("\n");
	for (const kept of ["input: string,", "options: Options,", "): number {", "depth: number;", "name?: string;", '| "idle"', '| "busy";', "constructor(private db: Db) {}"]) {
		assert.ok(out.includes(kept), `kept: ${kept}\n${out}`);
	}
	assert.doesNotMatch(out, /return 0|deep\(\)/);
	const deeper = skeletonOf(text, { depth: 1 }).join("\n");
	assert.match(deeper, /return 0;/, "depth 1 keeps the first level of a function body");
	assert.doesNotMatch(deeper, /if \(x\)|deep\(\)/);
	assert.match(skeletonOf(text, { depth: 2 }).join("\n"), /if \(x\) \{/);
});

test("skeleton reads Python and tabs", () => {
	const py = skeletonOf("class A:\n    def run(self, x):\n        return x\n\ndef top():\n    pass\n").join("\n");
	assert.match(py, /class A:/);
	assert.match(py, /def run\(self, x\):/);
	assert.match(py, /def top\(\):/);
	assert.doesNotMatch(py, /return x|pass/);
	const tabs = skeletonOf("function a() {\n\tconst b = 1;\n\tfunction inner() {\n\t\treturn b;\n\t}\n}\n").join("\n");
	assert.match(tabs, /function inner\(\)/);
	assert.doesNotMatch(tabs, /const b|return b/);
});
