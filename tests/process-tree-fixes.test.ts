/**
 * The tree-kill bash operations behave as Pi's own operations do where Pi
 * defines the behavior (timeout limit, missing working directory), say when the
 * end of a call ended background processes, run the command when systemd-run
 * cannot start a scope, and add one exit listener for each process, however
 * often the module loads. Each test SIGKILLs its marked processes at its end.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { scopeProbeCached, scopeSupported, treeShellOperations, type TreeMode } from "../lib/process-tree.ts";
import { killMarked, marker as mark, survivors } from "./support/process-marks.ts";

const marker = () => mark(4000);
const linux = process.platform === "linux";
const SCOPE = scopeSupported();
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const ops = (mode: TreeMode) => treeShellOperations(() => ({ shell: "/bin/bash", args: ["-c"] }), { graceMs: 300, mode });

type Execute = (id: string, params: { command: string; timeout?: number }, signal?: AbortSignal) => Promise<{ content: { text: string }[] }>;

async function run(mode: TreeMode, command: string, options: { timeout?: number; cwd?: string } = {}): Promise<{ text: string; error: boolean }> {
	const execute = createBashToolDefinition(options.cwd ?? process.cwd(), { operations: ops(mode) }).execute as unknown as Execute;
	try {
		const result = await execute(`call-${Math.random()}`, { command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) });
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
	describe(`the end of a call tells what it ended (${mode})`, { skip }, () => {
		test("a background process that the end ended is named, with the way to keep one", { timeout: 15_000 }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `sleep ${value} & echo started`);
				assert.equal(result.error, false, result.text);
				assert.match(result.text, /^started\n/);
				assert.match(result.text, /Ended 1 background process when the call ended: sleep \(pid \d+\)\./);
				assert.match(result.text, /shell job/);
				assert.match(result.text, /systemd-run --user --unit/);
				assert.deepEqual(await survivors(value, 1000), []);
			} finally { killMarked(value); }
		});

		test("at most 5 names, then a count", { timeout: 15_000 }, async () => {
			const value = marker();
			try {
				const result = await run(mode, `for i in 1 2 3 4 5 6 7; do sleep ${value} & done; echo started`);
				assert.equal(result.error, false, result.text);
				assert.match(result.text, /Ended 7 background processes when the call ended: (sleep \(pid \d+\), ){4}sleep \(pid \d+\) and 2 more\./);
				assert.deepEqual(await survivors(value, 1000), []);
			} finally { killMarked(value); }
		});

		test("no notice when the call leaves nothing", { timeout: 15_000 }, async () => {
			const result = await run(mode, "echo hi");
			assert.equal(result.error, false, result.text);
			assert.equal(result.text.trim(), "hi");
		});

		test("a timeout above Pi's limit is refused as Pi refuses it", { timeout: 15_000 }, async () => {
			const result = await run(mode, "echo ran", { timeout: 3_000_000 });
			assert.equal(result.error, true);
			assert.equal(result.text, "Invalid timeout: maximum is 2147483.647 seconds");
		});

		test("a missing working directory gives Pi's error", { timeout: 15_000 }, async () => {
			const cwd = join(tmpdir(), `no-such-dir-${process.pid}-${Math.random()}`);
			const result = await run(mode, "echo ran", { cwd });
			assert.equal(result.error, true);
			assert.equal(result.text, `Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
		});
	});
}

describe("a systemd-run that cannot start the scope", { skip: SCOPE ? false : "no systemd user scope here" }, () => {
	async function direct(env: NodeJS.ProcessEnv): Promise<{ output: string; exitCode: number | null }> {
		let output = "";
		const result = await ops("auto").exec("echo ran", process.cwd(), { onData: (chunk: Buffer) => { output += chunk.toString(); }, env });
		return { output, exitCode: result.exitCode };
	}

	test("a systemd-run that exits 1 before the command starts: the command runs in group mode", { timeout: 15_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "tree-fake-systemd-run-"));
		dirs.push(dir);
		writeFileSync(join(dir, "systemd-run"), "#!/bin/sh\necho 'Failed to connect to bus: fake' >&2\nexit 1\n");
		chmodSync(join(dir, "systemd-run"), 0o755);
		assert.equal(scopeSupported(), true);
		const result = await direct({ ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` });
		assert.equal(result.output, "ran\n");
		assert.equal(result.exitCode, 0);
		assert.equal(scopeProbeCached(), false, "the failure drops the cached probe");
	});

	test("no user bus in the call's environment: the command runs in group mode", { timeout: 15_000 }, async () => {
		const env = { ...process.env };
		delete env.XDG_RUNTIME_DIR;
		delete env.DBUS_SESSION_BUS_ADDRESS;
		assert.equal(scopeSupported(), true);
		const result = await direct(env);
		assert.equal(result.output, "ran\n");
		assert.equal(result.exitCode, 0);
	});
});

test("12 loads of the module add at most one exit listener", { timeout: 15_000 }, async () => {
	const before = process.listenerCount("exit");
	for (let load = 0; load < 12; load += 1) {
		const fresh = await import(new URL(`../lib/process-tree.ts?load=${load}`, import.meta.url).href) as typeof import("../lib/process-tree.ts");
		new fresh.Tree(2 ** 22 + 1, undefined).dispose();
	}
	assert.ok(process.listenerCount("exit") - before <= 1, `exit listeners added: ${process.listenerCount("exit") - before}`);
});
