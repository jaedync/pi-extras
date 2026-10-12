import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, freshModels, launchFiles, stampCurrent, stampOf } from "../lib/subagents/stamp.ts";

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

/** A model runtime that counts its refreshes; `gate` holds one open until the test lets it go. */
function runtime() {
	let refreshes = 0;
	let release: (() => void) | undefined;
	let fail: Error | undefined;
	return {
		get refreshes() { return refreshes; },
		hold() { return new Promise<void>((resolve) => { release = resolve; }); },
		release: () => release?.(),
		failNext(error: Error) { fail = error; },
		gate: undefined as Promise<void> | undefined,
		async refresh(options: { allowNetwork: boolean }) {
			assert.equal(options.allowNetwork, false, "a launch refreshes from disk only");
			refreshes++;
			if (this.gate) await this.gate;
			if (fail) { const error = fail; fail = undefined; throw error; }
		},
	};
}

test("the shared runtime is refreshed once when first seen, then only after models.json changes", async () => {
	const dir = scratch();
	try {
		const models = join(dir, "models.json");
		writeFileSync(models, '{"providers":{}}');
		const shared = runtime();
		const warnings: string[] = [];
		await freshModels(shared, models, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1, "it may have read an older file before this module saw it");
		await freshModels(shared, models, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1);
		writeFileSync(models, '{"providers":{"local":{"models":[]}}}');
		await freshModels(shared, models, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 2);
		assert.deepEqual(warnings, []);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launches at the same time share one refresh", async () => {
	const dir = scratch();
	try {
		const models = join(dir, "models.json");
		writeFileSync(models, "{}");
		const shared = runtime();
		shared.gate = shared.hold();
		const first = freshModels(shared, models, () => undefined);
		const second = freshModels(shared, models, () => undefined);
		await new Promise((resolve) => setImmediate(resolve));
		shared.release();
		await Promise.all([first, second]);
		assert.equal(shared.refreshes, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a models.json that does not parse is not read into main's runtime, and the user is told once", async () => {
	const dir = scratch();
	try {
		const models = join(dir, "models.json");
		writeFileSync(models, '{"providers": {');
		const shared = runtime();
		const warnings: string[] = [];
		await freshModels(shared, models, (message) => warnings.push(message));
		await freshModels(shared, models, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 0, "a half-saved file would drop main's custom models");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /models\.json/);
		writeFileSync(models, '// a comment Pi allows\n{"providers": {},}\n');
		await freshModels(shared, models, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1, "comments and a trailing comma parse as Pi parses them");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a refresh that fails is reported and the launch goes on with the models loaded before", async () => {
	const dir = scratch();
	try {
		const models = join(dir, "models.json");
		writeFileSync(models, "{}");
		const shared = runtime();
		shared.failNext(new Error("disk went away"));
		const warnings: string[] = [];
		await freshModels(shared, models, (message) => warnings.push(message));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /disk went away/);
		await freshModels(shared, models, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1, "no retry until the file changes again");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a runtime without refresh is left alone", async () => {
	await freshModels({}, "/nowhere/models.json", () => assert.fail("nothing to warn about"));
});
