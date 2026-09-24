import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAppsMode, writeAppsMode } from "../lib/computer-use/settings.ts";

test("the apps mode defaults to asking, and anything unrecognised also means asking", () => {
	const dir = mkdtempSync(join(tmpdir(), "cu-settings-"));
	try {
		const file = join(dir, "pi-extras.json");
		assert.equal(readAppsMode(file), "ask");
		writeFileSync(file, "not json");
		assert.equal(readAppsMode(file), "ask");
		writeFileSync(file, JSON.stringify({ computerUse: { apps: "everything" } }));
		assert.equal(readAppsMode(file), "ask");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writing the mode keeps every other setting in the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "cu-settings-"));
	try {
		const file = join(dir, "pi-extras.json");
		writeFileSync(file, JSON.stringify({ usageGuard: { enabled: true }, computerUse: { other: 1 } }));
		writeAppsMode("all", file);
		assert.equal(readAppsMode(file), "all");
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { usageGuard: { enabled: true }, computerUse: { other: 1, apps: "all" } });
		writeAppsMode("none", file);
		assert.equal(readAppsMode(file), "none");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
