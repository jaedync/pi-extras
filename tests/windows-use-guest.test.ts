import assert from "node:assert/strict";
import test from "node:test";
import { Guest } from "../lib/windows-use/guest.ts";
import { LAUNCHER } from "../lib/windows-use/install.ts";
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
	/** Tool calls that never answer, as when an app's UI Automation stops responding mid-snapshot. */
	hangNext?: number;
	/** The time limit the host was given for each tool call, by tool. */
	limits?: Record<string, number>;
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
	/** What opening an administrator's PowerShell leads to: by default it opens. */
	adminShell?: "opens" | "blocked";
	/** Windows OCR has no recognizer for the guest user's languages. */
	noOcr?: boolean;
	/** An administrator's PowerShell is on the console, ready for the installer. */
	shellOpen?: boolean;
	/** OCR reads the PowerShell window's title but not its prompt, as it sometimes can't. */
	promptUnread?: boolean;
	/** When the shell opened, by the test's clock. */
	shellAt?: number;
	/** How long after the shell opened the installer was typed. */
	typedAfter?: number;
	/** The test's clock, for the host to timestamp what it sees. */
	clock?: () => number;
	/** The window in front, as the guest's PowerShell reports it. */
	front?: { process: string; title: string; responding?: boolean };
	/** Snapshots stall on the window in front until its app is restarted (Start and Search) or goes. */
	stalls?: boolean;
	/** Every tool call stalls, the lock check included, until the server restarts; initialize still answers. */
	wedged?: boolean;
	/** The console's Run box is open. */
	runBox?: boolean;
	/** Win+R opens no Run box (something odd holds the console). */
	noRunBox?: boolean;
	/** Server restarts from the Run box. */
	restarts?: number;
	/** The server takes connections and answers nothing, initialize included, until restarted. */
	frozen?: boolean;
	/** Status checks during which Hyper-V reports the VM between states, as a restart inside Windows makes it. */
	transitioning?: number;
	/** The next snapshot never answers: Windows restarts under it, back at the sign-in screen. */
	restartsUnderSnapshot?: boolean;
	/** Windows-MCP runs with administrator rights (its logon task runs at the highest level). */
	elevatedServer?: boolean;
	/** The guest user is no administrator, so a task at the highest level still runs without rights. */
	standardUser?: boolean;
	/** What each setup asked for: administrator rights or not. */
	setups?: boolean[];
}

function fakeHost(world: World) {
	const log: string[] = [];
	const unlocked = () => world.running && world.session && !world.locked;
	const taskbar = () => unlocked() && (!world.fullscreen || world.start === true);
	const host = {
		async call(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<unknown> {
			if (method === "mcp") {
				const message = JSON.parse(String(params.message));
				if (!world.server || (world.dropNext ?? 0) > 0) {
					if (world.dropNext) world.dropNext--;
					throw new Error(`cannot reach Windows-MCP on '${params.vm}' (10.0.0.2:8000): connection refused`);
				}
				if (world.frozen) {
					log.push(`mcp ${message.method} (stalled)`);
					throw new Error(`windows_use host mcp timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`);
				}
				if (message.id === undefined) return { messages: [] };
				if (message.method === "initialize") { log.push("mcp initialize"); return { messages: [{ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "windows-mcp" } } }] }; }
				const { name, arguments: args } = message.params;
				const hang = (what: string) => {
					log.push(`mcp ${what} (stalled)`);
					throw new Error(`windows_use host mcp timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`);
				};
				const answer = (text: string) => ({ messages: [{ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: false } }] });
				const command = name === "PowerShell" ? String(args.command) : "";
				if (world.wedged) return hang(command.includes("LogonUI") ? "lock-check" : name);
				if (command.includes("GetForegroundWindow")) {
					log.push("mcp front-window");
					return answer(world.front ? `Response: ${JSON.stringify(world.front)}\n\nStatus Code: 0` : "Response: \n\nStatus Code: 0");
				}
				if (command.includes("StartMenuExperienceHost")) {
					log.push("mcp restart-shell");
					if (world.front && /^(SearchHost|StartMenuExperienceHost)$/.test(world.front.process)) world.stalls = false;
					return answer("Response: \n\nStatus Code: 0");
				}
				if (name === "Snapshot" && world.stalls) return hang("Snapshot");
				if (name === "Snapshot" && world.restartsUnderSnapshot) {
					world.restartsUnderSnapshot = false;
					world.server = false;
					world.session = false;
					world.uptime = 20;
					return hang("Snapshot");
				}
				if (name === "PowerShell" && String(args.command).includes("LogonUI")) {
					log.push("mcp lock-check");
					assert.match(String(args.command), /SessionId/, "the lock check must look only at the server's own session");
					const locked = world.locked || world.misreportsLock === true;
					const state = { id: 1, console: 1, state: 0, locked, elevated: world.elevatedServer === true };
					return answer(`Response: PI_WINDOWS_SESSION=${JSON.stringify(state)}\nStatus Code: 0`);
				}
				log.push(`mcp ${name}`);
				world.limits = { ...world.limits, [name]: options.timeoutMs ?? 0 };
				if ((world.hangNext ?? 0) > 0) {
					world.hangNext!--;
					throw new Error(`windows_use host mcp timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`);
				}
				if ((world.cutNext ?? 0) > 0) {
					world.cutNext!--;
					throw new Error(`lost the connection to Windows-MCP on '${params.vm}' (10.0.0.2:8000) during the call: connection reset`);
				}
				return { messages: [{ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }], isError: false } }] };
			}
			log.push(method);
			if ((world.transitioning ?? 0) > 0 && ["frame", "key", "login"].includes(method)) throw new Error(`VM '${params.vm}' is shutting down, not running`);
			if ((world.resetting ?? 0) > 0 && ["frame", "key", "login"].includes(method)) {
				world.resetting!--;
				throw new Error(world.resetError ?? `Msvm_SyntheticMouse not found on '${params.vm}'`);
			}
			switch (method) {
				case "status": {
					if ((world.transitioning ?? 0) > 0) {
						world.transitioning!--;
						return { vm: params.vm, running: false, state: "shutting down", installed: world.installed, heartbeat: null, uptime: null };
					}
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
					if (world.serverAfter !== undefined && world.serverAfter-- <= 0) { world.server = true; world.session = true; }
					if (typeof world.bootstrap === "number" && world.bootstrap-- <= 0) { world.server = true; world.published = "r2 OK listening on 8000"; }
					return { reachable: world.server, setup: world.published ?? null };
				case "type":
					log.push(`type ${params.text}`);
					if (world.runBox && /taskkill .*windows-mcp\.exe.*schtasks \/run \/tn windows-mcp-server/.test(String(params.text)) && String(params.text).endsWith("\n")) {
						world.wedged = false;
						world.frozen = false;
						world.restarts = (world.restarts ?? 0) + 1;
					}
					world.runBox = false;
					return { ok: true };
				case "key":
					log.push(`key ${params.keys}`);
					if (params.keys === "win+r" && unlocked() && !world.noRunBox) world.runBox = true;
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
				case "adminShell":
					assert.ok(unlocked(), "PowerShell must only be opened on an unlocked desktop");
					world.shellOpen = world.adminShell !== "blocked";
					world.shellAt = world.clock?.();
					return { ok: true };
				case "ocr":
					if (world.noOcr) throw new Error("Windows OCR has no recognizer for this Windows user's languages; add one with OCR support under Settings > Time & language");
					if (world.runBox) return ocrOf(["Run", "Type the name of a program, folder, document, or Internet", "resource, and Windows will open it for you.", "Open:", "OK Cancel Browse..."]);
					// As OCR reads it on a Hyper-V console, a letter off.
					if (!world.shellOpen) return ocrOf(["Recycle Bin", "Notepad Untitled"]);
					return ocrOf(["Administrator: Wndows PowerShell", "Wi ndows PowerShell", ...(world.promptUnread ? [] : ["PS C: \\WINDOWS\\system32>"])]);
				case "setup":
					assert.equal(options.timeoutMs, 10 * 60_000, "paced console bootstrap input needs its own bounded typing budget");
					assert.ok(unlocked(), "setup must only run on an unlocked desktop");
					assert.ok(world.shellOpen || world.noOcr, "the installer carries the server's key: type it only into an administrator's PowerShell");
					world.shellOpen = false;
					world.typedAfter = (world.clock?.() ?? 0) - (world.shellAt ?? 0);
					assert.equal(params.launcher, LAUNCHER);
					world.installed = true;
					world.setups = [...(world.setups ?? []), params.elevated === true];
					world.elevatedServer = params.elevated === true && !world.standardUser;
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

/** The host's OCR answer for these lines of text, one word per space. */
function ocrOf(lines: readonly string[]) {
	return { width: 1024, height: 768, lines: lines.map((line, row) => ({ words: line.split(" ").map((word, column) => ({ text: word, x: 10 + column * 80, y: 10 + row * 20, w: 70, h: 14 })) })) };
}

function guest(world: World, elevated?: boolean) {
	const { host, log } = fakeHost(world);
	let clock = 0;
	world.clock = () => clock;
	const notes: string[] = [];
	const g = new Guest({
		host, vm: "Win11", note: (text) => notes.push(text), elevated,
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
	assert.deepEqual(log, ["status", "mcp initialize", "mcp lock-check", "frame", "mcp Click"], "one small frame to see the display is awake");
	assert.deepEqual(notes, []);
});

test("a guest is ready, needing no repair before a call, only while connected and lately checked unlocked", async () => {
	const { g, advance } = guest({ running: true, installed: true, session: true, locked: false, server: true });
	assert.equal(g.ready(), false);
	await g.tool("Click", { label: 1 });
	assert.equal(g.ready(), true);
	advance(10 * 60_000);
	assert.equal(g.ready(), false);
	await g.tool("Click", { label: 1 });
	g.forget();
	assert.equal(g.ready(), false);
});

test("live session state is checked before each call, including within the former lock TTL", async () => {
	const { g, log, advance } = guest({ running: true, installed: true, session: true, locked: false, server: true });
	await g.tool("Click", { label: 1 });
	await g.tool("Click", { label: 2 });
	assert.deepEqual(log.filter((entry) => entry === "mcp lock-check").length, 2);
	advance(60_000);
	await g.tool("Click", { label: 3 });
	assert.deepEqual(log.filter((entry) => entry === "mcp lock-check").length, 3);
});

test("a locked guest is signed back in before the tool runs", async () => {
	const world = { running: true, installed: true, session: true, locked: true, server: true };
	const { g, log, notes } = guest(world);
	await g.tool("Snapshot", {});
	assert.equal(world.locked, false);
	assert.ok(log.indexOf("login") < log.indexOf("mcp Snapshot"));
	assert.match(notes.join("\n"), /signed in/);
});

test("a VM passing through shutting down, as a restart inside Windows makes it, is waited for, not reported as stopped", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, transitioning: 4 };
	const { g, log, notes } = guest(world);
	const result = await g.tool("Click", { loc: [1, 2] });
	assert.match(text(result), /^Click/);
	assert.match(notes.join("\n"), /waiting while Hyper-V shows the VM shutting down/);
	assert.ok(!log.includes("login"));
});

test("a VM that stays between states is reported after a while", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, transitioning: 10_000 };
	const { g, clock } = guest(world);
	await assert.rejects(g.tool("Click", { loc: [1, 2] }), /Win11 is shutting down, not running/);
	assert.ok(clock() >= 3 * 60_000 && clock() < 4 * 60_000, `waited ${clock()} ms`);
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

test("a fresh VM at the sign-in screen needs the user's desktop before setup", async () => {
	const world = { running: true, installed: false, session: false, locked: false, server: false };
	const { g, log } = guest(world);
	await assert.rejects(g.tool("Snapshot", {}), /Cannot confirm.*VM Connect/);
	assert.ok(!log.includes("login") && !log.includes("key") && !log.includes("setup"));
});

test("an installed VM that rebooted to sign-in waits for the user's connection without console input", async () => {
	const world = { running: true, installed: true, session: false, locked: false, server: false, serverAfter: 3 };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("login") && !log.includes("key"));
	assert.ok(!log.includes("setup"), "the logon task starts the server; no reinstall");
});

test("snapshots get longer for a while after the guest comes back, since a desktop just signed in to is slow to describe", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, serverAfter: 1 };
	const { g, advance } = guest(world);
	await g.tool("Snapshot", {});
	assert.equal(world.limits?.Snapshot, 90_000);
	advance(5 * 60_000);
	await g.tool("Snapshot", {});
	assert.equal(world.limits?.Snapshot, 30_000);
});

test("an installed VM whose server died on an unlocked desktop is repaired without clicking", async () => {
	const world = { running: true, installed: true, session: true, locked: false, server: false };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("login"));
	assert.ok(log.includes("setup"));
});

test("a confirmed console's full-screen app is told apart from a lock screen with the Windows key", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, fullscreen: true };
	const { g, log } = guest(world);
	await g.setup();
	assert.ok(!log.includes("login"), "an unlocked full-screen app is never clicked blind");
	assert.deepEqual(log.filter((entry) => entry.startsWith("key ")), ["key win", "key esc"], "Start is closed again after the check");
	assert.ok(log.includes("setup"));
});

test("an unreachable server behind an ambiguous full-screen picture gets no probe keys or setup", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: false, fullscreen: true };
	const { g, log } = guest(world);
	await assert.rejects(g.tool("Snapshot", {}), /Cannot confirm/);
	assert.ok(!log.includes("login") && !log.includes("key") && !log.includes("setup"));
});

test("a stale console observation does not authorize keys or sign-in after the server disappears", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	world.server = false;
	world.locked = true;
	g.forget();
	await assert.rejects(g.tool("Snapshot", {}), /Cannot confirm/);
	assert.ok(!log.includes("login") && !log.includes("key"));
});

test("a guest that stays locked after Sign in (a password) fails with a pointer to the console", async () => {
	const world: World = { running: true, installed: true, session: true, locked: true, server: true, password: true };
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

test("a tool call that hangs fails at its own limit with what to try, and is not repeated", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true };
	const { g, log } = guest(world);
	await g.tool("Click", { loc: [1, 2] });
	await g.tool("PowerShell", { command: "x", timeout: 100 });
	world.hangNext = 1;
	await assert.rejects(g.tool("Snapshot", { use_vision: true }), /Windows-MCP on Win11 didn't answer Snapshot within 30 s[\s\S]*use_ui_tree: false[\s\S]*win\.console\.key\(\{ vm: "Win11", keys: "esc" \}\)/);
	assert.deepEqual(world.limits, { Click: 120_000, PowerShell: 160_000, Snapshot: 30_000 });
	assert.equal(log.filter((entry) => entry === "mcp Snapshot").length, 1);
	world.hangNext = 1;
	await assert.rejects(g.tool("App", { mode: "launch", name: "x" }), /didn't answer App within 120 s; it may still be running in the guest, so it was not repeated/);
	await g.tool("Click", { loc: [3, 4] });
	assert.ok(log.lastIndexOf("mcp initialize") > log.lastIndexOf("mcp App"), "the next call reconnects first");
});

test("a snapshot stalled by Start or its search, which stopped answering, gets them restarted and is taken again", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, stalls: true, front: { process: "SearchHost", title: "Search" } };
	const { g, log, notes } = guest(world);
	const result = await g.tool("Snapshot", { use_vision: true });
	assert.match(text(result), /^Snapshot/);
	assert.deepEqual(log.filter((entry) => entry.startsWith("mcp Snapshot") || entry === "mcp front-window" || entry === "mcp restart-shell"), ["mcp Snapshot (stalled)", "mcp front-window", "mcp restart-shell", "mcp Snapshot"]);
	assert.match(notes.join("\n"), /Start or its search stopped answering/);
});

test("a snapshot cut off by Windows restarting is taken again once the guest is back, with the longer limit", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, front: { process: "explorer", title: "" } };
	const { g, log } = guest(world);
	await g.tool("Click", { loc: [1, 2] });
	world.restartsUnderSnapshot = true;
	world.serverAfter = 2;
	const result = await g.tool("Snapshot", {});
	assert.match(text(result), /^Snapshot/);
	assert.ok(!log.includes("login"), "waited for the user/logon task without taking the console");
	assert.equal(world.limits?.Snapshot, 90_000);
});

test("a snapshot stalled by an app's window names it and what to do instead, and isn't repeated", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, stalls: true, front: { process: "mmc", title: "Operations Console", responding: false } };
	const { g, log } = guest(world);
	await assert.rejects(g.tool("Snapshot", {}), (error: Error) =>
		/didn't answer Snapshot within 30 s/.test(error.message) && /"Operations Console" \(mmc, not responding\)/.test(error.message)
		&& /use_ui_tree: false/.test(error.message) && /win\.console\.ocr/.test(error.message));
	assert.equal(log.filter((entry) => entry.startsWith("mcp Snapshot")).length, 1);
	assert.ok(!log.includes("mcp restart-shell"), "an app is not the tool's to restart");
});

test("a guest asked for administrator rights installs Windows-MCP with them", async () => {
	const world: World = { running: true, installed: false, session: true, locked: false, server: false };
	const { g, notes } = guest(world, true);
	await g.tool("Click", { loc: [1, 2] });
	assert.deepEqual(world.setups, [true]);
	assert.doesNotMatch(notes.join("\n"), /administrator rights/, "installed with them from the start: nothing to redo");
});

test("a server without the rights the session asks for is reinstalled with them, once, then the call runs", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true };
	const { g, log, notes, advance } = guest(world, true);
	const result = await g.tool("Click", { loc: [1, 2] });
	assert.match(text(result), /^Click/);
	assert.deepEqual(world.setups, [true]);
	assert.match(notes.join("\n"), /Windows-MCP ran without administrator rights, and PI_WINDOWS_USE_ELEVATED asks for them: reinstalling it/);
	advance(10 * 60_000);
	await g.tool("Click", { loc: [3, 4] });
	assert.equal(log.filter((entry) => entry === "setup").length, 1);
});

test("a server with administrator rights the session doesn't ask for is reinstalled without them", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, elevatedServer: true };
	const { g, notes } = guest(world);
	await g.tool("Click", { loc: [1, 2] });
	assert.deepEqual(world.setups, [false]);
	assert.equal(world.elevatedServer, false);
	assert.match(notes.join("\n"), /Windows-MCP ran with administrator rights, which PI_WINDOWS_USE_ELEVATED doesn't ask for: reinstalling it without them/);
});

test("a guest user who is no administrator gets one reinstall, then a note, not a reinstall on every check", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, standardUser: true };
	const { g, notes, advance } = guest(world, true);
	await g.tool("Click", { loc: [1, 2] });
	advance(10 * 60_000);
	await g.tool("Click", { loc: [3, 4] });
	assert.deepEqual(world.setups, [true]);
	assert.match(notes.join("\n"), /still runs without administrator rights: the guest user may not be an administrator/);
});

test("a server stuck on an earlier call, answering no tool at all, is restarted from the console's Run box and the call goes through", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, wedged: true };
	const { g, log, notes } = guest(world);
	const result = await g.tool("Click", { loc: [1, 2] });
	assert.match(text(result), /^Click/);
	assert.equal(world.restarts, 1);
	assert.ok(log.indexOf("key win+r") < log.findIndex((entry) => entry.startsWith("type cmd /c")), "the Run box opens before anything is typed");
	assert.match(notes.join("\n"), /restarted it from the console's Run box/);
	assert.equal(log.filter((entry) => entry.startsWith("mcp Click")).length, 1, "the call runs once, after the restart");
});

test("a server wedged between calls is repaired before sending the next snapshot", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true };
	const { g } = guest(world);
	await g.tool("Click", { loc: [1, 2] });
	world.wedged = true;
	assert.match(text(await g.tool("Snapshot", {})), /^Snapshot/);
	assert.equal(world.restarts, 1);
	await g.tool("Click", { loc: [3, 4] });
});

test("a server that takes connections but answers nothing, not even initialize, is restarted from the Run box, not reinstalled", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, frozen: true };
	const { g, log, clock } = guest(world);
	const result = await g.tool("Click", { loc: [1, 2] });
	assert.match(text(result), /^Click/);
	assert.equal(world.restarts, 1);
	assert.ok(!log.includes("setup") && !log.includes("adminShell"));
	assert.ok(clock() < 90_000, `took ${clock()} ms`);
});

test("without a Run box to type into, a stuck server isn't typed at blind; the error points to win.setup", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, wedged: true, noRunBox: true };
	const { g, log } = guest(world);
	await assert.rejects(g.tool("Click", { loc: [1, 2] }), /stopped answering[\s\S]*Run box didn't open[\s\S]*win\.setup/);
	assert.ok(!log.some((entry) => entry.startsWith("type ")));
});

test("a display that went to sleep is woken with Shift before the tool runs, since Windows-MCP would read a stale screen", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true };
	const { g, log, notes, advance } = guest(world);
	await g.tool("Click", { loc: [1, 2] });
	assert.ok(!log.includes("key shift"), "an awake display gets no key");
	world.asleep = true;
	advance(60_000);
	await g.tool("Snapshot", {});
	assert.ok(!world.asleep);
	const shift = log.indexOf("key shift");
	assert.ok(shift > 0 && shift < log.lastIndexOf("mcp Snapshot"), "woken before the snapshot");
	assert.ok(!log.includes("login") && !log.includes("key win"), "an unlocked desktop is only woken, never clicked or given the Windows key");
	assert.deepEqual(notes, ["Win11: woke the display, which had gone dark"]);
});

test("explicit login and setup work for a freshly confirmed console session", async () => {
	const world = { running: true, installed: true, session: true, locked: true, server: true };
	const { g, log } = guest(world);
	await g.login();
	assert.equal(world.session, true);
	await g.setup();
	assert.equal(world.installed, true);
	assert.deepEqual(log.filter((entry) => entry === "login" || entry === "setup"), ["login", "setup"]);
});

test("the installer, which carries the server's key, is typed only once the console shows an administrator's PowerShell", async () => {
	const world = { running: true, installed: false, session: true, locked: false, server: false };
	const { g, log } = guest(world);
	await g.setup();
	const order = log.filter((entry) => ["adminShell", "ocr", "setup"].includes(entry));
	assert.deepEqual(order.slice(0, 1), ["adminShell"]);
	assert.equal(order.at(-1), "setup");
	assert.ok(order.includes("ocr"));
});

test("when no administrator's PowerShell opens, nothing is typed and the error says what the screen shows", async () => {
	const world = { running: true, installed: false, session: true, locked: false, server: false, adminShell: "blocked" as const };
	const { g, log, clock } = guest(world);
	await assert.rejects(g.tool("Snapshot", {}), (error: Error) => /administrator's PowerShell didn't open/.test(error.message) && /Notepad Untitled/.test(error.message) && /nothing was typed/.test(error.message));
	assert.ok(!log.includes("setup"));
	assert.ok(clock() < 30_000, `gave up after ${clock()} ms`);
});

test("a PowerShell whose prompt OCR can't read still gets the installer, after a longer wait for it to take input", async () => {
	const world: World = { running: true, installed: false, session: true, locked: false, server: false, promptUnread: true };
	const { g, log } = guest(world);
	await g.setup();
	assert.ok(log.includes("setup"));
	assert.ok(world.typedAfter! >= 9_000, `typed ${world.typedAfter} ms after the shell opened`);
});

test("with its prompt showing, the installer follows soon", async () => {
	const world: World = { running: true, installed: false, session: true, locked: false, server: false };
	const { g } = guest(world);
	await g.setup();
	assert.ok(world.typedAfter! < 9_000, `typed ${world.typedAfter} ms after the shell opened`);
});

test("without Windows OCR to check the console, the installer is typed as before", async () => {
	const world = { running: true, installed: false, session: true, locked: false, server: false, noOcr: true };
	const { g, log } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(log.includes("setup"));
	assert.ok(log.includes("mcp Snapshot"));
});

test("an install that fails in the guest stops at once with the guest's reason", async () => {
	const { g, log, clock } = guest({ running: true, installed: false, session: true, locked: false, server: false, bootstrap: "fail" });
	await assert.rejects(g.tool("Snapshot", {}), (error: Error) => /Access is denied/.test(error.message) && /win\.console\.screenshot/.test(error.message));
	assert.equal(log.slice(log.indexOf("setup")).filter((entry) => entry === "probe").length, 1);
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
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, booting: 4, serverAfter: 2 };
	const { g, log, notes } = guest(world);
	await g.tool("Snapshot", {});
	assert.ok(!log.includes("login") && log.includes("mcp Snapshot"));
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

test("a guest restarting with its heartbeat still on is waited for without unconfirmed keys or sign-in", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, restarting: 6, serverAfter: 1 };
	const { g, log, notes } = guest(world);
	await g.tool("Snapshot", {});
	assert.equal(log.filter((entry) => entry === "login").length, 0);
	const key = log.indexOf("key");
	assert.ok(key < 0 || log.indexOf("mcp lock-check") < key, "only a freshly confirmed console may be woken");
	assert.ok(log.includes("mcp Snapshot") && !log.includes("setup"));
	assert.match(notes.join("\n"), /waiting for Windows to finish starting/);
});

test("a VM whose devices vanish mid-restart is waited for, not failed", async () => {
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, resetting: 3, serverAfter: 1 };
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

test("a confirmed console's sleeping display is woken with Shift, so no Esc lands in the app in front", async () => {
	const world: World = { running: true, installed: true, session: true, locked: false, server: true, asleep: true };
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
	const world: World = { running: true, installed: true, session: false, locked: false, server: false, resetting: 2, serverAfter: 1, resetError: "PressKey failed with code 32775 (invalid state: the VM may be saving, restarting or stopping)" };
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
