/** Guest recovery over the Hyper-V socket relay, with and without the guest's IP route (a VPN cuts it). */
import assert from "node:assert/strict";
import test from "node:test";
import { Guest, type HostCalls } from "../lib/windows-use/guest.ts";
import type { ControlOp, RelayCalls } from "../lib/windows-use/relay-channel.ts";
import { relayDeployCommands } from "../lib/windows-use/relay-deploy.ts";
import type { ControlReply } from "../lib/windows-use/relay.ts";
import { TransportError } from "../lib/windows-use/transport.ts";
import { hostFrame } from "./support/windows-frames.ts";

const CONSOLE_INPUT = new Set(["key", "click", "move", "drag", "scroll", "type", "cad", "login", "adminShell", "setup"]);

interface Rig {
	/** The relay answers on its Hyper-V sockets. */
	relay: boolean;
	/** Windows-MCP listens on the guest's loopback. */
	server: boolean;
	/** The guest's IP route reaches the server; a full-tunnel VPN blocks it. */
	ip: boolean;
	/** Every tool call hangs until the server restarts. */
	wedged: boolean;
	/** A restart through the relay brings the server back. */
	restartWorks: boolean;
	/** schtasks can't start the server's task again. */
	runFails: boolean;
	/** The relay's restart op itself fails at the transport. */
	restartThrows: boolean;
	/** The relay install command fails in the guest. */
	deployFails: boolean;
	/** What the install reports about the capture flash. */
	flash: "added" | "present" | "absent";
	/** The relay started by the Run key isn't elevated even though the server's task is. */
	relayElevated: boolean;
	serverElevated: boolean;
	session: { id: number; console: number; state: number; locked: boolean };
	/** The relay's session query fails. */
	sessionFails: boolean;
	restarts: number;
	deploys: number;
	log: string[];
}

function rig(overrides: Partial<Rig> = {}) {
	const world: Rig = {
		relay: true, server: true, ip: false, wedged: false, restartWorks: true, runFails: false, restartThrows: false, deployFails: false,
		flash: "present", relayElevated: false, serverElevated: false, session: { id: 2, console: 1, state: 0, locked: false },
		sessionFails: false, restarts: 0, deploys: 0, log: [], ...overrides,
	};
	let clock = 0;
	const unsent = (what: string) => new TransportError(what, true);
	/** Windows-MCP itself, whichever route reaches it. */
	const serve = (route: string, raw: string, timeoutMs = 0): unknown[] => {
		const message = JSON.parse(raw);
		if (message.id === undefined) return [];
		const reply = (result: unknown) => [{ jsonrpc: "2.0", id: message.id, result }];
		if (message.method === "initialize") { world.log.push(`${route} initialize`); return reply({ serverInfo: { name: "windows-mcp" } }); }
		const { name, arguments: args } = message.params;
		const command = String(args.command ?? "");
		const text = (value: string, isError = false) => reply({ content: [{ type: "text", text: value }], isError });
		if (world.wedged) { world.log.push(`${route} ${name} (stalled)`); throw new TransportError(`windows_use tunnel mcp timed out after ${Math.round(timeoutMs / 1000)} s`, false, true); }
		if (command.includes("LogonUI")) {
			world.log.push(`${route} session-check`);
			return text(`Response: PI_WINDOWS_SESSION=${JSON.stringify({ ...world.session, elevated: world.serverElevated })}\nStatus Code: 0`);
		}
		if (command.includes("PI_RELAY_DEPLOYED=")) {
			world.deploys++;
			world.log.push(`${route} deploy-install`);
			if (world.deployFails) return text("Response: Access is denied.\nStatus Code: 1");
			world.relay = true;
			return text(`Response: PI_RELAY_DEPLOYED=${JSON.stringify({ mode: "task", flash: world.flash })}\nStatus Code: 0`);
		}
		if (command.includes("guest-relay.py.gz.b64")) { world.log.push(`${route} deploy-chunk`); return text("Response: \nStatus Code: 0"); }
		world.log.push(`${route} ${name}`);
		return text(`Response: ${name} done\nStatus Code: 0`);
	};
	const host: HostCalls = {
		async call(method, params = {}, options = {}) {
			if (CONSOLE_INPUT.has(method)) world.log.push(`CONSOLE ${method}`);
			switch (method) {
				case "status": return { vm: params.vm, running: true, state: "running", installed: true, heartbeat: true, uptime: 3600 };
				case "probe": return { reachable: world.ip && world.server, setup: null };
				case "frame": return hostFrame({ taskbar: true });
				case "mcp":
					if (!world.ip || !world.server) throw new Error(`cannot reach Windows-MCP on '${params.vm}' (10.0.0.2:8000): timed out`);
					if (world.wedged) { world.log.push("ip (stalled)"); throw new Error(`windows_use host mcp timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`); }
					return { messages: serve("ip", String(params.message), options.timeoutMs) };
				default:
					return { ok: true };
			}
		},
	};
	const control = async (op: ControlOp): Promise<ControlReply> => {
		if (!world.relay) throw unsent("connect timed out");
		world.log.push(`relay ${op}`);
		if (op === "ping") return { ok: true, relay: 1, pid: 42, listening: world.server, uptime: 3000 };
		if (op === "session") {
			if (world.sessionFails) return { ok: false, error: "session query failed: WTSQuerySessionInformationW (Windows error 5)" };
			return { ok: true, session: { ...world.session, elevated: world.relayElevated } };
		}
		if (world.restartThrows) throw new TransportError("the windows_use relay didn't answer within 60 s", false, true);
		world.restarts++;
		world.wedged = false;
		world.server = world.restartWorks && !world.runFails;
		return { ok: true, steps: [{ step: "end", code: 0 }, { step: "kill", code: 128 }, { step: "run", code: world.runFails ? 1 : 0 }] };
	};
	const relay: RelayCalls = {
		control,
		async mcp(message, options) {
			if (!world.relay) throw unsent("connect timed out");
			if (!world.server) throw unsent("Windows-MCP is not listening on 127.0.0.1:8000 (ConnectionRefusedError)");
			return serve("relay", message, options.timeoutMs);
		},
		forget() { world.log.push("relay forget"); },
	};
	const notes: string[] = [];
	const guest = new Guest({
		host, relay, vm: "Win11", note: (text) => notes.push(text),
		sleep: async (ms) => { clock += ms; }, now: () => clock,
		timing: { pollMs: 1_000, logonWaitMs: 30_000, restartWaitMs: 5_000 },
	});
	const consoleInput = () => world.log.filter((line) => line.startsWith("CONSOLE"));
	return { world, guest, notes, consoleInput };
}

test("with the IP route cut by a VPN, tool calls go over the relay and never touch the console", async () => {
	const { world, guest, consoleInput } = rig();
	const result = await guest.tool("Snapshot", {});
	assert.equal(result.isError, false);
	assert.ok(world.log.includes("relay Snapshot"));
	assert.ok(!world.log.some((line) => line.startsWith("ip ")), "the IP route is never used while the relay answers");
	assert.deepEqual(consoleInput(), []);
});

test("after one in-server rights check per connection, session checks come from the relay's native query", async () => {
	const { world, guest } = rig();
	await guest.tool("Snapshot", {});
	guest.recheck();
	await guest.tool("Snapshot", {});
	guest.recheck();
	await guest.tool("Snapshot", {});
	assert.equal(world.log.filter((line) => line.endsWith("session-check")).length, 1);
	assert.equal(world.log.filter((line) => line === "relay session").length, 2);
});

test("the server's own rights decide elevation, not a relay started at sign-in without them", async () => {
	const { world, guest, consoleInput } = rig({ relayElevated: true, serverElevated: false });
	await guest.tool("Snapshot", {});
	guest.recheck();
	await guest.tool("Snapshot", {});
	assert.deepEqual(consoleInput(), [], "no reinstall for a rights mismatch only the relay has");
	assert.equal(world.deploys, 0);
});

test("a relay session query that fails blocks the call rather than guessing the desktop is free", async () => {
	const { world, guest } = rig();
	await guest.tool("Snapshot", {});
	world.sessionFails = true;
	guest.recheck();
	await assert.rejects(guest.tool("Snapshot", {}), /could not report its live desktop session/);
	assert.equal(world.log.filter((line) => line === "relay Snapshot").length, 1);
});

test("over the IP route, the first call installs the relay through Windows-MCP, and later calls use it", async () => {
	const { world, guest, notes, consoleInput } = rig({ relay: false, ip: true });
	await guest.tool("Snapshot", {});
	assert.equal(world.log.filter((line) => line.startsWith("ip deploy")).length, relayDeployCommands().length);
	assert.ok(notes.some((note) => /installed a Hyper-V socket relay/.test(note)));
	world.ip = false;
	guest.recheck();
	await guest.tool("Snapshot", {});
	assert.ok(world.log.includes("relay Snapshot"), "a VPN connecting later doesn't cut Windows-MCP off");
	assert.deepEqual(consoleInput(), []);
});

test("a read-only inspect never installs the relay or restarts anything", async () => {
	const { world, guest } = rig({ relay: false, ip: true, flash: "added" });
	const state = await guest.inspect();
	assert.equal(state?.where, "remote");
	assert.equal(world.deploys, 0);
	assert.equal(world.restarts, 0);
});

test("installing the relay turns off the capture flash with one restart through the relay", async () => {
	const { world, guest, notes } = rig({ relay: false, ip: true, flash: "added" });
	await guest.tool("Snapshot", {});
	assert.equal(world.restarts, 1);
	assert.ok(notes.some((note) => /capture flash/.test(note)));
});

test("a failed relay install is noted once and the IP route keeps working", async () => {
	const { world, guest, notes } = rig({ relay: false, ip: true, deployFails: true });
	await guest.tool("Snapshot", {});
	guest.recheck();
	await guest.tool("Snapshot", {});
	assert.equal(world.deploys, 1, "no retry on every call");
	assert.equal(world.log.filter((line) => line === "ip Snapshot").length, 2);
	assert.equal(notes.filter((note) => /couldn't install the Hyper-V socket relay/.test(note)).length, 1);
});

test("a relay that stops answering after its install is installed again over the IP route", async () => {
	const { world, guest } = rig({ relay: false, ip: true });
	await guest.tool("Snapshot", {});
	assert.equal(world.deploys, 1);
	world.relay = false;
	guest.forget();
	await guest.tool("Snapshot", {});
	assert.equal(world.deploys, 2);
	assert.equal(world.relay, true);
});

test("a wedged server is restarted through the relay, not the console's Run box", async () => {
	const { world, guest, notes, consoleInput } = rig();
	await guest.tool("Snapshot", {});
	world.wedged = true;
	guest.recheck();
	await assert.rejects(guest.tool("Click", { loc: [1, 2] }), /didn't answer Click/);
	assert.equal(world.restarts, 1);
	assert.ok(notes.some((note) => /restarted it through the guest relay/.test(note)));
	assert.deepEqual(consoleInput(), []);
	guest.recheck();
	assert.equal((await guest.tool("Snapshot", {})).isError, false);
});

test("a stopped server behind a live relay is restarted through it, with no sign-in or install", async () => {
	const { world, guest, notes, consoleInput } = rig({ server: false });
	world.restartWorks = true;
	assert.equal((await guest.tool("Snapshot", {})).isError, false);
	assert.equal(world.restarts, 1);
	assert.ok(notes.some((note) => /wasn't answering; restarted it through the guest relay/.test(note)));
	assert.deepEqual(consoleInput(), []);
});

test("in an enhanced session, a relay restart that doesn't bring the server back falls back to the refusal, not the console", async () => {
	const { world, guest, notes, consoleInput } = rig({ server: false, restartWorks: false });
	await assert.rejects(guest.tool("Snapshot", {}), /enhanced\/remote session|Cannot confirm/);
	assert.equal(world.restarts, 1);
	assert.ok(notes.some((note) => /didn't come back/.test(note)));
	assert.deepEqual(consoleInput(), []);
});

test("a relay restart that fails at the transport doesn't escape recovery", async () => {
	const { world, guest, consoleInput } = rig({ server: false, restartThrows: true });
	await assert.rejects(guest.tool("Snapshot", {}), (error: Error) => !(error instanceof TransportError) && /enhanced\/remote session|Cannot confirm/.test(error.message));
	assert.deepEqual(consoleInput(), []);
	assert.equal(world.restarts, 0);
});

test("a relay restart whose task won't start isn't reported as a restart", async () => {
	const { world, guest, notes, consoleInput } = rig({ server: false, runFails: true });
	await assert.rejects(guest.tool("Snapshot", {}), /enhanced\/remote session/);
	assert.equal(world.restarts, 1);
	assert.ok(!notes.some((note) => /restarted it through the guest relay/.test(note)));
	assert.deepEqual(consoleInput(), []);
});

test("with the server down, inspect and console guards take the session from the relay, not the console picture", async () => {
	const { guest, consoleInput } = rig({ server: false });
	const state = await guest.inspect();
	assert.equal(state?.where, "remote");
	assert.equal(guest.where(), "remote");
	await assert.rejects(guest.assertConsole(), /enhanced\/remote session/);
	assert.deepEqual(consoleInput(), []);
});

test("at a confirmed basic-session console, a server the relay can't restart still gets the console repairs", async () => {
	const { world, guest, consoleInput } = rig({ server: false, restartWorks: false, session: { id: 1, console: 1, state: 0, locked: false } });
	await assert.rejects(guest.tool("Snapshot", {}));
	assert.equal(world.restarts, 1);
	assert.ok(consoleInput().includes("CONSOLE adminShell"), "reinstalling at the console stays available when the desktop is there");
});
