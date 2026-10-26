import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectGarbage, mappedPaths, processPaths } from "../lib/auto-update/gc.ts";
import { leaseFile, processStart, psStart, readLiveLeases, removeLease, writeLease, type Lease } from "../lib/auto-update/leases.ts";
import { renderLauncher } from "../lib/auto-update/launcher.ts";
import { storePaths } from "../lib/auto-update/paths.ts";
import { emptyState, type UpdateSet } from "../lib/auto-update/state.ts";

function scratch(t: test.TestContext): string {
	// GC works on the real store root; on macOS tmpdir() is under the /var -> /private/var link.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "au-leases-")));
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

test("the ps start time (macOS) uses the C locale in Node and in the launcher, so both write the same text", { skip: process.platform === "win32" }, (t) => {
	const saved = process.env.LC_ALL;
	t.after(() => (saved === undefined ? delete process.env.LC_ALL : (process.env.LC_ALL = saved)));
	process.env.LC_ALL = "en_US.utf8";
	assert.match(psStart(process.pid) ?? "", /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
	assert.match(renderLauncher({ store: "/s", fallbackPi: "/p", fallbackExtras: "/e", node: "/n" }), /LC_ALL=C ps -o lstart= -p "\$\$"/);
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

test("GC removes restart requests older than a day; newer ones stay", (t) => {
	const root = scratch(t);
	const paths = storePaths(root);
	mkdirSync(paths.restart, { recursive: true });
	const day = 24 * 3_600_000;
	for (const name of ["old-request", ".old.start", "new-request"]) writeFileSync(join(paths.restart, name), "x");
	const old = new Date(Date.now() - day - 60_000);
	for (const name of ["old-request", ".old.start"]) utimesSync(join(paths.restart, name), old, old);
	const result = collectGarbage({ paths, state: emptyState(), leases: [], now: Date.now(), refs: () => new Set(), mapped: () => new Set() });
	assert.deepEqual(readdirSync(paths.restart), ["new-request"]);
	assert.deepEqual(result.removed.sort(), [join(realpathSync(root), "restart", ".old.start"), join(realpathSync(root), "restart", "old-request")]);
});

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
	mkdirSync(join(root, "packages/npm-x/4.0.0.staging-0a1b2c3d"));
	const staleStaging = join(root, "packages/npm-x/4.0.0.staging-0a1b2c3d");
	const oldTime = new Date(Date.now() - hour);
	utimesSync(staleStaging, oldTime, oldTime);
	mkdirSync(join(root, "packages/npm-x/5.0.0.staging-4e5f6a7b"));
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
	for (const dir of [cur, prev, leased, young, mapped, piCur, piLeased, join(root, "packages/npm-x/5.0.0.staging-4e5f6a7b")]) assert.ok(existsSync(dir), dir);
	assert.ok(existsSync(join(outside, "keep.txt")));
});

test("the maps scan finds files a live process has mapped", { skip: process.platform !== "linux" }, () => {
	const paths = mappedPaths(["/usr", "/lib", process.execPath.split("/").slice(0, 2).join("/")]);
	assert.ok([...paths].some((path) => path.includes("libc") || path === process.execPath), "node or libc is mapped by this process");
});

test("GC through a symlinked store root keeps what leases name by real path, and what settings.json names", (t) => {
	const dir = scratch(t);
	const realRoot = join(dir, "real-store");
	mkdirSync(realRoot);
	const root = join(dir, "store-link");
	symlinkSync(realRoot, root);
	const paths = storePaths(root);
	const hour = 3_600_000;
	const piCur = release(root, "pi/1.4.0", 2 * hour);
	const piOld = release(root, "pi/1.3.0", 2 * hour);
	const piGone = release(root, "pi/1.2.0", 2 * hour);
	const cur = release(root, "packages/npm-x/3.0.0", 2 * hour);
	const named = release(root, "packages/npm-y/1.0.0", 2 * hour);
	const loose = release(root, "packages/npm-y/0.9.0", 2 * hour);
	const state = { ...emptyState(), current: { pi: { version: "1.4.0", dir: piCur }, packages: { "npm-x": { origin: "npm:x", id: "3.0.0", dir: cur, entry: join(cur, "node_modules/x") } } } };
	// A session's lease names real paths (Pi's own folder through realpath), not the link.
	const leases = [lease({ piDir: realpathSync(piOld) })];
	const result = collectGarbage({ paths, state, leases, named: [join(realpathSync(named), "node_modules/y")], now: Date.now(), mapped: () => new Set() });
	assert.deepEqual(result.removed.map((removed) => removed.replace(realRoot, root)).sort(), [loose, piGone].sort());
	for (const kept of [piCur, piOld, cur, named]) assert.ok(existsSync(kept), kept);
});

test("a release whose name holds .staging- is a release, and a current one is never staging garbage", (t) => {
	const root = scratch(t);
	const paths = storePaths(root);
	const hour = 3_600_000;
	const prerelease = release(root, "packages/npm-x/2.0.0.staging-1", 2 * hour);
	const staging = join(root, "packages/npm-x/2.0.0.staging-1.staging-0a1b2c3d");
	mkdirSync(staging);
	const old = new Date(Date.now() - hour);
	utimesSync(staging, old, old);
	const state = { ...emptyState(), current: { pi: { version: "v", dir: join(root, "pi/none") }, packages: { "npm-x": { origin: "npm:x", id: "2.0.0.staging-1", dir: prerelease, entry: prerelease } } } };
	const result = collectGarbage({ paths, state, leases: [], now: Date.now(), mapped: () => new Set() });
	assert.deepEqual(result.removed, [staging]);
	assert.ok(existsSync(prerelease));
});

test("the process scan finds store paths in a live process's command line and working folder", { skip: process.platform !== "linux" }, async (t) => {
	const root = realpathSync(scratch(t));
	const cwdDir = join(root, "pi", "1.3.0");
	const argDir = join(root, "pi", "1.2.0");
	mkdirSync(cwdDir, { recursive: true });
	mkdirSync(argDir, { recursive: true });
	const children = [
		spawn("sleep", ["30"], { cwd: cwdDir, stdio: "ignore" }),
		spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", join(argDir, "bin", "pi")], { stdio: "ignore" }),
	];
	t.after(() => children.forEach((child) => child.kill("SIGKILL")));
	await new Promise((resolve) => setTimeout(resolve, 200));
	const found = [...processPaths([root])];
	assert.ok(found.includes(cwdDir), `cwd: ${found.join(", ")}`);
	assert.ok(found.includes(join(argDir, "bin", "pi")), `cmdline: ${found.join(", ")}`);
});

test("GC with the real scans keeps a folder that a process works in, names or maps, and removes the rest", { skip: process.platform !== "linux" }, async (t) => {
	const root = realpathSync(scratch(t));
	const paths = storePaths(root);
	const hour = 3_600_000;
	const worked = release(root, "pi/1.1.0", 2 * hour);
	const named = release(root, "pi/1.2.0", 2 * hour);
	const mappedDir = release(root, "packages/npm-x/1.0.0", 2 * hour);
	const loose = release(root, "packages/npm-x/0.9.0", 2 * hour);
	const children = [
		spawn("sleep", ["30"], { cwd: worked, stdio: "ignore" }),
		spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", join(named, "bin", "pi")], { stdio: "ignore" }),
		// A native module or a mapped data file: only /proc/<pid>/maps shows it.
		spawn("python3", ["-c", "import mmap, sys, time; f = open(sys.argv[1], 'rb'); m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ); print('ready', flush=True); time.sleep(30)", join(mappedDir, "file.txt")], { stdio: ["ignore", "pipe", "ignore"] }),
	];
	t.after(() => children.forEach((child) => child.kill("SIGKILL")));
	await new Promise((resolve) => children[2]!.stdout!.once("data", resolve));
	const result = collectGarbage({ paths, state: emptyState(), leases: [], now: Date.now() });
	assert.deepEqual(result.removed, [loose]);
	for (const kept of [worked, named, mappedDir]) assert.ok(existsSync(kept), kept);
});

test("GC reads the maps of processes only when the command lines and working folders leave a folder undecided", (t) => {
	const root = scratch(t);
	const paths = storePaths(root);
	const hour = 3_600_000;
	const a = release(root, "packages/npm-x/1.0.0", 2 * hour);
	const b = release(root, "packages/npm-x/0.9.0", 2 * hour);
	const calls: string[] = [];
	const refs = () => (calls.push("refs"), new Set([join(a, "bin"), join(b, "x")]));
	const maps = () => (calls.push("maps"), new Set<string>());
	assert.deepEqual(collectGarbage({ paths, state: emptyState(), leases: [], now: Date.now(), refs, mapped: maps }).removed, []);
	assert.deepEqual(calls, ["refs"], "every folder was decided without the maps");
	calls.length = 0;
	const some = () => (calls.push("refs"), new Set([join(a, "bin")]));
	assert.deepEqual(collectGarbage({ paths, state: emptyState(), leases: [], now: Date.now(), refs: some, mapped: maps }).removed, [b]);
	assert.deepEqual(calls, ["refs", "maps"], "one scan of each, not one for each folder");
});
