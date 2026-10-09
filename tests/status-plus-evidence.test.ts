import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceFiles, evidenceJson, evidenceLines, type EvidenceBudget } from "../lib/status-plus-evidence.ts";

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

test("a changed file the walk cannot afford keeps what an earlier walk read, and says it waited", () => {
	const dir = fixture();
	const meta = join(dir, "meta.json");
	writeFileSync(meta, '{"usage":{"cost":1}}');
	assert.deepEqual(evidenceJson(meta, { bytes: 100 }), { usage: { cost: 1 } });
	writeFileSync(meta, '{"usage":{"cost":2.5}}');
	const poor: EvidenceBudget = { bytes: 1 };
	assert.deepEqual(evidenceJson(meta, poor), { usage: { cost: 1 } });
	assert.equal(poor.deferred, true);
	assert.deepEqual(evidenceJson(meta, { bytes: 100 }), { usage: { cost: 2.5 } });

	const session = join(dir, "session.jsonl");
	writeFileSync(session, '{"n":1}\n');
	assert.deepEqual(evidenceLines(session, { bytes: 100 }), [{ n: 1 }]);
	appendFileSync(session, '{"n":2}\n');
	const broke: EvidenceBudget = { bytes: 1 };
	assert.deepEqual(evidenceLines(session, broke), [{ n: 1 }]);
	assert.equal(broke.deferred, true);
	assert.deepEqual(evidenceLines(session, { bytes: 100 }), [{ n: 1 }, { n: 2 }]);
});

test("a transcript is read on from where the last read stopped, and from the start after a rewrite", () => {
	const file = join(fixture(), "session.jsonl");
	writeFileSync(file, `${JSON.stringify({ n: 1, pad: "x".repeat(1000) })}\n`);
	const first = evidenceLines(file, { bytes: 2000 }) as Array<{ n: number }>;
	appendFileSync(file, '{"n":2}\n');
	const budget: EvidenceBudget = { bytes: 100 };
	const next = evidenceLines(file, budget) as Array<{ n: number }>;
	assert.deepEqual(next.map((record) => record.n), [1, 2]);
	assert.equal(budget.bytes, 100 - 8);
	assert.strictEqual(next[0], first[0]);
	// Same file, longer, but not an append: the bytes before the old end changed.
	writeFileSync(file, `${JSON.stringify({ n: 3, pad: "y".repeat(1000) })}\n{"n":4}\n{"n":5}\n`);
	assert.deepEqual((evidenceLines(file) as Array<{ n: number }>).map((record) => record.n), [3, 4, 5]);
});

test("a last line with no newline yet counts once it parses, and only once", () => {
	const file = join(fixture(), "session.jsonl");
	writeFileSync(file, '{"n":1}');
	assert.deepEqual(evidenceLines(file), [{ n: 1 }]);
	appendFileSync(file, '\n{"n":2}\n');
	assert.deepEqual(evidenceLines(file), [{ n: 1 }, { n: 2 }]);
});

test("a rewrite in place that keeps the bytes before the old end is still read from the start", () => {
	const file = join(fixture(), "session.jsonl");
	const line = JSON.stringify({ n: 2, pad: "z".repeat(100) });
	writeFileSync(file, `{"type":"session","v":1}\n${line}\n`);
	const values = () => (evidenceLines(file) as Array<{ v?: number; n?: number }>).map((record) => record.v ?? record.n);
	assert.deepEqual(values(), [1, 2]);
	writeFileSync(file, `{"type":"session","v":9}\n${line}\n{"n":3}\n`);
	assert.deepEqual(values(), [9, 2, 3]);
});

test("what a new process cannot read is not read here either: deleted files and files over the size limit", () => {
	const dir = fixture();
	const session = join(dir, "session.jsonl");
	writeFileSync(session, '{"n":1}\n');
	assert.deepEqual(evidenceLines(session), [{ n: 1 }]);
	unlinkSync(session);
	assert.equal(evidenceLines(session), undefined);

	const meta = join(dir, "meta.json");
	writeFileSync(meta, '{"usage":{"cost":1}}');
	assert.deepEqual(evidenceJson(meta), { usage: { cost: 1 } });
	// Caught mid-write: the earlier value stays.
	writeFileSync(meta, '{"usage":');
	assert.deepEqual(evidenceJson(meta), { usage: { cost: 1 } });
	unlinkSync(meta);
	assert.equal(evidenceJson(meta), undefined);

	const grown = join(dir, "grown.jsonl");
	writeFileSync(grown, '{"n":1}\n');
	assert.deepEqual(evidenceLines(grown), [{ n: 1 }]);
	truncateSync(grown, 51 * 1024 * 1024);
	assert.equal(evidenceLines(grown), undefined);
});

test("evidence a walk still reads stays cached while newer entries push older ones out", () => {
	const dir = fixture();
	const hot = join(dir, "hot.json");
	writeFileSync(hot, '{"hot":true}');
	assert.deepEqual(evidenceJson(hot), { hot: true });
	for (let i = 0; i < 4200; i++) {
		const file = join(dir, `cold-${i}.json`);
		writeFileSync(file, "{}");
		evidenceJson(file);
		if (i % 1000 === 0) evidenceJson(hot);
	}
	assert.deepEqual(evidenceJson(hot, { bytes: 0 }), { hot: true });
});

test("a projection keeps only what its caller reads", () => {
	const file = join(fixture(), "session.jsonl");
	writeFileSync(file, '{"n":1,"text":"long"}\n{"n":2}\n');
	const keep = (record: unknown) => (record as { n: number }).n === 2 ? undefined : { n: (record as { n: number }).n };
	assert.deepEqual(evidenceLines(file, undefined, keep), [{ n: 1 }]);
});

test("I/O budget bounds new reads but allows cached evidence and later retries", () => {
	const file = join(fixture(), "meta.json");
	writeFileSync(file, '{"usage":{"cost":1}}');
	assert.equal(evidenceJson(file, { bytes: 1 }), undefined);
	assert.deepEqual(evidenceJson(file, { bytes: 100 }), { usage: { cost: 1 } });
	assert.deepEqual(evidenceJson(file, { bytes: 0 }), { usage: { cost: 1 } });
});
