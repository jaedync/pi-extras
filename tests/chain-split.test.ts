import assert from "node:assert/strict";
import test from "node:test";
import { splitChain, MAX_STEPS } from "../lib/chain/split.ts";

const steps = (command: string) => splitChain(command)?.steps.map((step) => [step.op, step.text]);

test("commands joined by && become steps", () => {
	assert.deepEqual(steps("npm run lint && npm test && npm run build"), [[null, "npm run lint"], ["&&", "npm test"], ["&&", "npm run build"]]);
});

test("||, ; and newlines separate steps too, and blank lines are dropped", () => {
	assert.deepEqual(steps("grep -q NOPE a.ts || echo \"no NOPE\""), [[null, "grep -q NOPE a.ts"], ["||", "echo \"no NOPE\""]]);
	assert.deepEqual(steps("a; b\n\nc\n"), [[null, "a"], [";", "b"], [";", "c"]]);
});

test("a leading cd is marked as a location", () => {
	const chain = splitChain("cd src && npm test && npm run build");
	assert.equal(chain?.cd, "src");
	assert.deepEqual(chain?.steps.map((step) => step.cd === true), [true, false, false]);
	assert.equal(splitChain("cd \"my dir\" && make && make test")?.cd, "my dir");
	assert.equal(splitChain("cd $(git rev-parse --show-toplevel) && make && make test")?.cd, undefined);
});

test("a single command is not a chain", () => {
	assert.equal(splitChain("npm test"), undefined);
	assert.equal(splitChain("  npm test  \n"), undefined);
	assert.equal(splitChain(""), undefined);
});

test("operators inside quotes, substitutions, groups and tests stay in their step", () => {
	assert.deepEqual(steps("echo \"a && b\"; echo 'c || d'"), [[null, "echo \"a && b\""], [";", "echo 'c || d'"]]);
	assert.deepEqual(steps("echo $(a && b) && c"), [[null, "echo $(a && b)"], ["&&", "c"]]);
	assert.deepEqual(steps("echo `a && b` && c"), [[null, "echo `a && b`"], ["&&", "c"]]);
	assert.deepEqual(steps("(cd x && make) && echo ok"), [[null, "(cd x && make)"], ["&&", "echo ok"]]);
	assert.deepEqual(steps("{ a; b; } && c"), [[null, "{ a; b; }"], ["&&", "c"]]);
	assert.deepEqual(steps("[[ -f a && -f b ]] && c"), [[null, "[[ -f a && -f b ]]"], ["&&", "c"]]);
	assert.deepEqual(steps("echo ${x:-a;b} && c"), [[null, "echo ${x:-a;b}"], ["&&", "c"]]);
	assert.deepEqual(steps("echo $((1 && 2)) && c"), [[null, "echo $((1 && 2))"], ["&&", "c"]]);
	assert.deepEqual(steps("echo $'it\\'s; fine' && c"), [[null, "echo $'it\\'s; fine'"], ["&&", "c"]]);
	assert.deepEqual(steps("echo a\\;b && c"), [[null, "echo a\\;b"], ["&&", "c"]]);
});

test("pipes and redirections belong to their step", () => {
	assert.deepEqual(steps("a | b && c"), [[null, "a | b"], ["&&", "c"]]);
	assert.deepEqual(steps("a 2>&1 | tail -5 && b &> log"), [[null, "a 2>&1 | tail -5"], ["&&", "b &> log"]]);
	assert.deepEqual(steps("a |& b; c <<< 'x; y'"), [[null, "a |& b"], [";", "c <<< 'x; y'"]]);
});

test("a line break after an operator continues the chain", () => {
	assert.deepEqual(steps("a &&\n  b ||\n\n c"), [[null, "a"], ["&&", "b"], ["||", "c"]]);
	assert.deepEqual(steps("a \\\n  --flag && b"), [[null, "a \\\n  --flag"], ["&&", "b"]]);
});

test("comments stay with their line and never split", () => {
	assert.deepEqual(steps("# setup\na # not && split\nb"), [[null, "a # not && split"], [";", "b"]]);
	assert.deepEqual(steps("echo a#b && c"), [[null, "echo a#b"], ["&&", "c"]]);
});

test("anything the splitter doesn't fully understand is left alone", () => {
	for (const command of [
		"cat <<EOF\nx && y\nEOF",
		"sleep 1 & wait",
		"for i in 1 2; do echo $i; done",
		"if true; then a; fi && b",
		"while read l; do echo $l; done < f",
		"case $x in a) echo a;; esac",
		"f() { a; } && f",
		"function f { a; } ; f",
		"a && exit 1",
		"set -e; a; b",
		"trap 'rm x' EXIT; a; b",
		"a; exec b",
		"false | true; echo ${PIPESTATUS[0]}",
		"a; echo $_",
		"echo $LINENO; b",
		"echo \"unterminated && b",
		"echo (a && b",
		"a ) && b",
	]) {
		assert.equal(splitChain(command), undefined, command);
	}
});

test("very long scripts are left alone", () => {
	const script = Array.from({ length: MAX_STEPS + 1 }, (_, index) => `echo ${index}`).join("\n");
	assert.equal(splitChain(script), undefined);
	const fits = Array.from({ length: MAX_STEPS }, (_, index) => `echo ${index}`).join("\n");
	assert.equal(splitChain(fits)?.steps.length, MAX_STEPS);
});

test("steps record where they sit in the command", () => {
	const command = "  a &&  b  ";
	const chain = splitChain(command)!;
	assert.deepEqual(chain.steps.map((step) => command.slice(step.start, step.end)), ["a", "b"]);
});
