import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GovSearchError } from "../lib/gov-search/errors.ts";
import { KEY_FILE_ENV, readKey } from "../lib/gov-search/key.ts";

// Built from parts so secret scanners do not flag a synthetic value.
const KEY = ["fc", "synthetic", "key", "0001"].join("-");
const failsWith = (code: string, secret?: string) => (error: unknown) => error instanceof GovSearchError && error.code === code && (!secret || !error.message.includes(secret));

async function withDir(run: (dir: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "gov-key-"));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("no env var and no default file means a search without a key", async () => {
	await withDir(async (dir) => {
		assert.equal(await readKey({}, undefined, join(dir, "missing")), undefined);
		assert.equal(await readKey({ FIRECRAWL_API_KEY: "   " }, undefined, join(dir, "missing")), undefined);
	});
});

test("the env var is trimmed and wins over the file", async () => {
	await withDir(async (dir) => {
		const file = join(dir, "key");
		writeFileSync(file, "fc-from-the-file-0002\n", { mode: 0o600 });
		assert.equal(await readKey({ FIRECRAWL_API_KEY: ` ${KEY} ` }, undefined, file), KEY);
		assert.equal(await readKey({}, undefined, file), "fc-from-the-file-0002");
	});
});

test("FIRECRAWL_API_KEY_FILE names another file, which must exist", async () => {
	await withDir(async (dir) => {
		const file = join(dir, "other");
		writeFileSync(file, KEY, { mode: 0o600 });
		assert.equal(await readKey({ [KEY_FILE_ENV]: file }, undefined, join(dir, "missing")), KEY);
		await assert.rejects(readKey({ [KEY_FILE_ENV]: join(dir, "gone") }, undefined, file), failsWith("keyFile"));
	});
});

test("an empty key file is no key; a file that cannot be used is an error that never shows its text", async () => {
	await withDir(async (dir) => {
		const file = join(dir, "key");
		writeFileSync(file, "\n");
		assert.equal(await readKey({}, undefined, file), undefined);
		for (const bad of ["fc-key\r\nX-Evil: 1", "two words here", "short"]) {
			writeFileSync(file, bad);
			await assert.rejects(readKey({}, undefined, file), failsWith("key", bad));
		}
		writeFileSync(file, "k".repeat(5000));
		await assert.rejects(readKey({}, undefined, file), failsWith("keyFile"));
		const folder = join(dir, "folder");
		mkdirSync(folder);
		await assert.rejects(readKey({}, undefined, folder), failsWith("keyFile"));
		await assert.rejects(readKey({ FIRECRAWL_API_KEY: "has space s" }), failsWith("key", "has space s"));
	});
});

test("a key file the user cannot read is an error, not a silent keyless search", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root reads every file");
	await withDir(async (dir) => {
		const file = join(dir, "key");
		writeFileSync(file, KEY);
		chmodSync(file, 0o000);
		await assert.rejects(readKey({}, undefined, file), failsWith("keyFile", KEY));
	});
});
