import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectGarbage, mappedPaths } from "../lib/auto-update/gc.ts";
import { leaseFile, processStart, readLiveLeases, removeLease, writeLease, type Lease } from "../lib/auto-update/leases.ts";
import { storePaths } from "../lib/auto-update/paths.ts";
import { emptyState, type UpdateSet } from "../lib/auto-update/state.ts";

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "au-leases-"));
	t.after(() => {
		chmodTree(dir);
		rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

function chmodTree(dir: string): void {
	try {
		chmodSync(dir, 0o755);
		for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) chmodTree(join(dir, entry.name));
	} catch {
		// Cleanup only.
	}
}

const lease = (overrides: Partial<Lease>): Lease => ({
	pid: process.pid, start: processStart(process.pid) ?? "x", piVersion: "1.4.0", piDir: "/s/pi/1.4.0", releases: [], extrasDir: "/x", mode: "tui", updatedAt: 1, ...overrides,
});

test("a process start time tells a live process from a reused pid", { skip: process.platform === "win32" }, async () => {
	const own = processStart(process.pid);
	assert.ok(own && own.length > 0);
	assert.equal(processStart(process.pid), own, "stable for one process");
	const child = spawn(process.execPath, ["-e", ""]);
	const pid = child.pid!;
	await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(processStart(pid), undefined);
});

test("only leases of live processes with the same start time are kept; others are removed", (t) => {
	const paths = storePaths(scratch(t));
	writeLease(paths, lease({}));
	writeLease(paths, lease({ start: "1" }));
	writeLease(paths, lease({ pid: 999_999_999 }));
	writeFileSync(join(paths.leases, "junk.json"), "{");
	const live = readLiveLeases(paths);
	assert.equal(live.length, 1);
	assert.equal(live[0]?.pid, process.pid);
	assert.deepEqual(readdirSync(paths.leases).sort(), [leaseFile(lease({}))].sort());
	removeLease(paths, live[0]!);
	assert.deepEqual(readdirSync(paths.leases), []);
});

function release(root: string, rel: string, ageMs: number): string {
	const dir = join(root, rel);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".pi-extras-release.json"), JSON.stringify({ installedAt: Date.now() - ageMs }));
	writeFileSync(join(dir, "file.txt"), "x");
	// Releases are read-only after install; GC must still remove them.
	chmodSync(join(dir, "file.txt"), 0o444);
	chmodSync(dir, 0o555);
	return dir;
}

test("GC removes only old releases that no set, lease or mapping uses", (t) => {
	const root = scratch(t);
	const paths = storePaths(root);
	const hour = 3_600_000;
	const cur = release(root, "packages/npm-x/3.0.0", 2 * hour);
	const prev = release(root, "packages/npm-x/2.0.0", 2 * hour);
	const leased = release(root, "packages/npm-x/1.0.0", 2 * hour);
	const old = release(root, "packages/npm-x/0.9.0", 2 * hour);
	const young = release(root, "packages/npm-x/0.8.0", hour / 2);
	const mapped = release(root, "packages/npm-x/0.7.0", 2 * hour);
	const piCur = release(root, "pi/1.4.0", 2 * hour);
	const piLeased = release(root, "pi/1.3.0", 2 * hour);
	const piOld = release(root, "pi/1.2.0", 2 * hour);
	mkdirSync(join(root, "packages/npm-x/4.0.0.staging-abc"));
	const staleStaging = join(root, "packages/npm-x/4.0.0.staging-abc");
	const oldTime = new Date(Date.now() - hour);
	utimesSync(staleStaging, oldTime, oldTime);
	mkdirSync(join(root, "packages/npm-x/5.0.0.staging-new"));
	// A symlink inside a release must be removed, never followed.
	const outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "keep.txt"), "keep");
	chmodSync(old, 0o755);
	symlinkSync(outside, join(old, "link"));
	chmodSync(old, 0o555);
	const set = (pkg: string, pi: string): UpdateSet => ({ pi: { version: "v", dir: pi }, packages: { "npm-x": { origin: "npm:x", id: "i", dir: pkg, entry: join(pkg, "node_modules/x") } } });
	const state = { ...emptyState(), current: set(cur, piCur), previous: set(prev, piCur) };
	const leases = [lease({ piDir: piLeased, releases: [join(leased, "node_modules/x")] })];
	const result = collectGarbage({ paths, state, leases, now: Date.now(), mapped: () => new Set([join(mapped, "native.node")]) });
	assert.deepEqual(result.removed.sort(), [old, piOld, staleStaging].sort());
	for (const dir of [cur, prev, leased, young, mapped, piCur, piLeased, join(root, "packages/npm-x/5.0.0.staging-new")]) assert.ok(existsSync(dir), dir);
	assert.ok(existsSync(join(outside, "keep.txt")));
});

test("the maps scan finds files a live process has mapped", { skip: process.platform !== "linux" }, () => {
	const paths = mappedPaths(["/usr", "/lib", process.execPath.split("/").slice(0, 2).join("/")]);
	assert.ok([...paths].some((path) => path.includes("libc") || path === process.execPath), "node or libc is mapped by this process");
});
