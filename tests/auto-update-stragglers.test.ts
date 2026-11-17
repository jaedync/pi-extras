/** The scan for the processes that a smoke test Pi left: the ps path that macOS uses, run with a fake ps. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markedPids } from "../lib/auto-update/stragglers.ts";

/** A fake `ps` first on PATH that prints `lines` of environment noise and one marked process. */
function fakePs(t: test.TestContext, lines: number): void {
	const dir = mkdtempSync(join(tmpdir(), "au-stragglers-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "bin"));
	const noise = `HOME=/x ${"A=".padEnd(2000, "b")}`;
	writeFileSync(join(dir, "bin", "ps"), [
		"#!/bin/sh",
		`i=0; while [ $i -lt ${lines} ]; do echo "  $((i + 100)) /bin/zsh ${noise}"; i=$((i + 1)); done`,
		'echo " 4242 node broker.ts PI_EXTRAS_SMOKE_ID=abc HOME=/tmp/s"',
		'echo " 4343 node other.ts PI_EXTRAS_SMOKE_ID=abcd"',
	].join("\n"));
	chmodSync(join(dir, "bin", "ps"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${join(dir, "bin")}:${path}`;
	t.after(() => { process.env.PATH = path; });
}

test("the ps scan finds only the process with the exact marker", { skip: process.platform === "win32" }, async (t) => {
	fakePs(t, 10);
	assert.deepEqual(await markedPids("abc", "darwin"), [4242]);
});

test("the ps scan reads an output of several megabytes (a Mac with many processes)", { skip: process.platform === "win32" }, async (t) => {
	fakePs(t, 3000);
	assert.deepEqual(await markedPids("abc", "darwin"), [4242]);
});

test("the /proc scan finds this process's own child by its marker, and never this process", { skip: process.platform !== "linux" }, async (t) => {
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, PI_EXTRAS_SMOKE_ID: "linux-scan" }, stdio: "ignore" });
	t.after(() => child.kill("SIGKILL"));
	await new Promise((done) => child.once("spawn", done));
	assert.deepEqual(await markedPids("linux-scan", "linux"), [child.pid]);
	assert.deepEqual(await markedPids("no-such-marker", "linux"), []);
});
