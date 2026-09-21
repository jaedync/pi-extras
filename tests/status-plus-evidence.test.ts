import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceFiles, evidenceJson, evidenceLines } from "../lib/status-plus-evidence.ts";

const fixture = () => mkdtempSync(join(tmpdir(), "status-plus-evidence-"));

test("evidence cache reuses unchanged parses and invalidates appends and rewrites", () => {
	const file = join(fixture(), "session.jsonl");
	writeFileSync(file, '{"n":1}\n');
	const first = evidenceLines(file);
	assert.strictEqual(evidenceLines(file), first);
	appendFileSync(file, '{"n":');
	assert.deepEqual(evidenceLines(file), [{ n: 1 }]);
	appendFileSync(file, '2}\n');
	assert.deepEqual(evidenceLines(file), [{ n: 1 }, { n: 2 }]);
	writeFileSync(file, '{"n":3}\n');
	assert.deepEqual(evidenceLines(file), [{ n: 3 }]);
});

test("directory cache sees later publications and does not keep missing directories", () => {
	const dir = join(fixture(), "children");
	assert.deepEqual(evidenceFiles(dir), []);
	mkdirSync(dir);
	writeFileSync(join(dir, "first.json"), '{}');
	const first = evidenceFiles(dir);
	assert.strictEqual(evidenceFiles(dir), first);
	writeFileSync(join(dir, "second.json"), '{}');
	assert.deepEqual(evidenceFiles(dir), ["first.json", "second.json"]);
});

test("I/O budget bounds new reads but allows cached evidence and later retries", () => {
	const file = join(fixture(), "meta.json");
	writeFileSync(file, '{"usage":{"cost":1}}');
	assert.equal(evidenceJson(file, { bytes: 1 }), undefined);
	assert.deepEqual(evidenceJson(file, { bytes: 100 }), { usage: { cost: 1 } });
	assert.deepEqual(evidenceJson(file, { bytes: 0 }), { usage: { cost: 1 } });
});
