import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpLink } from "../lib/computer-use/mcp-link.ts";
import { HostSession } from "../lib/windows-use/host.ts";

// Under WSL a powershell.exe that cannot run fails after spawn returns; with no 'error' listener Pi exits.
test("a client that cannot start fails its calls instead of throwing an uncaught error", { skip: process.platform === "win32" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mcp-link-spawn-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const exe = join(dir, "powershell.exe");
	writeFileSync(exe, "MZ not runnable here");
	chmodSync(exe, 0o644);
	const uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => uncaught.push(error);
	process.on("uncaughtException", onUncaught);
	t.after(() => process.off("uncaughtException", onUncaught));
	const link = new McpLink(spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] }));
	await assert.rejects(link.request("tools/list", {}), /Computer Use client failed to start: .*EACCES/);
	assert.equal(link.closed, true);
	await assert.rejects(link.request("tools/list", {}), /failed to start/);
	assert.deepEqual(uncaught, []);
});

// spawn() returns at once and reports EACCES on the next tick, before a promise callback could attach a listener.
test("a windows_use host that cannot start, spawned at the top of a macrotask, fails its call", { skip: process.platform === "win32" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "host-spawn-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const exe = join(dir, "powershell.exe");
	writeFileSync(exe, "MZ not runnable here");
	chmodSync(exe, 0o644);
	const uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => uncaught.push(error);
	process.on("uncaughtException", onUncaught);
	t.after(() => process.off("uncaughtException", onUncaught));
	const host = new HostSession({ idleMs: 1000, launch: () => spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] }) });
	// Wrapped, so the outer promise does not adopt the call's rejection.
	const { call } = await new Promise<{ call: Promise<unknown> }>((done) => setTimeout(() => done({ call: host.call("vms") }), 0));
	await assert.rejects(call, /failed to start: .*EACCES/);
	host.close();
	assert.deepEqual(uncaught, []);
});

test("an error on the client's stdout or stderr fails the calls instead of throwing", async () => {
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
	const link = new McpLink(proc);
	const call = link.request("tools/list", {});
	assert.doesNotThrow(() => proc.stderr.emit("error", new Error("EPIPE")));
	assert.doesNotThrow(() => proc.stdout.emit("error", new Error("read EIO")));
	await assert.rejects(call, /read EIO/);
});
