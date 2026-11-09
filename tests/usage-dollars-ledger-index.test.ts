/**
 * The spend ledger's shared index: a new Pi process starts from the offsets
 * and records that other processes saved, so no process reads a week of
 * sessions again. These tests guard the work done (files opened, bytes read,
 * lines parsed), not the wall time, so a loaded machine does not make them flaky.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpendLedger, type SpendLedger } from "../lib/usage-dollars/ledger.ts";

const made: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 9, 10, 17);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function turn(cost: number, options: { provider?: string; model?: string; id?: string; ts?: number; pad?: string } = {}): string {
	const ts = options.ts ?? NOW - HOUR;
	return JSON.stringify({
		type: "message", id: "e", parentId: null, timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant", content: [{ type: "text", text: options.pad ?? "hi" }],
			provider: options.provider ?? "anthropic", model: options.model ?? "claude-opus-5-5",
			...(options.id ? { responseId: options.id } : {}),
			usage: { totalTokens: 10, cost: { total: cost } }, timestamp: ts,
		},
	}) + "\n";
}
/** A tool result: most of a session's bytes, and never spend. */
const toolResult = (bytes: number) => JSON.stringify({ type: "message", id: "t", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(bytes) }] } }) + "\n";

function setup() {
	const dir = tempDir("ledger-index-");
	const sessions = join(dir, "sessions");
	mkdirSync(join(sessions, "--cwd--"), { recursive: true });
	const indexFile = join(dir, "usage-dollars", "spend-index-v1.json");
	const open = (lockWaitMs?: number): SpendLedger => createSpendLedger({
		root: sessions, maxAgeMs: 8 * DAY, minRefreshMs: 0, indexFile, ...(lockWaitMs !== undefined ? { lockWaitMs } : {}),
	});
	const alone = (): SpendLedger => createSpendLedger({ root: sessions, maxAgeMs: 8 * DAY, minRefreshMs: 0 });
	return { sessions, indexFile, open, alone, file: (name: string) => join(sessions, "--cwd--", name) };
}

const totals = (ledger: SpendLedger) => ({
	anthropic: ledger.sum({ provider: "anthropic", sinceMs: 0, untilMs: NOW }),
	byProvider: ledger.byProvider(0, NOW),
	models: ledger.models("opencode-go", 0),
});

test("a new process starts from the shared index and reads no session bytes", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1.5, { id: "m1" }) + toolResult(50_000) + turn(0.25, { provider: "opencode-go", model: "glm-5.3" }));
	writeFileSync(s.file("b.jsonl"), turn(2, { id: "m2" }));
	const first = s.open();
	await first.refresh(NOW);
	assert.equal(first.stats().filesOpened, 2);
	const second = s.open();
	await second.refresh(NOW);
	assert.deepEqual(second.stats(), { filesOpened: 0, bytesRead: 0, linesParsed: 0 }, "the index already holds every byte");
	assert.deepEqual(totals(second), totals(first));
	assert.deepEqual(totals(second), { anthropic: 3.5, byProvider: { anthropic: 3.5, "opencode-go": 0.25 }, models: ["glm-5.3"] });
});

test("after an append, the next process reads only the new bytes", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "m1" }) + toolResult(100_000));
	await s.open().refresh(NOW);
	const added = turn(4, { id: "m2" });
	appendFileSync(s.file("a.jsonl"), added);
	const next = s.open();
	await next.refresh(NOW);
	assert.deepEqual(next.stats(), { filesOpened: 1, bytesRead: Buffer.byteLength(added), linesParsed: 1 });
	assert.equal(totals(next).anthropic, 5);
	// A third process finds the second one's work saved.
	const third = s.open();
	await third.refresh(NOW);
	assert.equal(third.stats().bytesRead, 0);
	assert.equal(totals(third).anthropic, 5);
});

test("processes that refresh at the same time read new bytes once: the one that waited takes the saved work", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "m1" }));
	const ledgers = [s.open(), s.open(), s.open()];
	await Promise.all(ledgers.map((ledger) => ledger.refresh(NOW)));
	const read = ledgers.reduce((total, ledger) => total + ledger.stats().bytesRead, 0);
	assert.equal(read, statSync(s.file("a.jsonl")).size, "one process read the file; the others adopted its save");
	for (const ledger of ledgers) assert.equal(totals(ledger).anthropic, 1);
});

test("copies of a response id count once; copies that differ in time count once in each range, as before", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "same", ts: NOW - 2 * HOUR }) + turn(3, { id: "fork" }));
	writeFileSync(s.file("b.jsonl"), turn(1, { id: "same", ts: NOW - 2 * HOUR }) + turn(3, { id: "fork" }));
	const ledger = s.alone();
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", sinceMs: 0, untilMs: NOW }), 4);
	// The same id at another time: each range keeps the first copy it holds.
	appendFileSync(s.file("b.jsonl"), turn(5, { id: "fork", ts: NOW - 30 * 60_000 }));
	await ledger.refresh(NOW);
	assert.equal(ledger.sum({ provider: "anthropic", sinceMs: 0, untilMs: NOW }), 4);
	assert.equal(ledger.sum({ provider: "anthropic", sinceMs: NOW - 45 * 60_000, untilMs: NOW }), 5);
	assert.deepEqual(ledger.byProvider(NOW - 45 * 60_000, NOW), { anthropic: 5 });
});

test("only lines that name a spend marker near their start are parsed", async () => {
	const s = setup();
	const marker = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: `${"y".repeat(5_000)} "role":"assistant"` }] } }) + "\n";
	writeFileSync(s.file("a.jsonl"), toolResult(10) + toolResult(20_000) + marker + turn(1) + "\n");
	const ledger = s.alone();
	await ledger.refresh(NOW);
	assert.equal(ledger.stats().linesParsed, 1, "a marker deep in a tool result is not a reason to parse it");
	assert.equal(totals(ledger).anthropic, 1);
});

test("a busy index lock does not hold the refresh: this process reads the gap itself and saves nothing", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "m1" }));
	await s.open().refresh(NOW);
	const saved = readFileSync(s.indexFile, "utf8");
	appendFileSync(s.file("a.jsonl"), turn(2, { id: "m2" }));
	// A live holder (this process's pid) keeps the lock.
	writeFileSync(`${s.indexFile}.lock`, String(process.pid));
	const blocked = s.open(50);
	const started = Date.now();
	await blocked.refresh(NOW);
	assert.ok(Date.now() - started < 5_000, `the refresh waited ${Date.now() - started} ms`);
	assert.equal(totals(blocked).anthropic, 3, "the same figures as with the lock");
	assert.equal(readFileSync(s.indexFile, "utf8"), saved, "no write without the lock");
	// Once the lock is free, the next refresh saves what this process read.
	rmSync(`${s.indexFile}.lock`);
	appendFileSync(s.file("a.jsonl"), turn(4, { id: "m3" }));
	await blocked.refresh(NOW);
	const later = s.open();
	await later.refresh(NOW);
	assert.equal(later.stats().bytesRead, 0);
	assert.equal(totals(later).anthropic, 7);
});

test("a lock left by a stopped process is taken over", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "m1" }));
	mkdirSync(join(s.indexFile, ".."), { recursive: true });
	// No process has pid 2^22 + 1 on Linux (pid_max is at most 2^22).
	writeFileSync(`${s.indexFile}.lock`, String(4_194_305));
	const ledger = s.open(50);
	await ledger.refresh(NOW);
	assert.ok(statSync(s.indexFile).size > 0, "the index was saved");
	const next = s.open();
	await next.refresh(NOW);
	assert.equal(next.stats().bytesRead, 0);
});

test("a damaged or older index is ignored and written again", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "m1" }));
	mkdirSync(join(s.indexFile, ".."), { recursive: true });
	for (const damaged of ["{not json", JSON.stringify({ v: 0, files: {} }), JSON.stringify({ v: 1, maxAgeMs: 8 * DAY, strings: [], files: { [s.file("a.jsonl")]: [1, 2] } })]) {
		writeFileSync(s.indexFile, damaged);
		const ledger = s.open();
		await ledger.refresh(NOW);
		assert.equal(ledger.stats().filesOpened, 1, damaged);
		assert.equal(totals(ledger).anthropic, 1, damaged);
	}
	const next = s.open();
	await next.refresh(NOW);
	assert.equal(next.stats().bytesRead, 0, "the rewritten index is used");
});

test("a session rewritten under the same path is read again from the start, in every process", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "m1" }) + turn(2, { id: "m2" }));
	await s.open().refresh(NOW);
	const temp = s.file("a.jsonl.tmp");
	writeFileSync(temp, turn(5, { id: "m9" }) + toolResult(500));
	renameSync(temp, s.file("a.jsonl"));
	const next = s.open();
	await next.refresh(NOW);
	assert.equal(totals(next).anthropic, 5);
});

test("an index that cannot be saved keeps the figures and says why", async () => {
	const s = setup();
	writeFileSync(s.file("a.jsonl"), turn(1, { id: "m1" }));
	// A directory in the index's place makes the rename fail.
	mkdirSync(join(s.indexFile, "blocker"), { recursive: true });
	const ledger = s.open();
	await ledger.refresh(NOW);
	assert.equal(totals(ledger).anthropic, 1);
	assert.ok(ledger.indexProblem(), "the problem is reported");
});

/** A small deterministic generator, so a failure replays. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

test("property: processes that share the index, in any order of appends and refreshes, report what one process alone reads", async () => {
	const providers = ["anthropic", "claude-code", "opencode-go", "openai-codex"];
	// Money sums in another file order can differ in the last bits; a cent is far coarser.
	const round = (value: number) => Math.round(value * 1e6) / 1e6;
	const rounded = (totals: Record<string, number>) => Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)]));
	for (let seed = 1; seed <= 40; seed++) {
		const rand = random(seed);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
		// A response id names one turn: a fork copies it whole, so a repeated id repeats the same line.
		const forked = Array.from({ length: 12 }, (_, index) => turn(Math.round(rand() * 100) / 100, {
			provider: pick(providers), id: `r${index}`, ts: NOW - Math.floor(rand() * 10) * DAY - index, pad: rand() < 0.3 ? "é漢🙂".repeat(300) : "ok",
		}));
		let unique = 0;
		const s = setup();
		const names = ["a.jsonl", "b.jsonl", "c.jsonl"];
		const ledgers = [s.open(0), s.open(0), s.open(0)];
		let partial = "";
		for (let step = 0; step < 30; step++) {
			const action = rand();
			const name = pick(names);
			if (action < 0.55) {
				// A line, sometimes split across two appends, and sometimes a tool result after it.
				const line = rand() < 0.5 ? pick(forked) : turn(Math.round(rand() * 100) / 100, {
					provider: pick(providers), ts: NOW - Math.floor(rand() * 10) * DAY - 1000 * ++unique, pad: rand() < 0.3 ? "é漢🙂".repeat(300) : "ok",
				});
				const text = line + (rand() < 0.3 ? toolResult(Math.floor(rand() * 3000)) : "");
				const cut = rand() < 0.3 ? Math.floor(rand() * text.length) : text.length;
				appendFileSync(s.file(name), partial + text.slice(0, cut));
				partial = text.slice(cut);
			} else if (action < 0.6) {
				// A rewrite: Pi replaces a session file by a rename.
				const temp = s.file(`${name}.tmp`);
				writeFileSync(temp, pick(forked));
				renameSync(temp, s.file(name));
			} else {
				// One or several processes refresh at once.
				const group = ledgers.filter(() => rand() < 0.6);
				await Promise.all(group.map((ledger) => ledger.refresh(NOW)));
			}
		}
		const alone = s.alone();
		await Promise.all([...ledgers, alone].map((ledger) => ledger.refresh(NOW)));
		const fresh = s.open();
		await fresh.refresh(NOW);
		const sums = (ledger: SpendLedger) => providers.map((provider) => round(ledger.sum({ provider, sinceMs: NOW - 7 * DAY, untilMs: NOW })));
		for (const ledger of [...ledgers, fresh]) {
			assert.deepEqual(sums(ledger), sums(alone), `seed ${seed}`);
			assert.deepEqual(rounded(ledger.byProvider(0, NOW)), rounded(alone.byProvider(0, NOW)), `seed ${seed}`);
		}
	}
});
