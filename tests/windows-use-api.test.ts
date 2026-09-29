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
	assert.equal(snapshot.text, "Focused Window:\nNotepad\nUI Tree:\n- button");
	assert.equal(WIN_API.value("powershell", {}, listed, keep), listed.content[0]!.text);
	const plain = { content: [{ type: "text" as const, text: "[not json" }], isError: false };
	assert.equal((WIN_API.value("snapshot", {}, plain, keep) as { text: string }).text, "[not json");
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
