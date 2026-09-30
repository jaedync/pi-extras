import assert from "node:assert/strict";
import test from "node:test";
import { Guest, type HostCalls } from "../lib/windows-use/guest.ts";
import { WinSession, WIN_API } from "../lib/windows-use/api.ts";
import { readFrame, toPng } from "../lib/windows-use/frame.ts";
import { hostFrame } from "./support/windows-frames.ts";

/** The server can move to RDP while the physical console becomes a different lock screen. */
function lab() {
	let state = { id: 1, console: 3, state: 0, locked: false, elevated: false };
	let online = true;
	let restoreOnProbe = false;
	let frozen = false;
	let hangTool = false;
	let malformed = false;
	let dark = false;
	let consoleDesktop = false;
	let grabFails = false;
	let consent = false;
	let metadata = "Screenshot Size: (640,480)\nVisible Displays: 0:DISPLAY (0,0,640,480) primary";
	const calls: string[] = [];
	const png = toPng(readFrame(hostFrame({ taskbar: true, width: 640, height: 480 })));
	const host: HostCalls = {
		async call(method, params = {}) {
			if (method === "mcp") {
				const req = JSON.parse(String(params.message));
				if (!online) throw new Error("cannot reach Windows-MCP: connection refused");
				if (frozen) throw new Error("windows_use host mcp timed out after 30 s");
				if (req.id === undefined) return { messages: [] };
				const reply = (result: unknown) => ({ messages: [{ id: req.id, result }] });
				if (req.method === "initialize") return reply({ serverInfo: { name: "test" } });
				const { name, arguments: args } = req.params;
				const command = String(args.command ?? "");
				const text = (value: string) => reply({ content: [{ type: "text", text: value }], isError: false });
				if (command.includes("LogonUI")) {
					calls.push("session-check");
					return text(malformed ? "Response: query failed\nStatus Code: 1" : `Response: PI_WINDOWS_SESSION=${JSON.stringify(state)}\nStatus Code: 0`);
				}
				calls.push(`guest ${name}`);
				if (hangTool) { frozen = true; throw new Error("windows_use host mcp timed out after 30 s"); }
				if (command.includes("consent")) return text(`Response: ${consent ? 1 : 0}\nStatus Code: 0`);
				if (name === "Screenshot" || name === "Snapshot") {
					return grabFails ? text("screen grab failed") : reply({ content: [{ type: "text", text: metadata }, { type: "image", mimeType: "image/png", data: png.toString("base64") }], isError: false });
				}
				return text("ok");
			}
			calls.push(`host ${method}`);
			if (method === "status") return { running: true, state: "running", installed: true, heartbeat: true, uptime: 7200 };
			if (method === "probe") { if (restoreOnProbe) online = true; return { reachable: online }; }
			if (method === "frame") return hostFrame({ taskbar: consoleDesktop, dark });
			if (method === "ocrImage") {
				assert.deepEqual(Buffer.from(params.png as number[]), png, "OCR receives the guest screenshot, not a console frame");
				return { width: 640, height: 480, lines: [{ words: [{ text: "Editor", x: 100, y: 50, w: 60, h: 20 }] }] };
			}
			if (method === "ocr") return { width: 1024, height: 768, lines: [] };
			throw new Error(`unexpected console action: ${method}`);
		},
	};
	const guest = new Guest({ host, vm: "Lab", sleep: async () => {}, timing: { restartWaitMs: 0, logonWaitMs: 0, bootWaitMs: 0 } });
	const session = new WinSession(host, () => guest, ["Lab"], async () => {});
	return {
		guest, session, calls,
		set: (next: Partial<typeof state>) => { state = { ...state, ...next }; },
		offline: () => { online = false; }, freeze: () => { frozen = true; }, badReply: () => { malformed = true; },
		sleepConsole: () => { dark = true; }, showConsole: () => { consoleDesktop = true; },
		failCapture: (uac = false) => { grabFails = true; consent = uac; },
		captureMetadata: (text: string) => { metadata = text; },
		hangNextTool: () => { hangTool = true; },
		recoverOnProbe: () => { restoreOnProbe = true; },
	};
}
const consoleInput = (calls: readonly string[]) => calls.filter((call) => /^host (key|click|move|drag|scroll|type|cad|login|adminShell|setup)$/.test(call));

test("enhanced-session tools never wake or inspect the separate console", async () => {
	const l = lab();
	l.sleepConsole();
	await l.guest.tool("Click", { loc: [10, 20] });
	assert.deepEqual(consoleInput(l.calls), []);
	assert.ok(!l.calls.includes("host frame"));
	assert.ok(l.calls.includes("guest Click"));
});

for (const change of [{ locked: true }, { state: 4 }, { state: 1 }, { console: 0xffffffff }]) {
	test(`a locked, disconnected or transitioning enhanced session is left alone: ${JSON.stringify(change)}`, async () => {
		const l = lab();
		l.set(change);
		await assert.rejects(l.guest.tool("Click", { loc: [10, 20] }), /session|VM Connect/i);
		assert.deepEqual(consoleInput(l.calls), []);
		assert.ok(!l.calls.includes("guest Click"));
	});
}

test("disconnecting between calls is checked before more guest input", async () => {
	const l = lab();
	await l.guest.tool("Click", {});
	l.set({ state: 4 });
	await assert.rejects(l.guest.tool("Click", {}), /disconnected/i);
	assert.equal(l.calls.filter((call) => call === "guest Click").length, 1);
	assert.deepEqual(consoleInput(l.calls), []);
});

for (const failure of ["offline", "freeze"] as const) {
	test(`enhanced session ${failure}: no console repair, even after forget or when a console desktop appears`, async () => {
		const l = lab();
		await l.guest.tool("Click", {});
		l[failure]();
		l.showConsole();
		l.guest.forget();
		await assert.rejects(l.guest.tool("Snapshot", {}), /enhanced|remote/i);
		assert.deepEqual(consoleInput(l.calls), []);
	});
}

test("a mutating call that stalls keeps its may-have-run warning when enhanced recovery is blocked", async () => {
	const l = lab();
	l.hangNextTool();
	await assert.rejects(l.guest.tool("App", { name: "Editor" }), /may still be running[\s\S]*not repeated[\s\S]*enhanced/);
	assert.equal(l.calls.filter((call) => call === "guest App").length, 1);
	assert.deepEqual(consoleInput(l.calls), []);
});

test("a fresh unreachable guest on a sign-in screen is not assumed safe to sign in", async () => {
	const l = lab();
	l.offline();
	await assert.rejects(l.guest.tool("Snapshot", {}), /cannot confirm|can't confirm/i);
	assert.deepEqual(consoleInput(l.calls), []);
});

test("a recovering enhanced server is reconnected even while its separate console stays black", async () => {
	const l = lab();
	l.offline();
	l.sleepConsole();
	l.recoverOnProbe();
	await l.guest.tool("Click", {});
	assert.equal(l.guest.where(), "remote");
	assert.deepEqual(consoleInput(l.calls), []);
});

test("setup rechecks a server that returns in an enhanced session before opening a console shell", async () => {
	const l = lab();
	l.offline();
	l.showConsole();
	l.recoverOnProbe();
	await assert.rejects(l.guest.setup(), /enhanced|remote/i);
	assert.deepEqual(consoleInput(l.calls), []);
});

test("a failed session query fails closed rather than interpreting it as unlocked", async () => {
	const l = lab();
	l.badReply();
	await assert.rejects(l.guest.tool("Click", {}), /session/i);
	assert.deepEqual(consoleInput(l.calls), []);
	assert.ok(!l.calls.includes("guest Click"));
});

for (const [method, args] of [
	["login", {}], ["setup", {}], ["uac", { answer: "yes" }],
	["console.key", { keys: "enter" }], ["console.type", { text: "hello" }],
	["console.click", { x: 1, y: 2 }], ["console.move", { x: 1, y: 2 }],
	["console.drag", { x: 1, y: 2, x2: 3, y2: 4 }], ["console.scroll", { x: 1, y: 2 }], ["console.cad", {}],
] as const) {
	test(`${method} refuses an enhanced session even as the first call`, async () => {
		const l = lab();
		await assert.rejects(l.session.call(method, args, {}), /enhanced|remote/i);
		assert.deepEqual(consoleInput(l.calls), []);
	});
}

test("fresh checks catch a console session moving to enhanced before console input", async () => {
	const l = lab();
	l.set({ console: 1 });
	l.showConsole();
	await l.guest.tool("Click", {});
	l.set({ console: 3 });
	await assert.rejects(l.session.call("console.key", { keys: "enter" }, {}), /enhanced|remote/i);
	assert.deepEqual(consoleInput(l.calls), []);
});

test("rights mismatch never causes a reinstall through the enhanced session's console", async () => {
	const l = lab();
	l.set({ elevated: true });
	await assert.rejects(l.guest.tool("Click", {}), /rights|elevated/i);
	assert.deepEqual(consoleInput(l.calls), []);
	await assert.rejects(l.guest.tool("Click", {}), /rights|elevated/i);
});

test("console screenshots and OCR use the enhanced session's image and coordinates", async () => {
	const l = lab();
	const shot = await l.session.call("console.screenshot", {}, {});
	const image = shot.content.find((part) => part.type === "image");
	assert.ok(image?.type === "image");
	assert.equal(Buffer.from(image.data, "base64").readUInt32BE(16), 640);
	const result = await l.session.call("console.ocr", { x: 90, y: 40, width: 100, height: 50 }, {});
	const value = WIN_API.value("console.ocr", {}, result, () => ({ type: "screenshot", id: "1" }));
	assert.deepEqual(value, { width: 640, height: 480, text: "(130,60) Editor", items: [{ text: "Editor", x: 130, y: 60 }] });
	assert.ok(!l.calls.includes("host frame") && !l.calls.includes("host ocr"));
	assert.deepEqual(consoleInput(l.calls), []);
});

test("enhanced OCR maps downscaled images and negative monitor origins before region filtering", async () => {
	const l = lab();
	l.captureMetadata("Screenshot Original Size: (1280,960)\nScreenshot Coordinate Scale: 2\nVisible Displays: 0:DISPLAY (-1280,-100,0,860) primary");
	const result = await l.session.call("console.ocr", { x: -1100, y: 0, width: 200, height: 50 }, {});
	const value = WIN_API.value("console.ocr", {}, result, () => ({ type: "screenshot", id: "1" })) as { width: number; height: number; items: unknown };
	assert.equal(value.width, 1280);
	assert.equal(value.height, 960);
	assert.deepEqual(value.items, [{ text: "Editor", x: -1020, y: 20 }]);
});

for (const uac of [false, true]) {
	test(`enhanced capture failure does not fall back to console, UAC=${uac}`, async () => {
		const l = lab();
		l.failCapture(uac);
		await assert.rejects(l.session.call("console.ocr", {}, {}), /VM Connect/);
		assert.ok(!l.calls.includes("host frame") && !l.calls.includes("host ocr"));
		assert.deepEqual(consoleInput(l.calls), []);
	});
}

test("unknown console during a transition cannot erase the remote-session guard", async () => {
	const l = lab();
	await l.guest.tool("Click", {});
	l.set({ console: 0xffffffff });
	await assert.rejects(l.guest.tool("Click", {}), /not confirmed active/);
	l.offline();
	l.showConsole();
	await assert.rejects(l.session.call("console.key", { keys: "enter" }, {}), /enhanced|remote/i);
	assert.deepEqual(consoleInput(l.calls), []);
});

test("an inactive console transition cannot authorize later offline repair of a remote session", async () => {
	const l = lab();
	await l.guest.tool("Click", {});
	l.set({ console: 1, state: 4 });
	await assert.rejects(l.guest.tool("Click", {}), /disconnected/);
	l.offline();
	l.showConsole();
	await assert.rejects(l.session.call("console.key", { keys: "enter" }, {}), /enhanced|remote/i);
	assert.deepEqual(consoleInput(l.calls), []);
});

test("a confirmed move back to console clears the remote-session warning", async () => {
	const l = lab();
	await l.guest.tool("Click", {});
	l.set({ console: 1 });
	l.showConsole();
	await l.guest.tool("Click", {});
	assert.equal(l.guest.where(), "console");
	assert.deepEqual(consoleInput(l.calls), []);
});

for (const method of ["console.screenshot", "console.ocr"]) {
	test(`${method} never falls back to console after a remote server goes offline`, async () => {
		const l = lab();
		await l.guest.tool("Click", {});
		l.offline();
		await assert.rejects(l.session.call(method, {}, {}), /enhanced|remote/i);
		assert.ok(!l.calls.includes("host frame") && !l.calls.includes("host ocr"));
		assert.deepEqual(consoleInput(l.calls), []);
	});
}

test("a fresh offline console screenshot is read-only, even if it is black", async () => {
	const l = lab();
	l.offline();
	l.sleepConsole();
	await l.session.call("console.screenshot", {}, {});
	assert.deepEqual(consoleInput(l.calls), []);
});
