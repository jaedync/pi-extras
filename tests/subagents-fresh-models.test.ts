import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshModels, type ModelsCheck } from "../lib/subagents/fresh-models.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "subagents-models-"));
/** Pi's loader as the test wants it: every file loads. */
const loads: ModelsCheck = async () => undefined;

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
		await freshModels(shared, models, loads, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1, "it may have read an older file before this module saw it");
		await freshModels(shared, models, loads, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1);
		writeFileSync(models, '{"providers":{"local":{"models":[]}}}');
		await freshModels(shared, models, loads, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 2);
		assert.deepEqual(warnings, []);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launches at the same time share one check and one refresh", async () => {
	const dir = scratch();
	try {
		const models = join(dir, "models.json");
		writeFileSync(models, "{}");
		const shared = runtime();
		shared.gate = shared.hold();
		let checks = 0;
		const counted: ModelsCheck = async () => { checks++; return undefined; };
		const first = freshModels(shared, models, counted, () => undefined);
		const second = freshModels(shared, models, counted, () => undefined);
		await new Promise((resolve) => setImmediate(resolve));
		shared.release();
		await Promise.all([first, second]);
		assert.equal(shared.refreshes, 1);
		assert.equal(checks, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a models.json Pi's loader refuses is not read into main's runtime, is told once, and is not checked again until it changes", async () => {
	const dir = scratch();
	try {
		const models = join(dir, "models.json");
		writeFileSync(models, '{"providers":{"mine":{"baseUrl":42}}}');
		const shared = runtime();
		const warnings: string[] = [];
		let checks = 0;
		let verdict: string | undefined = "Invalid models.json schema:\n  - /providers/mine/baseUrl: Expected string\n\nFile: models.json";
		const check: ModelsCheck = async () => { checks++; return verdict; };
		await freshModels(shared, models, check, (message) => warnings.push(message));
		await freshModels(shared, models, check, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 0, "Pi would load it as no custom models, and main would lose its own");
		assert.equal(checks, 1, "the same file version is not checked again");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /models\.json does not load in Pi \(Invalid models\.json schema\)/);
		writeFileSync(models, '{"providers":{"mine":{"baseUrl":"http://127.0.0.1:9/v1"}}}');
		verdict = undefined;
		await freshModels(shared, models, check, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1, "the fixed file is read");
		assert.equal(warnings.length, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a check that fails counts as a refusal: main's runtime is left as it is", async () => {
	const dir = scratch();
	try {
		const models = join(dir, "models.json");
		writeFileSync(models, "{}");
		const shared = runtime();
		const warnings: string[] = [];
		await freshModels(shared, models, async () => { throw new Error("no loader"); }, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 0);
		assert.match(warnings.join("\n"), /could not check it: no loader/);
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
		await freshModels(shared, models, loads, (message) => warnings.push(message));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /disk went away/);
		await freshModels(shared, models, loads, (message) => warnings.push(message));
		assert.equal(shared.refreshes, 1, "no retry until the file changes again");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a runtime without refresh is left alone", async () => {
	await freshModels({}, "/nowhere/models.json", () => assert.fail("nothing to check"), () => assert.fail("nothing to warn about"));
});
