import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, launchFiles, stampCurrent, stampOf } from "../lib/subagents/stamp.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "subagents-stamp-"));

test("a file's identity changes when it is written, replaced or removed, and not when it is only read", () => {
	const dir = scratch();
	try {
		const file = join(dir, "settings.json");
		assert.equal(fileIdentity(file), "absent");
		writeFileSync(file, '{"compaction":{"reserveTokens":1000}}');
		const first = fileIdentity(file);
		assert.notEqual(first, "absent");
		assert.equal(fileIdentity(file), first, "reading it again changes nothing");
		writeFileSync(file, '{"compaction":{"reserveTokens":9000}}');
		utimesSync(file, new Date(2_000_000), new Date(2_000_000));
		assert.notEqual(fileIdentity(file), first, "same size, new content");
		rmSync(file);
		assert.equal(fileIdentity(file), "absent");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stamp is current only for the same generation and unchanged files", () => {
	const dir = scratch();
	try {
		const settings = join(dir, "settings.json");
		writeFileSync(settings, "{}");
		const stamp = stampOf(3, [settings, join(dir, "models.json"), settings]);
		assert.equal(stamp.files.length, 2, "each file once");
		assert.equal(stampCurrent(stamp, 3), true);
		assert.equal(stampCurrent(stamp, 4), false, "a reload made new code");
		writeFileSync(join(dir, "models.json"), "{}");
		assert.equal(stampCurrent(stamp, 3), false, "a file that appeared counts as a change");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a launch reads global and project settings, models, pi-extras.json and its extensions", () => {
	assert.deepEqual(launchFiles("/agent", "/work", ".pi", ["/ext/owner.ts"]), [
		"/agent/settings.json", "/work/.pi/settings.json", "/agent/models.json", "/agent/pi-extras.json", "/ext/owner.ts",
	]);
});
