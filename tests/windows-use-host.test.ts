import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test from "node:test";
import { HostSession } from "../lib/windows-use/host.ts";
import { RESTART_SERVER, SERVER_TASK } from "../lib/windows-use/stall.ts";

/** A stand-in for host.ps1: answers each JSON-RPC line with `answer`, or never when it returns undefined. */
function fakeProcess(answer: (method: string, params: unknown) => unknown) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const events = new EventEmitter();
	let killed = 0;
	// A real child process keeps the event loop alive while it runs; without this, Node 22 and 24
	// end the file while a call waits on an (unref'd) AbortSignal.timeout.
	const running = setInterval(() => {}, 60_000);
	createInterface({ input: stdin }).on("line", (line) => {
		const message = JSON.parse(line);
		const value = answer(message.method, message.params);
		if (value !== undefined) stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value })}\n`);
	});
	const proc = {
		stdin, stdout, stderr: null,
		kill() { killed++; clearInterval(running); events.emit("close", null); return true; },
		once(event: "close", listener: (code: number | null) => void) { events.once(event, listener); return proc; },
	};
	return { proc, killed: () => killed };
}

test("the host starts on the first call and stays warm for the next", async () => {
	let launches = 0;
	const fake = fakeProcess((method, params) => ({ method, params }));
	const host = new HostSession({ idleMs: 60_000, launch: () => { launches++; return fake.proc; } });
	assert.equal(host.state, "closed");
	assert.deepEqual(await host.call("status", { vm: "A" }), { method: "status", params: { vm: "A" } });
	assert.deepEqual(await host.call("vms"), { method: "vms", params: {} });
	assert.equal(launches, 1);
	assert.equal(host.state, "ready");
	host.close();
	assert.equal(fake.killed(), 1);
});

test("a call that outlives its timeout kills the busy host so the next call starts clean", async () => {
	let launches = 0;
	const hung = fakeProcess(() => undefined);
	const fresh = fakeProcess(() => "ok");
	const host = new HostSession({ idleMs: 60_000, launch: () => (++launches === 1 ? hung.proc : fresh.proc) });
	await assert.rejects(host.call("setup", {}, { timeoutMs: 50 }), /windows_use host setup timed out/);
	assert.equal(hung.killed(), 1);
	assert.equal(await host.call("vms"), "ok");
	assert.equal(launches, 2);
	host.close();
});

test("a cancelled call is reported as cancelled and leaves the host running", async () => {
	const hung = fakeProcess(() => undefined);
	const host = new HostSession({ idleMs: 60_000, launch: () => hung.proc });
	const controller = new AbortController();
	const pending = host.call("mcp", {}, { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, /windows_use call cancelled/);
	assert.equal(hung.killed(), 0);
	host.close();
});

test("the host closes itself after sitting idle", async () => {
	const fake = fakeProcess(() => "ok");
	const host = new HostSession({ idleMs: 20, launch: () => fake.proc });
	await host.call("vms");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(fake.killed(), 1);
});

test("host.ps1 stays clear of what antivirus holds up, and fills in every bootstrap placeholder", () => {
	const dir = new URL("../lib/windows-use/", import.meta.url);
	const host = readFileSync(new URL("host.ps1", dir), "utf8");
	const ocr = readFileSync(new URL("ocr.psm1", dir), "utf8");
	const bootstrap = readFileSync(new URL("guest-bootstrap.ps1", dir), "utf8");
	// Defender held host.ps1 for up to half a minute over these; they live in Node instead.
	for (const pattern of [/\biex\b/i, /Invoke-Expression/i, /FromBase64String/i, /System\.Drawing/i, /Marshal/i]) {
		assert.doesNotMatch(host, pattern);
		assert.doesNotMatch(ocr, pattern);
	}
	assert.match(host, /ocr\s+= \{ param\(\$p\) Get-FrameText/, "the OCR module loads only when asked for");
	assert.doesNotMatch(host.replace(/function Get-FrameText[\s\S]*?\n\}/, ""), /ocr\.psm1/);
	const placeholders = [...new Set(bootstrap.match(/__[A-Z]+__/g))].sort();
	assert.deepEqual(placeholders, ["__KEY__", "__PORT__", "__RUN__"]);
	for (const placeholder of placeholders) assert.ok(host.includes(`.Replace('${placeholder}'`), `${placeholder} is never filled in`);
});

test("setup rotates the key, so a server it is replacing can't pass for the new one", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const setup = host.slice(host.indexOf("function Invoke-Setup"), host.indexOf("function Get-SetupStatus"));
	assert.match(setup, /Get-Key \$vm \$true/);
	assert.match(setup, /notmatch '\^\\s\*#'/, "comment lines are dropped before typing, which takes seconds per hundred characters");
});

test("PowerShell for setup opens through Run, which works while Start search hangs, and setup itself only types", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const open = host.slice(host.indexOf("function Open-AdminShell"), host.indexOf("function Invoke-Setup"));
	assert.match(open, /Send-Keys \$m 'win\+r'/);
	assert.match(open, /'ctrl\+shift\+enter'/);
	assert.doesNotMatch(open, /Send-Keys \$m 'win'/, "Start search can hang and swallow what is typed");
	const setup = host.slice(host.indexOf("function Invoke-Setup"), host.indexOf("function Get-SetupStatus"));
	assert.doesNotMatch(setup, /Send-Keys/, "the caller checks the console between opening PowerShell and typing the key");
	assert.match(host, /adminShell\s+= \{ param\(\$p\) Open-AdminShell \$p\.vm \}/);
});

/** Hyper-V's input methods and their parameters, as the host's WMI provider declares them. */
const HYPERV_METHODS: Record<string, readonly string[]> = {
	PressKey: ["KeyCode"], ReleaseKey: ["KeyCode"], TypeKey: ["KeyCode"], TypeScancodes: ["Scancodes"], TypeCtrlAltDel: [],
	SetAbsolutePosition: ["HorizontalPosition", "VerticalPosition"], ClickButton: ["ButtonIndex"],
	SetButtonState: ["ButtonIndex", "IsDown"], SetScrollPosition: ["ScrollPositionDelta"],
};

test("every Hyper-V input method host.ps1 calls gets the parameters Hyper-V declares", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const calls = [...host.matchAll(/(?:Invoke-Checked \$\w+|-MethodName) '?(\w+)'? (?:-Arguments )?@\{([^}]*)\}/g)];
	const checked = calls.filter((call) => call[1]! in HYPERV_METHODS);
	assert.ok(checked.length >= 10, `found ${checked.length} input calls`);
	for (const [, method, args] of checked) {
		const names = [...args!.matchAll(/(\w+)\s*=/g)].map((match) => match[1]!.toLowerCase()).sort();
		assert.deepEqual(names, HYPERV_METHODS[method!]!.map((name) => name.toLowerCase()).sort(), `${method} is called with ${args}`);
	}
});

test("the restart typed into the Run box stops and starts what the bootstrap installs", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	assert.match(bootstrap, new RegExp(`\\$taskName = '${SERVER_TASK}'`));
	assert.match(bootstrap, /Join-Path \$bin 'windows-mcp\.exe'/);
	assert.match(RESTART_SERVER, /taskkill \/f \/t \/im windows-mcp\.exe/);
	assert.match(RESTART_SERVER, new RegExp(`schtasks /run /tn ${SERVER_TASK}"$`));
	assert.ok(RESTART_SERVER.length < 200, "typed at about 30 characters a second");
});

test("the bootstrap starts the server at every sign-in through the Run key as well as the logon task", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	assert.match(bootstrap, /CurrentVersion\\Run' -Name 'pi-windows-use'/);
	assert.match(bootstrap, /schtasks\.exe`" \/run \/tn \$taskName/, "the Run key starts the task, so one definition runs the server");
	assert.match(bootstrap, /-MultipleInstances IgnoreNew/, "a trigger that does fire can't start a second server");
});
