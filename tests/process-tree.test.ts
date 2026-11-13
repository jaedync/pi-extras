/**
 * The bash tool must leave no process of a call alive when the call ends:
 * at its timeout, at an abort, and at a normal end. That includes processes
 * that left the shell's group or session (GNU timeout, setsid) and processes
 * that ignore SIGTERM. Each test marks its processes with a unique sleep
 * length, and SIGKILLs every marked process at its end, pass or fail.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { scopeSupported, treeShellOperations, type TreeMode } from "../lib/process-tree.ts";
import { killMarked, marker as mark, survivors } from "./support/process-marks.ts";

const marker = () => mark(1000);

const GRACE_MS = 300;
const SCOPE = scopeSupported();

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
	{ mode: "group", skip: process.platform === "win32" ? "no process groups" : false },
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
				assert.deepEqual(await survivors(value, 1000), []);
			} finally { killMarked(value); }
		});

		// Off Linux the fallback has no session to read: a process that leaves the group and loses its parent before the first scan escapes it.
		const noSession = mode === "group" && process.platform !== "linux" ? "macOS fallback: no session, and the parent ended before the first scan" : false;
		test("a2. GNU timeout in the background, at a normal end before the first scan", { timeout: 15_000, todo: noSession }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `timeout 400 sh -c 'trap "" TERM; sleep ${value}' & sleep 0.3; echo started`);
				assert.equal(result.error, false, result.text);
				assert.match(result.text, /started/);
				assert.deepEqual(await survivors(value, 1000), []);
			} finally { killMarked(value); }
		});

		test("b. a setsid child started in the background, at a normal end", { timeout: 15_000, skip: mode === "group" ? "a group scan cannot see a setsid child whose parent ended" : false }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `setsid sh -c 'sleep ${value}' & echo started`);
				assert.equal(result.error, false, result.text);
				assert.match(result.text, /started/);
				assert.deepEqual(await survivors(value, 1000), []);
			} finally { killMarked(value); }
		});

		test("c. a TERM-ignoring child in the shell's own group, at a normal end", { timeout: 15_000 }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `sh -c 'trap "" TERM; sleep ${value}' & sleep 0.2; echo done`);
				assert.equal(result.error, false, result.text);
				assert.deepEqual(await survivors(value, 1000), []);
			} finally { killMarked(value); }
		});

		test("c2. a TERM-ignoring child in the shell's own group, at the timeout", { timeout: 15_000 }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `sh -c 'trap "" TERM; sleep ${value}'`, 1);
				assert.equal(result.error, true);
				assert.deepEqual(await survivors(value, 1000), []);
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
				assert.deepEqual(await survivors(value, 1000), []);
			} finally { killMarked(value); }
		});

		test("d2. an abort while the shell starts", { timeout: 15_000 }, async () => {
			const value = marker();
			const controller = new AbortController();
			try {
				const started = Date.now();
				const call = run(mode, `sh -c 'trap "" TERM; sleep ${value}'`, 30, controller.signal);
				controller.abort();
				const result = await call;
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
