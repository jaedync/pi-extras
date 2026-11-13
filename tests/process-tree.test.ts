/**
 * The bash tool must leave no process of a call alive when the call ends:
 * at its timeout, at an abort, and at a normal end. That includes processes
 * that left the shell's group or session (GNU timeout, setsid) and processes
 * that ignore SIGTERM. Each test marks its processes with a unique sleep
 * length, and SIGKILLs every marked process at its end, pass or fail.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { treeShellOperations, type TreeMode } from "../lib/process-tree.ts";

const linux = process.platform === "linux";
const GRACE_MS = 300;
const markers: string[] = [];

/** A sleep length no other process uses, so a scan finds this test's processes only. */
function marker(): string {
	const value = `${1000 + markers.length}.${process.pid}${Math.floor(Math.random() * 1e6)}`;
	markers.push(value);
	return value;
}

/** Live (not zombie) processes whose command line holds the marker. */
function marked(value: string): number[] {
	const found: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		try {
			const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
			if (!cmdline.split("\0").some((arg) => arg.includes(value))) continue;
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
			if (state !== "Z" && state !== "X") found.push(Number(name));
		} catch {
			// The process ended while it was read.
		}
	}
	return found;
}

async function survivors(value: string, waitMs = 1000): Promise<number[]> {
	const deadline = Date.now() + waitMs;
	let left = marked(value);
	while (left.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		left = marked(value);
	}
	return left;
}

function killMarked(value: string): void {
	for (const pid of marked(value)) {
		try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
	}
}

after(() => { for (const value of markers) killMarked(value); });

const SCOPE = linux && spawnSync("systemd-run", ["--user", "--scope", "--collect", "--quiet", "--", "true"], { timeout: 5000, stdio: "ignore" }).status === 0;

function bash(mode: TreeMode) {
	const operations = treeShellOperations(() => ({ shell: "/bin/bash", args: ["-c"] }), { graceMs: GRACE_MS, mode });
	return createBashToolDefinition(process.cwd(), { operations });
}

type Execute = (id: string, params: { command: string; timeout?: number }, signal?: AbortSignal) => Promise<{ content: { text: string }[] }>;

async function run(mode: TreeMode, command: string, timeout?: number, signal?: AbortSignal): Promise<{ text: string; error: boolean }> {
	const execute = bash(mode).execute as unknown as Execute;
	try {
		const result = await execute(`call-${Math.random()}`, { command, ...(timeout === undefined ? {} : { timeout }) }, signal);
		return { text: result.content[0]?.text ?? "", error: false };
	} catch (error) {
		return { text: (error as Error).message, error: true };
	}
}

const modes: { mode: TreeMode; skip: string | false }[] = [
	{ mode: "scope", skip: SCOPE ? false : "no systemd user scope here" },
	{ mode: "group", skip: linux ? false : "the scan reads /proc" },
];

for (const { mode, skip } of modes) {
	describe(`bash leaves no process of the call (${mode})`, { skip }, () => {
		test("a. GNU timeout with a TERM-ignoring child, past the tool's 2 s limit", { timeout: 15_000 }, async () => {
			const value = marker();
			try {
				// The echo keeps bash from exec'ing timeout, so timeout forks and moves to a group of its own, as under xargs.
				const result = await run(mode, `timeout 400 sh -c 'trap "" TERM; sleep ${value}'; echo end`, 2);
				assert.equal(result.error, true);
				assert.match(result.text, /timed out after 2 seconds/);
				assert.deepEqual(await survivors(value), []);
			} finally { killMarked(value); }
		});

		test("b. a setsid child started in the background, at a normal end", { timeout: 15_000, skip: mode === "group" ? "a group scan cannot see a setsid child whose parent ended" : false }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `setsid sh -c 'sleep ${value}' & echo started`);
				assert.equal(result.error, false, result.text);
				assert.match(result.text, /started/);
				assert.deepEqual(await survivors(value), []);
			} finally { killMarked(value); }
		});

		test("c. a TERM-ignoring child in the shell's own group, at a normal end", { timeout: 15_000 }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `sh -c 'trap "" TERM; sleep ${value}' & sleep 0.2; echo done`);
				assert.equal(result.error, false, result.text);
				assert.deepEqual(await survivors(value), []);
			} finally { killMarked(value); }
		});

		test("c2. a TERM-ignoring child in the shell's own group, at the timeout", { timeout: 15_000 }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `sh -c 'trap "" TERM; sleep ${value}'`, 1);
				assert.equal(result.error, true);
				assert.deepEqual(await survivors(value), []);
			} finally { killMarked(value); }
		});

		test("d. an abort in the middle of the call", { timeout: 15_000 }, async () => {
			const value = marker();
			const controller = new AbortController();
			try {
				setTimeout(() => controller.abort(), 700);
				const started = Date.now();
				const result = await run(mode, `timeout 400 sh -c 'trap "" TERM; sleep ${value}' & sh -c 'trap "" TERM; sleep ${value}'`, 30, controller.signal);
				assert.equal(result.error, true);
				assert.match(result.text, /aborted/);
				assert.ok(Date.now() - started < 10_000, "the abort ended the call");
				assert.deepEqual(await survivors(value), []);
			} finally { killMarked(value); }
		});

		test("output and exit code pass through unchanged", { timeout: 15_000 }, async () => {
			const ok = await run(mode, "printf 'one\\ntwo\\n'; echo err >&2");
			assert.equal(ok.error, false);
			assert.match(ok.text, /^one\ntwo\nerr/);
			const failed = await run(mode, "echo bad; exit 3");
			assert.match(failed.text, /bad/);
			assert.match(failed.text, /exited with code 3/);
		});
	});
}
