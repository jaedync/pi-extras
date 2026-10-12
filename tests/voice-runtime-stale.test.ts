import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvisionOptions } from "../lib/voice/provision.ts";

const home = mkdtempSync(join(tmpdir(), "voice-stale-"));
process.env.PI_VOICE_HOME = home;
process.env.PI_OFFLINE = "1";
const { default: voice, Setup, spawnVoiceDaemon } = await import("../extensions/voice.ts");

/** A provision run that waits for the test, then reports progress like the real one. */
function gatedProvision() {
	let release!: () => void;
	const gate = new Promise<void>((done) => (release = done));
	const provision = async (options: ProvisionOptions): Promise<"done" | "busy"> => {
		await gate;
		options.onProgress({ label: "downloading", fraction: 0.5 });
		options.onProgress(undefined);
		return "done";
	};
	return { provision, release };
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (error) => unhandled.push(error));
const settle = () => new Promise((done) => setTimeout(done, 20));

// /reload, /new and /resume make the session's ctx stale, and every ctx.ui call on it throws.
test("setup that finishes after its session ended calls nothing back", async () => {
	const { provision, release } = gatedProvision();
	const calls: string[] = [];
	const setup = new Setup({
		home, provision,
		onProgress: (label) => calls.push(`progress ${label}`),
		onFinish: () => calls.push("finish"),
		onCallbackError: () => calls.push("error"),
	});
	setup.start();
	setup.dispose();
	release();
	await settle();
	assert.deepEqual(calls, []);
	assert.equal(setup.busy, false);
	assert.deepEqual(unhandled, []);
});

test("a setup callback that throws is reported, and no rejection escapes", async () => {
	const { provision, release } = gatedProvision();
	const errors: unknown[] = [];
	const stale = () => { throw new Error("This extension ctx is stale after session replacement or reload."); };
	const setup = new Setup({ home, provision, onProgress: stale, onFinish: stale, onCallbackError: (error) => errors.push(error) });
	setup.start();
	release();
	await settle();
	assert.ok(errors.length >= 2, `${errors.length}`);
	assert.equal(setup.busy, false);
	assert.deepEqual(unhandled, []);
});

test("a disposed setup does not start again", async () => {
	const { provision, release } = gatedProvision();
	let runs = 0;
	const setup = new Setup({ home, provision: (options) => { runs++; return provision(options); }, onProgress() {}, onFinish() {}, onCallbackError() {} });
	setup.dispose();
	setup.start();
	release();
	await settle();
	assert.equal(runs, 0);
});

// spawn() returns before it knows; without an 'error' listener the EACCES that follows ends Pi.
test("a python that exists but cannot run is logged to daemon.log, not thrown", { skip: process.platform === "win32" }, async () => {
	const python = join(home, "python-not-executable");
	writeFileSync(python, "#!/bin/sh\n");
	chmodSync(python, 0o644);
	const errors: string[] = [];
	spawnVoiceDaemon(python, home, (message) => errors.push(message));
	await settle();
	assert.equal(errors.length, 1);
	assert.match(errors[0], /EACCES/);
	assert.match(readFileSync(join(home, "daemon.log"), "utf8"), /daemon could not start: EACCES/);
});

test("a new session replaces a runtime whose ctx went stale without a throw", async () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	voice({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler), registerCommand() {}, events: { on: () => () => {}, emit() {} } } as never);
	let stale = false;
	const ui = { setStatus() {}, notify() {}, onTerminalInput: () => () => {}, theme: { fg: (_: string, text: string) => text } };
	const old = { hasUI: true, mode: "tui", get ui() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return ui; } };
	handlers.get("session_start")!({}, old);
	stale = true;
	assert.doesNotThrow(() => handlers.get("session_start")!({}, { hasUI: true, mode: "tui", ui }));
	handlers.get("session_shutdown")!({}, { ui });
});

test.after(() => rmSync(home, { recursive: true, force: true }));
