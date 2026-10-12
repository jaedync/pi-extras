import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpLink } from "../lib/computer-use/mcp-link.ts";

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
