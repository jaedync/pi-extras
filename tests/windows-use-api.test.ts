import assert from "node:assert/strict";
import test from "node:test";
import { CodeExecutor } from "../lib/computer-use/executor.ts";
import { WIN_API, WinSession, describeWinCall, toMcp, vmAllowlist } from "../lib/windows-use/api.ts";
import type { Guest, HostCalls } from "../lib/windows-use/guest.ts";
import { hostFrame } from "./support/windows-frames.ts";

test("guest methods map onto Windows-MCP tools, with labels or coordinates", () => {
	assert.deepEqual(toMcp("snapshot", { vm: "A" }), { tool: "Snapshot", args: { use_vision: true } });
	assert.deepEqual(toMcp("snapshot", { vm: "A", use_vision: false }), { tool: "Snapshot", args: { use_vision: false } });
	assert.deepEqual(toMcp("click", { vm: "A", label: 7 }), { tool: "Click", args: { label: 7 } });
	assert.deepEqual(toMcp("click", { vm: "A", x: 10, y: 20, button: "right", clicks: 2 }), { tool: "Click", args: { loc: [10, 20], button: "right", clicks: 2 } });
	assert.deepEqual(toMcp("type", { vm: "A", label: 3, text: "hi", clear: true, enter: true }), { tool: "Type", args: { text: "hi", label: 3, clear: true, press_enter: true } });
	assert.deepEqual(toMcp("scroll", { vm: "A", x: 1, y: 2, direction: "down", amount: 5 }), { tool: "Scroll", args: { loc: [1, 2], direction: "down", wheel_times: 5 } });
	assert.deepEqual(toMcp("key", { vm: "A", keys: "ctrl+c" }), { tool: "Shortcut", args: { shortcut: "ctrl+c" } });
	assert.deepEqual(toMcp("powershell", { vm: "A", command: "whoami" }), { tool: "PowerShell", args: { command: "whoami" } });
	assert.deepEqual(toMcp("app", { vm: "A", mode: "launch", name: "notepad" }), { tool: "App", args: { mode: "launch", name: "notepad" } });
	assert.deepEqual(toMcp("call", { vm: "A", tool: "Clipboard", args: { mode: "get" } }), { tool: "Clipboard", args: { mode: "get" } });
	assert.throws(() => toMcp("call", { vm: "A" }), /win\.call needs/);
	assert.deepEqual(toMcp("powershell", { vm: "A", command: "x", timeout: 540 }), { tool: "PowerShell", args: { command: "x", timeout: 540 } });
	assert.throws(() => toMcp("powershell", { vm: "A", command: "x", timeout: 900 }), /at most 540 seconds.*Start-Process/);
});

test("calls are described by VM and target for the tool row", () => {
	assert.deepEqual(describeWinCall("click", { vm: "Win11", label: 4, clicks: 2 }), { app: "Win11", detail: "#4 ×2" });
	assert.deepEqual(describeWinCall("type", { vm: "Win11", text: "hello\nworld", enter: true }), { app: "Win11", detail: '"hello↵world" ↵' });
	assert.deepEqual(describeWinCall("console.drag", { vm: "Win11", x: 1, y: 2, x2: 3, y2: 4 }), { app: "Win11", detail: "(1, 2) → (3, 4)" });
	assert.deepEqual(describeWinCall("vms", {}), { app: undefined, detail: "" });
});

function fakeHost(): { host: HostCalls; calls: [string, Record<string, unknown>][] } {
	const calls: [string, Record<string, unknown>][] = [];
	return {
		calls,
		host: {
			async call(method, params = {}) {
				calls.push([method, params]);
				if (method === "vms") return [{ name: "A", state: "running", running: true, installed: true, ip: "10.0.0.2" }];
				if (method === "frame") return hostFrame({ taskbar: true, width: 64, height: 48 });
				if (method === "ocr") return { width: 64, height: 48, lines: [
					{ words: [{ text: "File", x: 2, y: 2, w: 8, h: 6 }, { text: "Edit", x: 20, y: 2, w: 8, h: 6 }] },
					{ words: [{ text: "Platform", x: 2, y: 30, w: 20, h: 6 }, { text: "Manager", x: 24, y: 30, w: 18, h: 6 }] },
				] };
				return { ok: true };
			},
		},
	};
}

function fakeGuest(log: string[]): (vm: string, note: (text: string) => void) => Guest {
	return (vm, note) => ({
		vm,
		async tool(name: string, args: Record<string, unknown>) {
			log.push(`${vm} ${name} ${JSON.stringify(args)}`);
			if (name === "Snapshot") note(`${vm}: installing Windows-MCP`);
			if (name === "Clipboard" && args.mode === "get") return { content: [{ type: "text", text: vm === "A" ? "Clipboard content:\nold" : "Clipboard is empty or contains non-text data." }], isError: false };
			return name === "Snapshot"
				? { content: [{ type: "text", text: "tree" }, { type: "image", data: "IMG", mimeType: "image/png" }], isError: false }
				: { content: [{ type: "text", text: `${name} done` }], isError: false };
		},
		async login() { log.push(`${vm} login`); },
		async setup() { log.push(`${vm} setup`); },
		forget() { log.push(`${vm} forget`); },
		recheck() {},
	}) as unknown as Guest;
}

test("scripts batch host and guest calls through one executor", async () => {
	const { host, calls } = fakeHost();
	const log: string[] = [];
	const session = new WinSession(host, fakeGuest(log));
	const executor = new CodeExecutor({ session, api: WIN_API });
	const result = await executor.execute(`
		const vms = await win.vms();
		const s = await win.snapshot({ vm: vms[0].name });
		emit(s.text);
		emitImage(s.screenshot);
		await win.click({ vm: "A", label: 2 });
		const shot = await win.console.screenshot({ vm: "A" });
		emit(shot.text);
		emitImage(shot.screenshot);
		await win.console.click({ vm: "A", x: 5, y: 6, double: true });
		await win.console.type({ vm: "A", text: "abc\\n" });
	`, { approve: async () => "deny" });
	assert.equal(result.error, undefined, JSON.stringify(result.content));
	assert.deepEqual(result.content.slice(0, 3), [
		{ type: "text", text: "tree" },
		{ type: "image", data: "IMG", mimeType: "image/png" },
		{ type: "text", text: '{"width":64,"height":48}' },
	]);
	const png = result.content[3];
	assert.ok(png?.type === "image" && Buffer.from(png.data, "base64").subarray(1, 4).toString() === "PNG", "the console screenshot is a PNG");
	assert.deepEqual(log, ['A Snapshot {"use_vision":true}', 'A Click {"label":2}']);
	assert.deepEqual(calls.map(([method]) => method), ["vms", "frame", "click", "type"]);
	assert.deepEqual(calls[2]![1], { vm: "A", x: 5, y: 6, double: true });
	assert.deepEqual(session.drainNotes(), ["A: installing Windows-MCP"]);
	assert.deepEqual(session.drainNotes(), []);
	assert.deepEqual(result.calls.map((call) => [call.method, call.app ?? ""]), [["vms", ""], ["snapshot", "A"], ["click", "A"], ["console.screenshot", "A"], ["console.click", "A"], ["console.type", "A"]]);
});

test("every VM-scoped method insists on a VM name and valid coordinates", async () => {
	const session = new WinSession(fakeHost().host, fakeGuest([]));
	await assert.rejects(session.call("snapshot", {}, {}), /needs \{ vm: .*win\.vms\(\)/);
	await assert.rejects(session.call("console.click", { vm: "A", x: 1 }, {}), /number for y/);
	await assert.rejects(session.call("console.type", { vm: "A" }, {}), /needs \{ vm, text \}/);
});

test("starting a VM makes its guest reconnect from scratch", async () => {
	const { host, calls } = fakeHost();
	const log: string[] = [];
	const session = new WinSession(host, fakeGuest(log));
	await session.call("start", { vm: "A" }, {});
	assert.deepEqual(calls.map(([method]) => method), ["start"]);
	assert.deepEqual(log, ["A forget"]);
});

test("win.sleep pauses between console steps without the host, bounded and cancellable", async () => {
	const { host, calls } = fakeHost();
	const session = new WinSession(host, fakeGuest([]));
	const started = Date.now();
	await session.call("sleep", { ms: 30 }, {});
	assert.ok(Date.now() - started >= 25);
	assert.deepEqual(calls, []);
	await assert.rejects(session.call("sleep", {}, {}), /win\.sleep needs \{ ms \}/);
	await assert.rejects(session.call("sleep", { ms: 120_000 }, {}), /at most 60000/);
	const aborted = AbortSignal.abort();
	await assert.rejects(session.call("sleep", { ms: 10_000 }, { signal: aborted }), /cancelled/);
	assert.deepEqual(describeWinCall("sleep", { ms: 1500 }), { app: undefined, detail: "1500 ms" });
});

test("console input makes that VM's guest check its lock again, since recovery can't see it", async () => {
	const { host } = fakeHost();
	const log: string[] = [];
	const makeGuest = fakeGuest(log);
	const session = new WinSession(host, (vm, note) => Object.assign(makeGuest(vm, note), { recheck() { log.push(`${vm} recheck`); } }));
	await session.call("snapshot", { vm: "A" }, {});
	await session.call("console.key", { vm: "A", keys: "win+l" }, {});
	await session.call("console.key", { vm: "B", keys: "enter" }, {});
	assert.deepEqual(log.filter((entry) => entry.endsWith("recheck")), ["A recheck"], "only a guest already in use, for that VM");
});

test("snapshot text that Windows-MCP sent as a JSON list reads as plain lines; other methods keep theirs", () => {
	const keep = () => ({ type: "screenshot", id: "1" }) as const;
	const listed = { content: [{ type: "text" as const, text: JSON.stringify(["Focused Window:\nNotepad", "UI Tree:\n- button"]) }], isError: false };
	const snapshot = WIN_API.value("snapshot", {}, listed, keep) as { text: string };
	assert.equal(snapshot.text, "Focused Window:\nNotepad\n\nUI Tree:\n- button");
	assert.equal(WIN_API.value("key", {}, listed, keep), listed.content[0]!.text);
	const plain = { content: [{ type: "text" as const, text: "[not json" }], isError: false };
	assert.equal((WIN_API.value("snapshot", {}, plain, keep) as { text: string }).text, "[not json");
});

test("win.powershell resolves to its output and exit status, without Windows-MCP's wrapping", () => {
	const keep = () => ({ type: "screenshot", id: "1" }) as const;
	const result = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });
	assert.deepEqual(WIN_API.value("powershell", {}, result("Response: a\r\nb  \r\n\nStatus Code: 0"), keep), { output: "a\nb", status: 0 });
	assert.deepEqual(WIN_API.value("powershell", {}, result("Response: Get-Item : Cannot find path\nStatus Code: 1"), keep), { output: "Get-Item : Cannot find path", status: 1 });
	assert.deepEqual(WIN_API.value("powershell", {}, result("Response: \nStatus Code: 0"), keep), { output: "", status: 0 });
	assert.deepEqual(WIN_API.value("powershell", {}, result("something else"), keep), { output: "something else", status: null });
});

test("win.type without a place pastes into the focused control in order, keys between lines, and restores the clipboard", async () => {
	const { host, calls } = fakeHost();
	const log: string[] = [];
	const session = new WinSession(host, fakeGuest(log));
	await session.call("type", { vm: "A", text: "two\nlines\tend", clear: true, enter: true }, {});
	assert.deepEqual(log, [
		'A Clipboard {"mode":"get"}',
		'A Shortcut {"shortcut":"ctrl+a"}', 'A Shortcut {"shortcut":"backspace"}',
		'A Clipboard {"mode":"set","text":"two"}', 'A Shortcut {"shortcut":"ctrl+v"}',
		'A Shortcut {"shortcut":"enter"}',
		'A Clipboard {"mode":"set","text":"lines"}', 'A Shortcut {"shortcut":"ctrl+v"}',
		'A Shortcut {"shortcut":"tab"}',
		'A Clipboard {"mode":"set","text":"end"}', 'A Shortcut {"shortcut":"ctrl+v"}',
		'A Shortcut {"shortcut":"enter"}',
		'A Clipboard {"mode":"set","text":"old"}',
	]);
	assert.deepEqual(calls, [], "no console input, which arrives late and out of order");
	log.length = 0;
	await session.call("type", { vm: "B", text: "x" }, {});
	assert.deepEqual(log, ['B Clipboard {"mode":"get"}', 'B Clipboard {"mode":"set","text":"x"}', 'B Shortcut {"shortcut":"ctrl+v"}'], "a clipboard without text is left as the paste left it");
	log.length = 0;
	await session.call("type", { vm: "A", text: "at", x: 5, y: 6 }, {});
	assert.equal(log.at(-1), 'A Type {"text":"at","loc":[5,6]}', "a place still goes to Windows-MCP, which clicks it first");
	await assert.rejects(session.call("type", { vm: "A" }, {}), /win\.type needs \{ vm, text \}/);
});

test("win.sleep also takes the milliseconds alone", () => {
	assert.deepEqual(WIN_API.args!("sleep", 1500), { ms: 1500 });
	assert.deepEqual(WIN_API.args!("sleep", { ms: 5 }), { ms: 5 });
	assert.deepEqual(WIN_API.args!("snapshot", { vm: "A" }), { vm: "A" });
	assert.deepEqual(WIN_API.args!("snapshot", undefined), {});
});

test("a session limited to one VM uses it when a call names none", async () => {
	const log: string[] = [];
	const one = new WinSession(fakeHost().host, fakeGuest(log), ["Win11-Lab"]);
	await one.call("key", { keys: "win" }, {});
	assert.deepEqual(log, ['Win11-Lab Shortcut {"shortcut":"win"}']);
	const two = new WinSession(fakeHost().host, fakeGuest([]), ["Win11-Lab", "Other"]);
	await assert.rejects(two.call("key", { keys: "win" }, {}), /needs \{ vm: /);
});

test("PI_WINDOWS_USE_VMS names the only VMs a session may see or touch, case-insensitively", async () => {
	assert.equal(vmAllowlist({}), undefined);
	assert.equal(vmAllowlist({ PI_WINDOWS_USE_VMS: " , " }), undefined);
	assert.deepEqual(vmAllowlist({ PI_WINDOWS_USE_VMS: " Win11-Lab , Test VM " }), ["Win11-Lab", "Test VM"]);

	const calls: string[] = [];
	const host = {
		async call(method: string, params: Record<string, unknown> = {}) {
			calls.push(`${method} ${String(params.vm ?? "")}`.trim());
			return method === "vms" ? [{ name: "Win11-Lab", state: "running" }, { name: "Production", state: "running" }] : { ok: true };
		},
	};
	const log: string[] = [];
	const session = new WinSession(host, fakeGuest(log), vmAllowlist({ PI_WINDOWS_USE_VMS: "Win11-Lab" }));
	const first = (await session.call("vms", {}, {})).content[0];
	const listed = JSON.parse(first?.type === "text" ? first.text : "[]");
	assert.deepEqual(listed.map((vm: { name: string }) => vm.name), ["Win11-Lab"], "other VMs aren't even listed");
	for (const method of ["snapshot", "start", "setup", "login", "console.screenshot", "console.key", "console.click"]) {
		await assert.rejects(session.call(method, { vm: "Production", keys: "win", x: 1, y: 1 }, {}), /"Production" is not a VM this session may use \(PI_WINDOWS_USE_VMS: Win11-Lab\)/, method);
	}
	assert.deepEqual(calls.filter((call) => call !== "vms"), [], "nothing reached the host for Production");
	assert.deepEqual(log, [], "nor a guest");
	await session.call("console.key", { vm: "WIN11-LAB", keys: "win" }, {});
	assert.ok(calls.includes("key WIN11-LAB"));
});

/**
 * A guest whose snapshots fail as on the secure desktop, with a UAC prompt up
 * for `prompts` checks; after `grabs` failed captures they work again, as when
 * the lock behind them is signed out of.
 */
function secureDesktop(log: string[], prompts: number, grabs = Number.POSITIVE_INFINITY): (vm: string, note: (text: string) => void) => Guest {
	let left = prompts;
	let failing = grabs;
	return (vm) => ({
		vm,
		async tool(name: string, args: Record<string, unknown>) {
			log.push(`${vm} ${name}`);
			const text = name === "PowerShell" && String(args.command).includes("consent")
				? `Response: ${left > 0 ? (left--, 1) : 0}\nStatus Code: 0`
				: failing-- > 0 ? "Error capturing desktop state: screen grab failed. Please try again." : `${name} ok`;
			return { content: [{ type: "text", text }], isError: false };
		},
		forget() {},
		recheck() { log.push(`${vm} recheck`); },
	}) as unknown as Guest;
}

test("a snapshot Windows-MCP can't capture fails and says why, naming a UAC prompt when one is up", async () => {
	const log: string[] = [];
	const uac = new WinSession(fakeHost().host, secureDesktop(log, 1));
	await assert.rejects(uac.call("snapshot", { vm: "A" }, {}), /A UAC prompt is showing on A.*win\.uac\(\{ vm: "A", answer: "yes" \}\)/);
	assert.ok(log.includes("A recheck"), "the lock is checked again before the next call");
	const other = new WinSession(fakeHost().host, secureDesktop([], 0));
	await assert.rejects(other.call("screenshot", { vm: "A" }, {}), /couldn't capture A's screen.*win\.console\.screenshot/);
});

test("a capture stopped by a lock since the last check is taken again after the lock check, which signs in", async () => {
	const log: string[] = [];
	const result = await new WinSession(fakeHost().host, secureDesktop(log, 0, 1)).call("snapshot", { vm: "A" }, {});
	assert.match(JSON.stringify(result.content), /Snapshot ok/);
	assert.deepEqual(log.filter((entry) => entry !== "A PowerShell"), ["A Snapshot", "A recheck", "A Snapshot"]);
});

test("a snapshot of the lock screen, locked since the last check, is taken again after signing in", async () => {
	const log: string[] = [];
	let locked = true;
	const guest = (vm: string) => ({
		vm,
		async tool(name: string) {
			log.push(`${vm} ${name}`);
			const focused = locked ? "Windows Default Lock Screen" : "Editor";
			return { content: [{ type: "text", text: `Cursor Position: (1, 1)\n\n    Focused Window:\n    Name                         Depth  Status  Width  Height  Handle\n---------------------------  -----  ------  -----  ------  ------\n${focused}      0  Normal   1024     768     1\n\n    UI Tree:\n    desktop\n    └── window "${focused}"` }], isError: false };
		},
		forget() {},
		recheck() { log.push(`${vm} recheck`); locked = false; },
	}) as unknown as Guest;
	const result = await new WinSession(fakeHost().host, guest).call("snapshot", { vm: "A" }, {});
	assert.match(JSON.stringify(result.content), /Editor/);
	assert.doesNotMatch(JSON.stringify(result.content), /Lock Screen/);
	assert.deepEqual(log, ["A Snapshot", "A recheck", "A Snapshot"]);
});

test("win.call with a tool Windows-MCP lacks, or wrong arguments, fails listing its tools and their arguments", async () => {
	const guest = (vm: string) => ({
		vm,
		async tool(name: string, args: Record<string, unknown>) {
			if (name === "Evaluate") throw new Error("Unknown tool: 'Evaluate'");
			if (name === "Scrape" && !args.url) return { content: [{ type: "text", text: "1 validation error for call[scrape_tool]\nurl\n  Missing required argument [type=missing_argument, input_value={}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.13/v/missing_argument" }], isError: true };
			return { content: [{ type: "text", text: `${name} done` }], isError: false };
		},
		async tools() {
			return [
				{ name: "Scrape", inputSchema: { properties: { url: {}, query: {}, use_dom: {}, ctx: {} }, required: ["url"] } },
				{ name: "Clipboard", inputSchema: { properties: { mode: {}, text: {} }, required: ["mode"] } },
			];
		},
		forget() {},
		recheck() {},
	}) as unknown as Guest;
	const session = new WinSession(fakeHost().host, guest);
	await assert.rejects(session.call("call", { vm: "A", tool: "Evaluate", args: {} }, {}), /Unknown tool: 'Evaluate'\. Windows-MCP's tools \(\? marks optional arguments\): Clipboard\(mode, text\?\), Scrape\(url, query\?, use_dom\?\)$/);
	await assert.rejects(session.call("call", { vm: "A", tool: "Scrape", args: {} }, {}), /1 validation error for call\[scrape_tool\] url Missing required argument[^\n]*Scrape\(url, query\?, use_dom\?\)$/);
	await assert.rejects(session.call("call", { vm: "A", tool: "Scrape", args: "https://example.com" }, {}), /win\.call's args must be an object/);
	assert.deepEqual((await session.call("call", { vm: "A", tool: "Scrape", args: { url: "https://example.com" } }, {})).content, [{ type: "text", text: "Scrape done" }]);
});

test("an app launch whose window check fails in UI Automation says the app may be open, so it isn't launched twice", async () => {
	const guest = (vm: string) => ({
		vm,
		async tool() { return { content: [{ type: "text", text: "Error calling tool 'App': (-2147220991, 'An event was unable to invoke any of the subscribers', (None, None, None, 0, None))" }], isError: true }; },
		forget() {},
		recheck() {},
	}) as unknown as Guest;
	await assert.rejects(new WinSession(fakeHost().host, guest).call("app", { vm: "A", mode: "launch", name: "Microsoft Edge" }, {}), /Microsoft Edge may have opened[\s\S]*snapshot before launching it again/);
});

test("win.uac answers a prompt through the console and waits for it to close; it never types a password", async () => {
	const { host, calls } = fakeHost();
	const answered = await new WinSession(host, secureDesktop([], 2), undefined, async () => {}).call("uac", { vm: "A", answer: "yes" }, {});
	assert.deepEqual(answered.content, [{ type: "text", text: "Answered the UAC prompt on A: yes." }]);
	assert.deepEqual(calls, [["key", { vm: "A", keys: "alt+y" }]]);
	calls.length = 0;
	await new WinSession(host, secureDesktop([], 1), undefined, async () => {}).call("uac", { vm: "A", answer: "no" }, {});
	assert.deepEqual(calls, [["key", { vm: "A", keys: "esc" }]]);
	await assert.rejects(new WinSession(host, secureDesktop([], 0), undefined, async () => {}).call("uac", { vm: "A", answer: "yes" }, {}), /No UAC prompt is showing on A/);
	await assert.rejects(new WinSession(host, secureDesktop([], 99), undefined, async () => {}).call("uac", { vm: "A", answer: "yes" }, {}), /still showing.*password/);
	await assert.rejects(new WinSession(host, secureDesktop([], 1)).call("uac", { vm: "A", answer: "maybe" }, {}), /answer: "yes"/);
});

test("win.console.ocr reads the console's text as items with click points, optionally in a region", async () => {
	const { host, calls } = fakeHost();
	const session = new WinSession(host, fakeGuest([]));
	const executor = new CodeExecutor({ session, api: WIN_API });
	const result = await executor.execute(`
		const all = await win.console.ocr({ vm: "A" });
		emit(all.text);
		emit(all.items.find((item) => item.text === "Platform Manager"));
		const part = await win.console.ocr({ vm: "A", x: 0, y: 20, width: 64, height: 28 });
		emit(part.text);
	`, { approve: async () => "deny" });
	assert.equal(result.error, undefined, JSON.stringify(result.content));
	assert.deepEqual(result.content.map((block) => block.type === "text" ? block.text : ""), [
		"(6,5) File\n(24,5) Edit\n(22,33) Platform Manager",
		JSON.stringify({ text: "Platform Manager", x: 22, y: 33 }, null, 2),
		"(22,33) Platform Manager",
	]);
	assert.deepEqual(calls.map(([method]) => method), ["ocr", "ocr"]);
	assert.deepEqual(describeWinCall("console.ocr", { vm: "A", x: 0, y: 20, width: 64, height: 28 }), { app: "A", detail: "(0, 20) 64×28" });
	await assert.rejects(session.call("console.ocr", { vm: "A", width: 10 }, {}), /win\.console\.ocr needs x, y, width and height together/);
});

/** A host whose display sleeps until a key arrives: black frames and no OCR text meanwhile. */
function sleepyHost() {
	const calls: string[] = [];
	let asleep = true;
	const host: HostCalls = {
		async call(method, params = {}) {
			calls.push(method === "key" ? `key ${params.keys}` : method);
			if (method === "key") { asleep = false; return { ok: true }; }
			if (method === "frame") return hostFrame({ taskbar: !asleep, dark: asleep, width: 64, height: 48 });
			if (method === "ocr") return { width: 64, height: 48, lines: asleep ? [] : [{ words: [{ text: "Start", x: 2, y: 40, w: 10, h: 6 }] }] };
			throw new Error(`unexpected ${method}`);
		},
	};
	return { host, calls };
}

test("console.screenshot and console.ocr wake a display that went dark, and say so", async () => {
	const shot = sleepyHost();
	const session = new WinSession(shot.host, fakeGuest([]), undefined, async () => {});
	const result = await session.call("console.screenshot", { vm: "A" }, {});
	const png = result.content[1];
	assert.ok(png?.type === "image");
	assert.deepEqual(shot.calls, ["frame", "key shift", "frame", "frame"]);
	assert.deepEqual(session.drainNotes(), ["A: woke the display, which had gone dark"]);

	const read = sleepyHost();
	const reader = new WinSession(read.host, fakeGuest([]), undefined, async () => {});
	const first = (await reader.call("console.ocr", { vm: "A" }, {})).content[0];
	const ocr = JSON.parse(first?.type === "text" ? first.text : "{}");
	assert.equal(ocr.text, "(7,43) Start");
	assert.deepEqual(read.calls, ["ocr", "frame", "key shift", "frame", "ocr"], "read again once awake");
	assert.deepEqual(reader.drainNotes(), ["A: woke the display, which had gone dark"]);
});
