import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildIndex, type IndexIO } from "../lib/subagents/restore.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const record = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
	name: "helper", parent: "main", depth: 1, model: "faux/cheap", task: "Check files", readOnly: false,
	fork: false, blocking: false, state: "idle", createdAt: 1, activity: null, runs: 1, toolCalls: 0, usage: NO_USAGE, ...patch,
});

/** A durable write that the test finishes by hand, in any order, so every order of events can be tried. */
class HeldWrites implements IndexIO {
	readonly held: Array<{ file: string; text: string; finish: () => void; fail: (error: Error) => void }> = [];
	started = 0;
	maxInFlight = 0;

	writeDurable(file: string, text: string): Promise<void> {
		this.started++;
		return new Promise((resolve, reject) => {
			this.held.push({
				file, text,
				// The real write puts the file on disk before it resolves; so does this one.
				finish: () => { writeFileNow(file, text); resolve(); },
				fail: (error) => reject(error),
			});
			this.maxInFlight = Math.max(this.maxInFlight, this.held.length);
		});
	}

	/** Ends the oldest held write and lets its continuation run. */
	async finishNext(ok = true): Promise<void> {
		const write = this.held.shift();
		if (!write) return;
		if (ok) write.finish();
		else write.fail(new Error("disk full"));
		await settle();
	}
}

function writeFileNow(file: string, text: string): void { writeFileSync(file, text, { flag: "wx", mode: 0o600 }); }

/** Lets promise continuations run (several hops: then, catch, finally, the next write). */
async function settle(): Promise<void> { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); }

function scratch(t: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "child-index-write-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const savedTasks = (dir: string): string[] => existsSync(join(dir, "index.json"))
	? (JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).records as AgentRecord[]).map((r) => r.task) : [];
const temporaries = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
const failOnError = (error: unknown) => assert.fail(`unexpected save error: ${String(error)}`);

test("update returns before the durable write ends, and the index is on disk after it", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	index.update([record({ task: "first" })], failOnError);
	assert.equal(io.started, 1, "the durable write goes through the async path");
	assert.deepEqual(savedTasks(dir), [], "nothing is renamed into place before the write ends");
	await io.finishNext();
	assert.deepEqual(savedTasks(dir), ["first"]);
	assert.deepEqual(temporaries(dir), []);
});

test("a write in flight never replaces a newer synchronous save", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	index.update([record({ task: "older" })], failOnError);
	index.save([record({ task: "newer" })], "reload", "owner");
	await io.finishNext();
	await index.flush();
	assert.deepEqual(savedTasks(dir), ["newer"]);
	assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).shutdown, "reload");
	assert.deepEqual(temporaries(dir), []);
});

test("updates during a write merge into one next write of the newest records", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	index.update([record({ task: "a" })], failOnError);
	index.update([record({ task: "b" })], failOnError);
	index.update([record({ task: "c" })], failOnError);
	assert.equal(io.started, 1);
	await io.finishNext();
	assert.equal(io.started, 2);
	await io.finishNext();
	assert.deepEqual(savedTasks(dir), ["c"]);
	assert.equal(io.started, 2);
	assert.equal(io.maxInFlight, 1);
});

test("a failed write is reported once, leaves no temporary file, and the next update writes again", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	const errors: string[] = [];
	index.update([record({ task: "lost" })], (error) => errors.push((error as Error).message));
	await io.finishNext(false);
	assert.deepEqual(errors, ["disk full"]);
	assert.deepEqual(temporaries(dir), []);
	index.update([record({ task: "lost" })], failOnError);
	assert.equal(io.started, 2, "a failed write does not count as saved, so the same records write again");
	await io.finishNext();
	assert.deepEqual(savedTasks(dir), ["lost"]);
});

test("an error handler that throws (a stale UI after reload) does not break later writes", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	index.update([record({ task: "x" })], () => { throw new Error("stale ctx"); });
	await io.finishNext(false);
	index.update([record({ task: "y" })], failOnError);
	await io.finishNext();
	assert.deepEqual(savedTasks(dir), ["y"]);
});

test("a load during this process's own write keeps that write's temporary file", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	const errors: unknown[] = [];
	index.update([record({ task: "first" })], (error) => errors.push(error));
	writeFileSync(join(dir, "index.json.999.stray.tmp"), "left by a crash");
	// The held write has not made its file; make it as a real write in flight would have.
	const inFlight = io.held[0]!.file;
	writeFileSync(inFlight, "");
	index.load((message) => assert.fail(message));
	assert.ok(existsSync(inFlight), "the temporary file of the write in flight is kept");
	assert.equal(existsSync(join(dir, "index.json.999.stray.tmp")), false, "a stale one is removed");
	rmSync(inFlight);
	await io.finishNext();
	assert.equal(io.held.length, 0);
	assert.deepEqual(errors, []);
	assert.deepEqual(savedTasks(dir), ["first"]);
});

test("after a /reload, an older write of the old module's index never replaces the new module's save", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const old = new ChildIndex(dir, "parent-1", dir, io);
	old.update([record({ task: "queued" })], failOnError);
	// The next module's index is another object for the same file.
	const next = new ChildIndex(dir, "parent-1", dir, io);
	next.save([record({ task: "running" })]);
	await io.finishNext();
	assert.deepEqual(savedTasks(dir), ["running"]);
});

test("of two indexes' writes in flight for one file, the one that started last wins", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const old = new ChildIndex(dir, "parent-1", dir, io);
	const next = new ChildIndex(dir, "parent-1", dir, io);
	old.update([record({ task: "older" })], failOnError);
	next.update([record({ task: "newer" })], failOnError);
	const [first, second] = io.held.splice(0, 2);
	second!.finish();
	await settle();
	first!.finish();
	await settle();
	assert.deepEqual(savedTasks(dir), ["newer"]);
	assert.deepEqual(temporaries(dir), []);
});

test("a load by another index object keeps the temporary file of a write in flight in this process", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const errors: unknown[] = [];
	new ChildIndex(dir, "parent-1", dir, io).update([record({ task: "first" })], (error) => errors.push(error));
	const inFlight = io.held[0]!.file;
	writeFileSync(inFlight, "");
	new ChildIndex(dir, "parent-1", dir, io).load((message) => assert.fail(message));
	assert.ok(existsSync(inFlight));
	rmSync(inFlight);
	await io.finishNext();
	assert.deepEqual(errors, []);
});

test("a synchronous save that fails does not cancel the background write or the change waiting for it", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	const errors: unknown[] = [];
	index.update([record({ task: "running" })], (error) => errors.push(error));
	index.update([record({ task: "done" })], (error) => errors.push(error));
	chmodSync(dir, 0o500);
	try { assert.throws(() => index.save([record({ task: "saved" })]), /EACCES/); }
	finally { chmodSync(dir, 0o700); }
	await io.finishNext();
	assert.deepEqual(savedTasks(dir), ["running"], "the write in flight still lands");
	await io.finishNext();
	assert.deepEqual(savedTasks(dir), ["done"], "the change that waited for it is written next");
	assert.deepEqual(errors, []);
});

test("flush writes a change that only waits for the 5-second throttle", async (t) => {
	const dir = scratch(t);
	const io = new HeldWrites();
	const index = new ChildIndex(dir, "parent-1", dir, io);
	index.update([record({ task: "t", activity: "one" })], failOnError);
	await io.finishNext();
	// Activity alone does not change the state signature, so this one waits for the throttle.
	index.update([record({ task: "t", activity: "two" })], failOnError);
	assert.equal(io.started, 1);
	const flushed = index.flush();
	await settle();
	assert.equal(io.started, 2);
	await io.finishNext();
	await flushed;
	assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).records[0].activity, "two");
});

test("the default writer puts the index on disk with no injected io", async (t) => {
	const dir = scratch(t);
	const index = new ChildIndex(dir, "parent-1", dir);
	index.update([record({ task: "real" })], failOnError);
	await index.flush();
	assert.deepEqual(savedTasks(dir), ["real"]);
	assert.equal(readFileSync(join(dir, "index.json"), "utf8").endsWith("\n"), true);
	assert.deepEqual(temporaries(dir), []);
});

/** A small deterministic PRNG, so a failing order of events can be replayed from its seed. */
function prng(seed: number): () => number {
	let s = seed >>> 0;
	return () => { s = (s + 0x6d2b79f5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

const savedVersion = (dir: string): number => Number(savedTasks(dir)[0]?.slice(1) ?? 0);

test("property: in every order of updates, saves, finished and failed writes, the index never goes back and the newest records win", async (t) => {
	for (let seed = 1; seed <= 200; seed++) {
		const dir = mkdtempSync(join(tmpdir(), "child-index-prop-"));
		try {
			const random = prng(seed);
			const io = new HeldWrites();
			const index = new ChildIndex(dir, "parent-1", dir, io);
			let version = 0;
			const onError = () => {};
			let highest = 0;
			for (let step = 0; step < 25; step++) {
				const roll = random();
				if (roll < 0.45) index.update([record({ task: `v${++version}` })], onError);
				else if (roll < 0.55) index.save([record({ task: `v${++version}` })]);
				else if (roll < 0.9) await io.finishNext(true);
				else await io.finishNext(false);
				assert.ok(io.held.length <= 1, `seed ${seed}: more than one write in flight`);
				// An older write that lands after a newer one would give a restore stale children.
				const onDisk = savedVersion(dir);
				assert.ok(onDisk >= highest, `seed ${seed}, step ${step}: the index went back from v${highest} to v${onDisk}`);
				highest = onDisk;
			}
			// A failed last write leaves the newest records unsaved until the next change; Pi always has one.
			index.update([record({ task: `v${++version}` })], onError);
			while (io.held.length > 0) await io.finishNext(true);
			await index.flush();
			assert.deepEqual(savedTasks(dir), [`v${version}`], `seed ${seed}: the newest records are not the saved ones`);
			assert.deepEqual(temporaries(dir), [], `seed ${seed}: a temporary file was left`);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}
	t.diagnostic("200 seeds x 25 events");
});
