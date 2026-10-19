import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireParent, LeaseHeld, takeOverParent } from "../lib/subagents/ownership.ts";

const posixOnly = { skip: process.platform === "win32" };

/** A lease as an earlier parent wrote it, owned by `pid`. */
function lease(dir: string, owner: Record<string, unknown>): string {
	const lock = join(dir, ".owner");
	mkdirSync(lock, { recursive: true });
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ token: "earlier", host: hostname(), ...owner }));
	return lock;
}
const stat = (pid: number) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
	for (const start = Date.now(); !condition(); await new Promise((resolve) => setTimeout(resolve, 20))) {
		if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
	}
}
const exited = (child: ChildProcess) => new Promise<string | null>((resolve) => {
	if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
	else child.once("exit", (_code, signal) => resolve(signal));
});

test("a suspended owner still holds the lease, and the error names its state and the commands that free it", posixOnly, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lease-suspended-"));
	const owner = spawn("sleep", ["60"], { stdio: "ignore" });
	t.after(() => { owner.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
	const pid = owner.pid!;
	lease(dir, { pid });
	process.kill(pid, "SIGSTOP");
	await until(() => stat(pid).startsWith("T"), "the owner to stop");
	assert.throws(() => acquireParent(dir), (error: unknown) => {
		assert.ok(error instanceof LeaseHeld);
		assert.equal(error.pid, pid);
		assert.equal(error.state, "suspended");
		assert.match(error.message, new RegExp(`already owned by process ${pid}, which is suspended \\(Ctrl-Z\\)`));
		assert.ok(error.message.includes(`kill -TERM ${pid}; kill -CONT ${pid}`), error.message);
		assert.ok(error.message.includes("/subagents takeover"), error.message);
		return true;
	});
	process.kill(pid, "SIGCONT");
	await until(() => !stat(pid).startsWith("T"), "the owner to continue");
	assert.throws(() => acquireParent(dir), (error: unknown) => error instanceof LeaseHeld && error.state === "running" && /which is still running/.test(error.message));
});

test("takeover ends a suspended owner on this host, and the lease is then free", posixOnly, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lease-takeover-"));
	const owner = spawn("sleep", ["60"], { stdio: "ignore" });
	t.after(() => { owner.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
	const pid = owner.pid!;
	lease(dir, { pid });
	process.kill(pid, "SIGSTOP");
	await until(() => stat(pid).startsWith("T"), "the owner to stop");
	const gone = exited(owner);
	assert.deepEqual(await takeOverParent(dir), { ok: true, pid });
	// SIGCONT after SIGTERM: a stopped process acts on the pending SIGTERM only once it runs again.
	assert.equal(await gone, "SIGTERM");
	acquireParent(dir)();
});

test("takeover refuses another host's lease and this process's own, and reports an owner that does not quit", posixOnly, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lease-refused-"));
	const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => { stubborn.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });

	const lock = lease(dir, { pid: process.pid, host: "other-host.example" });
	const other = await takeOverParent(dir);
	assert.equal(other.ok, false);
	assert.match(other.ok ? "" : other.error, /on other-host\.example.*Quit it there/);
	assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token, "earlier", "the lease is left as it was");

	rmSync(lock, { recursive: true });
	lease(dir, { pid: process.pid });
	const own = await takeOverParent(dir);
	assert.match(own.ok ? "" : own.error, /this Pi process/);

	await new Promise((resolve) => stubborn.stdout!.once("data", resolve));
	rmSync(lock, { recursive: true });
	lease(dir, { pid: stubborn.pid });
	const slow = await takeOverParent(dir, { waitMs: 300 });
	assert.match(slow.ok ? "" : slow.error, new RegExp(`Process ${stubborn.pid} did not quit`));
	assert.equal(stubborn.exitCode, null, "takeover never escalates past SIGTERM");
	assert.throws(() => acquireParent(dir), LeaseHeld);
});

test("takeover of a free or dead lease has nothing to end", posixOnly, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lease-free-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.deepEqual(await takeOverParent(dir), { ok: true });
	const dead = spawn("true", [], { stdio: "ignore" });
	await exited(dead);
	lease(dir, { pid: dead.pid });
	assert.deepEqual(await takeOverParent(dir), { ok: true });
	acquireParent(dir)();
});

test("an owner that has exited but is not yet reaped (a zombie) holds no lease", posixOnly, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lease-zombie-"));
	// `sleep` never waits for the child the shell started before it took the shell's place.
	const reaper = spawn("sh", ["-c", "true & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => { reaper.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
	const pid = Number(await new Promise<string>((resolve) => reaper.stdout!.once("data", (data) => resolve(String(data).trim()))));
	await until(() => stat(pid).startsWith("Z"), "the child to become a zombie");
	lease(dir, { pid });
	acquireParent(dir)();
});

test("takeover says so when the owner lets the lease go, then stops again on its terminal restore", posixOnly, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lease-restop-"));
	const lock = join(dir, ".owner");
	// As Pi does: session_shutdown frees the lease, then raw mode set from the background stops it (SIGTTOU).
	const owner = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => { require("node:fs").rmSync(${JSON.stringify(lock)}, { recursive: true }); setTimeout(() => process.kill(process.pid, "SIGSTOP"), 200); }); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => { owner.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
	await new Promise((resolve) => owner.stdout!.once("data", resolve));
	lease(dir, { pid: owner.pid });
	const result = await takeOverParent(dir);
	assert.equal(result.ok, true);
	assert.match(result.ok ? result.notice ?? "" : "", new RegExp(`Process ${owner.pid} let the subagents go but is still suspended\\. Run fg in its terminal`));
});
