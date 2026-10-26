/** The smoke test against the repo's real development Pi, with fixture packages. No network, no real agent dir. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { smokeTest } from "../lib/auto-update/smoke.ts";
import { fixturePackage, piPrefix, removeTree } from "./support/auto-update-fixtures.ts";

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "au-smoke-"));
	t.after(() => removeTree(dir));
	return dir;
}

test("a set whose packages load passes, with filters kept on the entry", async (t) => {
	const root = scratch(t);
	const pi = piPrefix(join(root, "pi"));
	const good = fixturePackage(join(root, "good"), "good");
	const result = await smokeTest({ piDir: pi, packages: [{ source: good, extensions: ["extensions/main.ts"] }], timeoutMs: 45_000 });
	assert.deepEqual(result.ok ? "ok" : result.reason, "ok");
});

test("a package that fails to load fails the smoke test with Pi's reason", async (t) => {
	const root = scratch(t);
	const pi = piPrefix(join(root, "pi"));
	const good = fixturePackage(join(root, "good"), "good");
	const bad = fixturePackage(join(root, "bad"), "load-error", "broken");
	const result = await smokeTest({ piDir: pi, packages: [good, bad], timeoutMs: 45_000 });
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.reason : "", /Failed to load extension.*missing-module/);
});

test("an extension that throws at session start fails the smoke test", async (t) => {
	const root = scratch(t);
	const pi = piPrefix(join(root, "pi"));
	const bad = fixturePackage(join(root, "bad"), "handler-error", "throws");
	const result = await smokeTest({ piDir: pi, packages: [bad], timeoutMs: 45_000 });
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.reason : "", /failed in session_start: fixture failure/);
});

test("a candidate without bin/pi fails at once", async (t) => {
	const result = await smokeTest({ piDir: join(scratch(t), "none"), packages: [] });
	assert.deepEqual(result, { ok: false, reason: "the candidate Pi has no bin/pi" });
});

test("pi-extras itself passes the smoke test", async () => {
	const result = await smokeTest({ piDir: piPrefix(join(mkdtempSync(join(tmpdir(), "au-smoke-x-")), "pi")), packages: [new URL("../", import.meta.url).pathname.replace(/\/$/, "")], timeoutMs: 55_000 });
	assert.deepEqual(result.ok ? "ok" : result.reason, "ok");
});
