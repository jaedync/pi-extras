import assert from "node:assert/strict";
import test from "node:test";
import { Guest, LAUNCHER } from "../lib/windows-use/guest.ts";
import { hostFrame } from "./support/windows-frames.ts";

/** A simulated Hyper-V guest behind the host's JSON-RPC methods. */
interface World {
	running: boolean;
	installed: boolean;
	/** Someone is signed in (a desktop session exists). */
	session: boolean;
	locked: boolean;
	/** Windows-MCP is listening. */
	server: boolean;
	/** A full-screen app hides the taskbar even when unlocked, until Start opens. */
	fullscreen?: boolean;
	/** Start is open, which shows the taskbar over anything on an unlocked desktop. */
	start?: boolean;
	/** The account has a password, so clicking Sign in changes nothing. */
	password?: boolean;
	/** Tool calls that fail at the transport before the server recovers. */
	dropNext?: number;
	/** Tool calls that run, then lose the connection before the answer arrives. */
	cutNext?: number;
	/** Status checks during which Windows is still starting (boot, updates) and sends no heartbeat. */
	booting?: number;
	/** Frames during which Windows is restarting with its heartbeat still on: a dark screen. */
	restarting?: number;
	/** Console calls that fail because the VM's devices vanish while it resets. */
	resetting?: number;
	/** How those calls fail; by default a missing device. */
	resetError?: string;
	/** The display is asleep: the screen is black, and the key that wakes it does nothing else. */
	asleep?: boolean;
	/** A restart under way: the desktop lingers for some frames, goes dark for more, then the logon task brings the server back. */
	restart?: { desktop: number; dark: number };
	/** Seconds since Windows started, as Hyper-V reports it. */
	uptime?: number;
	/** Probes before the logon task has the server listening. */
	serverAfter?: number;
	/** How the typed bootstrap goes: fails in the guest, never starts, or reports progress for this many probes. */
	bootstrap?: "fail" | "never" | number;
	/** The status the guest last published over KVP, prefixed by its run id. */
	published?: string;
	/** The lock check says locked while the desktop is in use, as a LogonUI in another session once did. */
	misreportsLock?: boolean;
}

function fakeHost(world: World) {
	const log: string[] = [];
	const unlocked = () => world.running && world.session && !world.locked;
	const taskbar = () => unlocked() && (!world.fullscreen || world.start === true);
	const host = {
		async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
			if (method === "mcp") {
				const message = JSON.parse(String(params.message));
				if (!world.server || (world.dropNext ?? 0) > 0) {
					if (world.dropNext) world.dropNext--;
					throw new Error(`cannot reach Windows-MCP on '${params.vm}' (10.0.0.2:8000): connection refused`);
				}
				if (message.id === undefined) return { messages: [] };
				if (message.method === "initialize") { log.push("mcp initialize"); return { messages: [{ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "windows-mcp" } } }] }; }
				const { name, arguments: args } = message.params;
				if (name === "PowerShell" && String(args.command).includes("LogonUI")) {
					log.push("mcp lock-check");
					assert.match(String(args.command), /SessionId/, "the lock check must look only at the server's own session");
					const locked = world.locked || world.misreportsLock === true;
					return { messages: [{ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `Response: ${locked ? "locked" : "unlocked"}\n\nStatus Code: 0` }], isError: false } }] };
				}
				log.push(`mcp ${name}`);
				if ((world.cutNext ?? 0) > 0) {
					world.cutNext!--;
					throw new Error(`lost the connection to Windows-MCP on '${params.vm}' (10.0.0.2:8000) during the call: connection reset`);
				}
				return { messages: [{ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }], isError: false } }] };
			}
			log.push(method);
			if ((world.resetting ?? 0) > 0 && ["frame", "key", "login"].includes(method)) {
				world.resetting!--;
				throw new Error(world.resetError ?? `Msvm_SyntheticMouse not found on '${params.vm}'`);
			}
			switch (method) {
				case "status": {
					const heartbeat = !((world.booting ?? 0) > 0);
					if (!heartbeat) world.booting!--;
					return { vm: params.vm, running: world.running, state: world.running ? "running" : "saved", installed: world.installed, heartbeat, uptime: world.uptime };
				}
				case "frame":
					if (world.asleep) return hostFrame({ taskbar: false, dark: true });
					if (world.restart) {
						if (world.restart.desktop > 0) { world.restart = { ...world.restart, desktop: world.restart.desktop - 1 }; return hostFrame({ taskbar: true }); }
						if (world.restart.dark > 0) { world.restart = { ...world.restart, dark: world.restart.dark - 1 }; return hostFrame({ taskbar: false, dark: true }); }
						world.restart = undefined;
						world.server = true;
					}
					if ((world.restarting ?? 0) > 0) { world.restarting!--; return hostFrame({ taskbar: false, dark: true }); }
					return hostFrame({ taskbar: taskbar() });
				case "probe":
					if (world.serverAfter !== undefined && world.serverAfter-- <= 0) world.server = true;
					if (typeof world.bootstrap === "number" && world.bootstrap-- <= 0) { world.server = true; world.published = "r2 OK listening on 8000"; }
					return { reachable: world.server, setup: world.published ?? null };
				case "key":
					log.push(`key ${params.keys}`);
					if (world.asleep) { world.asleep = false; return { ok: true }; }
					// The Windows key does nothing on lock and sign-in screens.
					if (params.keys === "win" && unlocked()) world.start = !world.start;
					if (params.keys === "esc") world.start = false;
					return { ok: true };
				case "login":
					assert.ok(!((world.booting ?? 0) > 0), "clicked while Windows was still starting");
					assert.ok(!((world.restarting ?? 0) > 0), "clicked while Windows was restarting");
					if (world.password) return { clicked: [512, 426] };
					if (world.locked) world.locked = false;
					else if (!world.session) { world.session = true; if (world.installed) world.server = true; }
					return { clicked: [512, 426] };
				case "setup":
					assert.ok(unlocked(), "setup must only run on an unlocked desktop");
					assert.equal(params.launcher, LAUNCHER);
					world.installed = true;
					if (world.bootstrap === "fail") world.published = "r2 FAIL uv tool install windows-mcp failed (2): Access is denied. (os error 5)";
					else if (world.bootstrap === "never") world.published ??= "r1 OK listening on 8000";
					else if (typeof world.bootstrap === "number") world.published = "r2 installing windows-mcp";
					else world.server = true;
					return { typed: 2900, run: "r2" };
				default: throw new Error(`unexpected host call ${method}`);
			}
		},
	};
	return { host, log };
}

function guest(world: World) {
	const { host, log } = fakeHost(world);
	let clock = 0;
	const notes: string[] = [];
	const g = new Guest({
		host, vm: "Win11", note: (text) => notes.push(text),
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	return { g, log, notes, advance: (ms: number) => { clock += ms; }, clock: () => clock };
}

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((block) => block.text ?? "").join("\n");

test("a ready guest runs the tool after one lock check, and nothing else", async () => {
	const { g, log, notes } = guest({ running: true, installed: true, session: true, locked: false, server: true });
	const result = await g.tool("Click", { label: 3 });
	assert.match(text(result), /^Click \{"label":3\}$/);
	assert.deepEqual(log, ["status", "mcp initialize", "mcp lock-check", "mcp Click"]);
	assert.deepEqual(notes, []);
});

test("the lock check is reused for a while, then repeated", async () => {
	const { g, log, advance } = guest({ running: true, installed: true, session: true, locked: false, server: true });
	await g.tool("Click", { label: 1 });
	await g.tool("Click", { label: 2 });
	assert.deepEqual(log.filter((entry) => entry === "mcp lock-check").length, 1);
	advance(60_000);
	await g.tool("Click", { label: 3 });
	assert.deepEqual(log.filter((entry) => entry === "mcp lock-check").length, 2);
});

test("a locked guest is signed back in before the tool runs", async () => {
	const world = { running: true, installed: true, session: true, locked: true, server: true };
	const { g, log, notes } = guest(world);
	await g.tool("Snapshot", {});
	assert.equal(world.locked, false);
	assert.ok(log.indexOf("login") < log.indexOf("mcp Snapshot"));
	assert.match(notes.join("\n"), /signed in/);
});

test("a VM that is not running is reported with how to start it, untouched", async () => {
	const { g, log } = guest({ running: false, installed: true, session: false, locked: false, server: false });
	await assert.rejects(g.tool("Snapshot", {}), /Win11 is saved.*win\.start/s);
	assert.deepEqual(log, ["status"]);
});

test("a fresh VM showing its desktop gets Windows-MCP installed, then runs the tool", async () => {
	const world = { running: true, installed: false, session: true, locked: false, server: false };
	const { g, log, notes } = guest(world);
	const result = await g.tool("Snapshot", {});
	assert.match(text(result), /^Snapshot/);
	assert.ok(!log.includes("login"), "an unlocked desktop is never clicked blind");
	assert.ok(log.includes("setup"));
	assert.match(notes.join("\n"), /install/i);
});

test("a fresh VM at the sign-in screen is signed in first, then set up", async () => {
	const world = { running: true, installed: false, session: false, locked: false, server: false };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.indexOf("login") >= 0 && log.indexOf("login") < log.indexOf("setup"));
});

test("an installed VM that rebooted to the sign-in screen is signed in and the server comes back", async () => {
	const world = { running: true, installed: true, session: false, locked: false, server: false };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.includes("login"));
	assert.ok(!log.includes("setup"), "the logon task starts the server; no reinstall");
});

test("an installed VM whose server died on an unlocked desktop is repaired without clicking", async () => {
	const world = { running: true, installed: true, session: true, locked: false, server: false };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("login"));
	assert.ok(log.includes("setup"));
});

test("a full-screen app hiding the taskbar is told apart from a lock screen with the Windows key", async () => {
	const world: World = { running: true, installed: false, session: true, locked: false, server: false, fullscreen: true };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("login"), "an unlocked full-screen app is never clicked blind");
	assert.deepEqual(log.filter((entry) => entry.startsWith("key ")), ["key win", "key esc"], "Start is closed again after the check");
	assert.ok(log.includes("setup"));
});

test("a stopped server behind a full-screen app is reinstalled without signing in", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: false, fullscreen: true };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("login"));
	assert.ok(log.includes("setup"));
});

test("the Windows key check leaves a lock screen alone, and signing in follows", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.indexOf("key win") >= 0 && log.indexOf("key win") < log.indexOf("login"));
	assert.ok(!log.includes("key esc"), "nothing opened, so nothing to close");
});

test("a guest that stays locked after Sign in (a password) fails with a pointer to the console", async () => {
	const world: World = { running: true, installed: false, session: false, locked: false, server: false, password: true };
	const { g, log } = guest(world);
	await assert.rejects(g.tool("Snapshot", {}), /win\.console\.screenshot/);
	assert.ok(!log.includes("setup"));
});

test("a server that drops mid-session is reconnected and the call retried once", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true };
	const { g, log } = guest(world);
	await g.tool("Click", { label: 1 });
	world.dropNext = 1;
	const result = await g.tool("Click", { label: 2 });
	assert.match(text(result), /"label":2/);
	assert.equal(log.filter((entry) => entry === "mcp Click").length, 2);
});

test("a call whose connection drops mid-way is not run again, since it may have run", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true };
	const { g, log } = guest(world);
	await g.tool("Click", { label: 1 });
	world.cutNext = 1;
	await assert.rejects(g.tool("PowerShell", { command: "Restart-Computer" }), /may have run/);
	assert.equal(log.filter((entry) => entry === "mcp PowerShell").length, 1);
	const after = await g.tool("Click", { label: 2 });
	assert.match(text(after), /"label":2/);
	assert.ok(log.lastIndexOf("mcp initialize") > log.indexOf("mcp PowerShell"), "the next call reconnects first");
});

test("explicit login and setup are available to the script", async () => {
	const world = { running: true, installed: false, session: false, locked: false, server: false };
	const { g, log } = guest(world);
	await g.login();
	assert.equal(world.session, true);
	await g.setup();
	assert.equal(world.installed, true);
	assert.deepEqual(log.filter((entry) => entry === "login" || entry === "setup"), ["login", "setup"]);
});

test("an install that fails in the guest stops at once with the guest's reason", async () => {
	const { g, log, clock } = guest({ running: true, installed: false, session: true, locked: false, server: false, bootstrap: "fail" });
	await assert.rejects(g.tool("Snapshot", {}), (error: Error) => /Access is denied/.test(error.message) && /win\.console\.screenshot/.test(error.message));
	assert.equal(log.filter((entry) => entry === "probe").length, 1);
	assert.ok(clock() < 10_000);
});

test("an installer that never starts fails in two minutes, ignoring an earlier run's status", async () => {
	const { g, clock } = guest({ running: true, installed: false, session: true, locked: false, server: false, bootstrap: "never", published: "r1 OK listening on 8000" });
	await assert.rejects(g.tool("Snapshot", {}), /never started/);
	assert.ok(clock() >= 120_000 && clock() < 130_000, `gave up after ${clock()} ms`);
});

test("a slow install keeps waiting while the guest reports progress", async () => {
	const { g, log, clock } = guest({ running: true, installed: false, session: true, locked: false, server: false, bootstrap: 60 });
	await g.tool("Snapshot", {});
	assert.ok(log.includes("mcp Snapshot"));
	assert.ok(clock() > 120_000, "outlasted the start deadline because the guest reported progress");
});

test("a lock check that disagrees with the console never clicks on a desktop in use", async () => {
	const { g, log } = guest({ running: true, installed: true, session: true, locked: false, server: true, misreportsLock: true });
	await g.tool("Click", { label: 3 });
	assert.ok(!log.includes("login"), "the console showed the taskbar, so nothing was clicked");
	assert.ok(log.includes("mcp Click"));
});

test("a guest still starting (no heartbeat) is waited for before anything is clicked", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, booting: 4 };
	const { g, log, notes } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.includes("login") && log.includes("mcp Snapshot"));
	assert.ok(!log.includes("setup"), "the logon task brought the server back");
	assert.match(notes[0] ?? "", /waiting for Windows to finish starting/);
});

test("a guest that never finishes starting stops with a pointer to the console, unclicked", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, booting: Number.POSITIVE_INFINITY };
	const { g, log, clock } = guest(world);
	await assert.rejects(g.tool("Snapshot", {}), /did not finish starting.*win\.console\.screenshot/);
	assert.ok(!log.includes("login") && !log.includes("key"));
	assert.ok(clock() >= 15 * 60_000);
});

test("a guest restarting with its heartbeat still on (a dark screen) is waited for, then signed in once", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, restarting: 6 };
	const { g, log, notes } = guest(world);
	await g.tool("Snapshot", {});
	assert.equal(log.filter((entry) => entry === "login").length, 1);
	assert.ok(log.includes("mcp Snapshot") && !log.includes("setup"));
	assert.match(notes.join("\n"), /waiting for Windows to finish starting/);
});

test("a VM whose devices vanish mid-restart is waited for, not failed", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, resetting: 3 };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.includes("mcp Snapshot"));
});

test("a screen that stays dark ends the wait with a pointer to the console, unclicked", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, restarting: Number.POSITIVE_INFINITY };
	const { g, log } = guest(world);
	await assert.rejects(g.tool("Snapshot", {}), /did not finish starting.*win\.console\.screenshot/);
	assert.ok(!log.includes("login"));
});

test("a sleeping display is woken with Shift, so no Esc lands in the app in front", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: false, asleep: true };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	const keys = log.filter((entry) => entry.startsWith("key "));
	assert.equal(keys[0], "key shift");
	assert.ok(!keys.includes("key esc") && !log.includes("login"), keys.join(", "));
});

test("a desktop that lingers as a restart begins is waited out, not reinstalled over", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: false, restart: { desktop: 1, dark: 5 } };
	const { g, log, notes } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("setup"), "the logon task brought the server back after the restart");
	assert.ok(log.includes("mcp Snapshot"));
	assert.match(notes.join("\n"), /waiting for Windows to finish starting/);
});

test("console input refused as 'invalid state' mid-restart is waited out too", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, resetting: 2, resetError: "PressKey failed with code 32775 (invalid state: the VM may be saving, restarting or stopping)" };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.includes("mcp Snapshot"));
});

test("a guest that just restarted and signed itself in gets the logon task's time, not a reinstall", async () => {
	// Recovery first looks after the automatic sign-in: a steady desktop, and a server that takes 24 s to listen.
	const world: World = { running: true, installed: true, session: true, locked: false, server: false, uptime: 40, serverAfter: 8 };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("setup"));
	assert.ok(log.includes("mcp Snapshot"));
});

test("a server that stopped long after startup is still reinstalled after the short wait", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: false, uptime: 7200 };
	const { g, log, clock } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.includes("setup"));
	assert.ok(clock() < 90_000, `waited ${clock()} ms before reinstalling`);
});
