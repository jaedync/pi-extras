import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock, tryLock, waitForLock } from "../lib/file-lock.ts";

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "file-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("a lock is held while its process lives, and is free again after release", (t) => {
	const path = join(scratch(t), "x.lock");
	const lock = tryLock(path);
	assert.ok(lock);
	assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid} [0-9a-f]+$`));
	assert.equal(tryLock(path), undefined);
	lock.release();
	assert.equal(existsSync(path), false);
	const again = tryLock(path);
	assert.ok(again);
	again.release();
});

test("an old lock with a live pid is taken over only when the caller sets an age limit", (t) => {
	const path = join(scratch(t), "x.lock");
	writeFileSync(path, String(process.pid));
	const old = new Date(Date.now() - 60_000);
	utimesSync(path, old, old);
	assert.equal(tryLock(path), undefined, "provisioning can hold a lock for minutes");
	const lock = tryLock(path, { staleMs: 5_000 });
	assert.ok(lock, "a settings write never takes a minute");
	lock.release();
});

test("an unreadable or empty lock counts as held while it is new", (t) => {
	const path = join(scratch(t), "x.lock");
	writeFileSync(path, "not a pid");
	assert.equal(tryLock(path), undefined);
	const lock = tryLock(path, { settleMs: 1_000, now: () => Date.now() + 2_000 });
	assert.ok(lock, "one left past the settle time is taken over");
	lock.release();
	assert.equal(existsSync(path), false);
});

test("a lock dated far in the future counts as stale, so a clock change cannot hold it for all time", (t) => {
	const path = join(scratch(t), "x.lock");
	const future = new Date(Date.now() + 3_600_000);
	writeFileSync(path, String(process.pid));
	utimesSync(path, future, future);
	const lock = tryLock(path, { staleMs: 5_000 });
	assert.ok(lock, "a live pid with an mtime an hour ahead");
	lock.release();
	writeFileSync(path, "");
	utimesSync(path, future, future);
	const empty = tryLock(path, { settleMs: 5_000 });
	assert.ok(empty, "an empty lock with an mtime an hour ahead");
	empty.release();
	// A small skew, as between a client and its network file system, is not stale.
	writeFileSync(path, String(process.pid));
	const soon = new Date(Date.now() + 1_000);
	utimesSync(path, soon, soon);
	assert.equal(tryLock(path, { staleMs: 5_000 }), undefined);
});

test("waitForLock gives up with a clear message while another holder keeps the lock", (t) => {
	const dir = scratch(t);
	const path = join(dir, "pi-extras.json.lock");
	const held = tryLock(path);
	assert.ok(held);
	assert.throws(() => waitForLock(path, 50), /^Error: Another Pi session is saving pi-extras\.json\. Try again\.$/);
	held.release();
	const lock = waitForLock(path, 50);
	lock.release();
	assert.deepEqual(readdirSync(dir), []);
});

test("acquireLock waits without blocking the thread, then gives up while the holder keeps the lock", async (t) => {
	const path = join(scratch(t), "x.lock");
	const held = tryLock(path)!;
	let ticks = 0;
	const timer = setInterval(() => { ticks++; }, 5);
	const lock = await acquireLock(path, 200);
	clearInterval(timer);
	assert.equal(lock, undefined);
	assert.ok(ticks >= 3, `timers ran during the wait (${ticks})`);
	held.release();
	const free = await acquireLock(path, 200);
	assert.ok(free, "a free lock is taken at once");
	free.release();
});

test("touch keeps a long holder's lock from counting as stale, and reports a lock that is no longer its own", (t) => {
	const path = join(scratch(t), "x.lock");
	const lock = tryLock(path, { staleMs: 30_000 })!;
	const old = new Date(Date.now() - 60_000);
	utimesSync(path, old, old);
	assert.equal(lock.touch(), true);
	assert.equal(tryLock(path, { staleMs: 30_000 }), undefined, "a touched lock is held");
	rmSync(path);
	assert.equal(lock.touch(), false);
});
