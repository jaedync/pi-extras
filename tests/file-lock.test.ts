import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tryLock, waitForLock } from "../lib/file-lock.ts";

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
