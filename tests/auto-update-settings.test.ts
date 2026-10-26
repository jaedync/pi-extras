import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSettingsPackages, rewriteSettingsPackages } from "../lib/auto-update/settings.ts";
import { withSettingsLock } from "../lib/auto-update/settings-lock.ts";

// The same lock library Pi uses for settings.json, from Pi's own dependencies.
const piRequire = createRequire(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
const lockfile = piRequire("proper-lockfile") as { lockSync(file: string, options: { realpath: boolean }): () => void };

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "au-settings-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("the settings lock is the directory Pi's proper-lockfile uses, so each side waits for the other", (t) => {
	const dir = scratch(t);
	const file = join(dir, "settings.json");
	writeFileSync(file, "{}");
	const release = lockfile.lockSync(file, { realpath: false });
	assert.ok(statSync(`${file}.lock`).isDirectory());
	assert.throws(() => withSettingsLock(file, () => 1, { waitMs: 100 }), /Pi is saving settings\.json/);
	release();
	const seen = withSettingsLock(file, () => {
		assert.ok(statSync(`${file}.lock`).isDirectory());
		assert.throws(() => lockfile.lockSync(file, { realpath: false }), (error: NodeJS.ErrnoException) => error.code === "ELOCKED");
		return 7;
	});
	assert.equal(seen, 7);
	assert.equal(existsSync(`${file}.lock`), false);
	lockfile.lockSync(file, { realpath: false })();
});

test("a settings lock left by a dead process is taken over after Pi's stale time", (t) => {
	const dir = scratch(t);
	const file = join(dir, "settings.json");
	mkdirSync(`${file}.lock`);
	const old = new Date(Date.now() - 11_000);
	utimesSync(`${file}.lock`, old, old);
	assert.equal(withSettingsLock(file, () => "ok", { waitMs: 100 }), "ok");
	assert.equal(existsSync(`${file}.lock`), false);
});

test("the lock is released when the work throws", (t) => {
	const file = join(scratch(t), "settings.json");
	assert.throws(() => withSettingsLock(file, () => { throw new Error("boom"); }), /boom/);
	assert.equal(existsSync(`${file}.lock`), false);
});

test("rewriting packages keeps every other field, the mode and a symlinked file", (t) => {
	const dir = scratch(t);
	const real = join(dir, "real-settings.json");
	const file = join(dir, "settings.json");
	writeFileSync(real, JSON.stringify({ theme: "quiet", packages: ["npm:x", "/local"], compaction: { reserveTokens: 5 } }, null, 2));
	chmodSync(real, 0o640);
	symlinkSync(real, file);
	assert.deepEqual(readSettingsPackages(file), ["npm:x", "/local"]);
	const result = rewriteSettingsPackages(file, (packages) => packages.map((entry) => (entry === "npm:x" ? "/s/packages/npm-x/1.0.0/node_modules/x" : entry)));
	assert.equal(result.changed, true);
	const saved = JSON.parse(readFileSync(real, "utf8"));
	assert.deepEqual(saved, { theme: "quiet", packages: ["/s/packages/npm-x/1.0.0/node_modules/x", "/local"], compaction: { reserveTokens: 5 } });
	assert.equal(statSync(real).mode & 0o777, 0o640);
	assert.ok(statSync(file).isFile() && existsSync(file));
	const again = rewriteSettingsPackages(file, (packages) => [...packages]);
	assert.equal(again.changed, false);
});

test("a settings.json that does not parse is never rewritten", (t) => {
	const file = join(scratch(t), "settings.json");
	writeFileSync(file, "{ nope");
	assert.throws(() => rewriteSettingsPackages(file, () => ["x"]), /could not be read/);
	assert.equal(readFileSync(file, "utf8"), "{ nope");
	assert.equal(existsSync(`${file}.lock`), false);
});

test("a missing settings.json reads as no packages and is created on write", (t) => {
	const file = join(scratch(t), "agent", "settings.json");
	assert.deepEqual(readSettingsPackages(file), []);
	rewriteSettingsPackages(file, () => ["npm:x"]);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { packages: ["npm:x"] });
});

test("a settings.json with a UTF-8 BOM reads as Pi reads it, and the rewrite keeps every other field", (t) => {
	const file = join(scratch(t), "settings.json");
	writeFileSync(file, `\uFEFF${JSON.stringify({ theme: "dark", packages: ["npm:x"] }, null, 2)}\n`);
	assert.deepEqual(readSettingsPackages(file), ["npm:x"]);
	rewriteSettingsPackages(file, () => ["/s/x"]);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { theme: "dark", packages: ["/s/x"] }, "Pi writes no BOM either");
});
