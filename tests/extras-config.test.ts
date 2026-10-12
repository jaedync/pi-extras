import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSection, UnreadableJsonError, updateSection, writeSection } from "../lib/extras-config.ts";

function scratch(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "extras-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const SETTINGS = `{\n  "usageGuard": { "enabled": true },\n  "toolDisplay": { "motion": "reduced" },\n}\n`;

test("a pi-extras.json that does not parse is never replaced, and a save says why", (t) => {
	const file = join(scratch(t), "pi-extras.json");
	// A trailing comma, the typo a hand edit makes most often.
	writeFileSync(file, SETTINGS);
	assert.deepEqual(readSection("usageGuard", file), {}, "readers run on their defaults");
	assert.throws(() => writeSection("releaseNotes", { seen: "1.0.0" }, file), (error: unknown) => {
		assert.ok(error instanceof UnreadableJsonError);
		assert.match(error.message, /pi-extras\.json could not be read .*nothing was saved\. Fix or remove .*pi-extras\.json/);
		return true;
	});
	assert.equal(readFileSync(file, "utf8"), SETTINGS, "every setting is still there");
	for (const text of ["[1, 2]", "\"text\"", "null", ""]) {
		writeFileSync(file, text);
		assert.throws(() => writeSection("releaseNotes", { seen: "1.0.0" }, file), UnreadableJsonError, `${JSON.stringify(text)} is kept`);
		assert.equal(readFileSync(file, "utf8"), text);
	}
	assert.deepEqual(readdirSync(join(file, "..")).sort(), ["pi-extras.json"], "no temporary or lock file is left behind");
});

test("a pi-extras.json that cannot be read is never replaced", { skip: process.getuid?.() === 0 && "root reads every file" }, (t) => {
	const file = join(scratch(t), "pi-extras.json");
	writeFileSync(file, JSON.stringify({ usageGuard: { enabled: true } }));
	chmodSync(file, 0o200);
	try {
		assert.throws(() => writeSection("releaseNotes", { seen: "1.0.0" }, file), UnreadableJsonError);
	} finally {
		chmodSync(file, 0o600);
	}
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { usageGuard: { enabled: true } });
});

test("a missing pi-extras.json starts empty and is created private to its owner", (t) => {
	const file = join(scratch(t), "agent", "pi-extras.json");
	assert.deepEqual(writeSection("toolDisplay", { motion: "reduced" }, file), { motion: "reduced" });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { toolDisplay: { motion: "reduced" } });
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a save writes through a symlinked pi-extras.json and keeps the file's mode", (t) => {
	const dir = scratch(t);
	mkdirSync(join(dir, "dotfiles"));
	const real = join(dir, "dotfiles", "pi-extras.json");
	const link = join(dir, "pi-extras.json");
	writeFileSync(real, JSON.stringify({ usageGuard: { enabled: true } }));
	chmodSync(real, 0o640);
	symlinkSync(real, link);
	writeSection("toolDisplay", { motion: "reduced" }, link);
	assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
	assert.equal(statSync(real).mode & 0o777, 0o640);
	assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { usageGuard: { enabled: true }, toolDisplay: { motion: "reduced" } });
	assert.deepEqual(readdirSync(dir).sort(), ["dotfiles", "pi-extras.json"], "the temporary file was made beside the target");
	// A link to a file not made yet creates that file.
	rmSync(real);
	writeSection("toolDisplay", { motion: "full" }, link);
	assert.ok(lstatSync(link).isSymbolicLink());
	assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { toolDisplay: { motion: "full" } });
});

test("updateSection changes only its own section, from the file as it is now", (t) => {
	const file = join(scratch(t), "pi-extras.json");
	writeFileSync(file, JSON.stringify({ a: { keep: 1 }, b: "not a section" }));
	assert.deepEqual(updateSection("b", (current) => ({ ...current, n: 1 }), file), { n: 1 });
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), c: { other: true } }));
	updateSection("b", (current) => ({ ...current, n: (current.n as number) + 1 }), file);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: { keep: 1 }, b: { n: 2 }, c: { other: true } });
});

function run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("close", (code) => resolve({ code, stderr }));
	});
}

test("Pi sessions that save at the same time keep each other's changes", async (t) => {
	const file = join(scratch(t), "pi-extras.json");
	const module = new URL("../lib/extras-config.ts", import.meta.url).href;
	const writers = 4;
	const writes = 40;
	const script = `const { writeSection } = await import(${JSON.stringify(module)});
const [file, name, count] = process.argv.slice(1);
for (let i = 0; i < Number(count); i++) writeSection(name, { ["k" + i]: i }, file);`;
	const results = await Promise.all(Array.from({ length: writers }, (_, index) =>
		run(process.execPath, ["--input-type=module", "-e", script, file, `s${index}`, String(writes)])));
	for (const result of results) assert.equal(result.code, 0, result.stderr);
	const saved = JSON.parse(readFileSync(file, "utf8"));
	for (let index = 0; index < writers; index++) assert.equal(Object.keys(saved[`s${index}`] ?? {}).length, writes, `section s${index} kept every write`);
});
