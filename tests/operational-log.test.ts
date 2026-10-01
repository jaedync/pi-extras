import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationalError } from "../lib/operational-log.ts";

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
