/** Staging the host scripts onto the Windows disk; only temporary directories, no Windows. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { chooseFolder, SCRIPTS, stageScripts } from "../lib/windows-use/launch.ts";

async function dirs(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "windows-use-stage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "package"), target = join(root, "LocalAppData");
	await mkdir(source); await mkdir(target);
	for (const name of ["host.ps1", "ocr.psm1"]) await writeFile(join(source, name), `# ${name}\n`);
	return { source, target };
}

test("the package's PowerShell files are staged together, since host.ps1 loads its neighbours from its own folder", () => {
	for (const name of ["host.ps1", "tunnel.ps1", "ocr.psm1", "guest-bootstrap.ps1"]) assert.ok((SCRIPTS as readonly string[]).includes(name), name);
});

test("scripts land in a folder named for their content, and an unchanged folder is left alone", async (t) => {
	const { source, target } = await dirs(t);
	const names = ["host.ps1", "ocr.psm1"];
	const first = stageScripts(source, names, target);
	assert.ok(first.startsWith(join(target, "pi-extras", "windows-use", "scripts")));
	assert.equal(await readFile(join(first, "host.ps1"), "utf8"), "# host.ps1\n");
	const written = (await stat(join(first, "ocr.psm1"))).mtimeMs;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(stageScripts(source, names, target), first);
	assert.equal((await stat(join(first, "ocr.psm1"))).mtimeMs, written, "not rewritten");
	await writeFile(join(source, "host.ps1"), "# host.ps1, next version\n");
	const next = stageScripts(source, names, target);
	assert.notEqual(next, first, "a new version never overwrites one an older session may still be reading");
	assert.equal(await readFile(join(next, "host.ps1"), "utf8"), "# host.ps1, next version\n");
});

test("a staged copy that was changed on disk is put back before it runs", async (t) => {
	const { source, target } = await dirs(t);
	const dir = stageScripts(source, ["host.ps1", "ocr.psm1"], target);
	await writeFile(join(dir, "host.ps1"), "# tampered\n");
	assert.equal(stageScripts(source, ["host.ps1", "ocr.psm1"], target), dir);
	assert.equal(await readFile(join(dir, "host.ps1"), "utf8"), "# host.ps1\n");
});

test("a missing Windows folder is an error the launcher can fall back from", async (t) => {
	const { source } = await dirs(t);
	assert.throws(() => stageScripts(source, ["host.ps1"], join(source, "no-such-dir")), /no-such-dir/);
});

test("without a Windows folder to stage into, the scripts run from the package, and the reason is kept", async (t) => {
	const { source } = await dirs(t);
	assert.deepEqual(chooseFolder(source, () => { throw new Error("cmd.exe wasn't found beside Windows PowerShell"); }), { folder: source, error: "cmd.exe wasn't found beside Windows PowerShell" });
});

test("an older version's folder is removed after 30 days, and a recent one is kept for sessions still on it", async (t) => {
	const { source, target } = await dirs(t);
	const root = join(target, "pi-extras", "windows-use", "scripts");
	const old = join(root, "0000000000000000"), recent = join(root, "1111111111111111");
	await mkdir(old, { recursive: true }); await mkdir(recent);
	const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
	await utimes(old, longAgo, longAgo);
	const current = stageScripts(source, ["host.ps1"], target);
	assert.equal(existsSync(old), false);
	assert.equal(existsSync(recent), true);
	assert.equal(existsSync(current), true);
});
