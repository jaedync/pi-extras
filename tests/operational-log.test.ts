import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { errorText, operationalError } from "../lib/operational-log.ts";

test("the line is on disk when operationalError returns, so cleanup right after it can't race a pending write", () => {
	const dir = mkdtempSync(join(tmpdir(), "operational-log-test-"));
	try {
		const file = join(dir, "x.log");
		operationalError(file, "tag", "disposal failed");
		assert.ok(existsSync(file));
		assert.match(readFileSync(file, "utf8"), /^\[tag\] \S+ disposal failed\n$/);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		rmSync(dir, { recursive: true });
		assert.equal(existsSync(dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a log directory that no longer exists is ignored", () => {
	const dir = mkdtempSync(join(tmpdir(), "operational-log-test-"));
	rmSync(dir, { recursive: true });
	assert.doesNotThrow(() => operationalError(join(dir, "gone", "x.log"), "tag", "message"));
});

// A footer that fails on every frame must not use up the one write a minute that a poll failure needs.
test("the throttle is per kind of message, not per file", () => {
	const dir = mkdtempSync(join(tmpdir(), "operational-log-test-"));
	try {
		const file = join(dir, "x.log");
		for (let frame = 0; frame < 5; frame++) operationalError(file, "status-plus", `footer render failed: RangeError ${frame}`);
		operationalError(file, "status-plus", "anthropic limit poll failed: HTTP 429");
		operationalError(file, "other", "footer render failed: RangeError");
		const lines = readFileSync(file, "utf8").trim().split("\n");
		assert.equal(lines.length, 3, lines.join("\n"));
		assert.match(lines[0], /footer render failed: RangeError 0$/);
		assert.match(lines[1], /anthropic limit poll failed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("error text names where the error came from, with the home directory as ~", () => {
	const error = new RangeError("Invalid time value");
	error.stack = `RangeError: Invalid time value\n    at formatParts (file://${homedir()}/dev/x/lib/render.ts:361:5)\n    at resetLabel (x)`;
	assert.equal(errorText(error), "RangeError: Invalid time value (at formatParts (~/dev/x/lib/render.ts:361:5))");
	assert.equal(errorText(new Error("no stack here", {})).startsWith("Error: no stack here"), true);
	assert.equal(errorText("plain"), "plain");
});

test("error text never throws, whatever was thrown", () => {
	assert.doesNotThrow(() => errorText(Object.create(null)));
	assert.equal(typeof errorText(Object.create(null)), "string");
	const hostile = new Error("x");
	Object.defineProperty(hostile, "message", { get() { throw new Error("no"); } });
	assert.equal(typeof errorText(hostile), "string");
});

test("the home directory becomes ~ only as a path prefix, and never for a home of / or nothing", () => {
	const home = process.env.HOME;
	const frame = (path: string) => Object.assign(new Error("x"), { stack: `Error: x\n    at f (${path}:1:1)` });
	try {
		process.env.HOME = "/";
		assert.equal(errorText(frame("/usr/lib/x.ts")), "Error: x (at f (/usr/lib/x.ts:1:1))");
		process.env.HOME = "/Users/a";
		assert.equal(errorText(frame("/Users/ab/x.ts")), "Error: x (at f (/Users/ab/x.ts:1:1))");
		assert.equal(errorText(frame("/Users/a/x.ts")), "Error: x (at f (~/x.ts:1:1))");
	} finally {
		if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
	}
});
