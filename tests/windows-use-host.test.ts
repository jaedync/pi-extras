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

test("warming starts the host once, ahead of its first call, and an unused warm host still closes when idle", async () => {
	let launches = 0;
	const fake = fakeProcess(() => "ok");
	const host = new HostSession({ idleMs: 20, launch: () => { launches++; return fake.proc; } });
	host.warm();
	host.warm();
	assert.equal(await host.call("vms"), "ok");
	assert.equal(launches, 1);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(fake.killed(), 1);
	const idle = fakeProcess(() => "ok");
	const unused = new HostSession({ idleMs: 20, launch: () => idle.proc });
	unused.warm();
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(idle.killed(), 1);
	const broken = new HostSession({ idleMs: 20, launch: () => { throw new Error("no powershell.exe"); } });
	broken.warm();
	await assert.rejects(broken.call("vms"), /no powershell\.exe/, "a failed warm-up surfaces on the call");
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
	assert.doesNotMatch(host.replace(/function Get-(?:Frame|Image)Text[\s\S]*?\n\}/g, ""), /ocr\.psm1/);
	const placeholders = [...new Set(bootstrap.match(/__[A-Z]+__/g))].sort();
	assert.deepEqual(placeholders, ["__KEY__", "__PORT__", "__RELAY__", "__RUNLEVEL__", "__RUN__"]);
	assert.match(bootstrap, /-RunLevel \$runLevel\b/);
	assert.match(host, /\$runLevel = if \(\$elevated\) \{ 'Highest' \} else \{ 'Limited' \}/);
	assert.match(host, /setup\s+= \{ param\(\$p\) Invoke-Setup \$p\.vm \(Get-Port \$p\) \(\[string\]\$p\.launcher\) \(\$p\.elevated -eq \$true\) \(\[string\]\$p\.stub\) \(\[string\]\$p\.relay\) \}/);
	for (const placeholder of placeholders) assert.ok(host.includes(`.Replace('${placeholder}'`), `${placeholder} is never filled in`);
});

test("OCR reads the frame at twice its size, where small UI text reads right, and reports frame pixels", () => {
	const ocr = readFileSync(new URL("../lib/windows-use/ocr.psm1", import.meta.url), "utf8");
	// Live, an Event Viewer list read at 1x got no time right ("1237:02"); at 2x it got all 15.
	assert.match(ocr, /\$upscale = 2\b/);
	assert.match(ocr, /TransformedBitmap\(\$tile, \(New-Object System\.Windows\.Media\.ScaleTransform\(\$scale, \$scale\)\)\)/);
	// Over a photo wallpaper it read none of a Run box from the whole frame, and all of it from a quarter.
	assert.match(ocr, /CroppedBitmap\(\$source, \(New-Object System\.Windows\.Int32Rect\(\$x, \$y, \$w, \$h\)\)\)/);
	assert.match(ocr, /foreach \(\$right in \$false, \$true\)/);
	assert.match(ocr, /Get-OcrBox \$word\.BoundingRect \(\[double\]\$tile\.result\.TextAngle\) \$tile\.width \$tile\.height/, "deskewed boxes rotate around the actual bitmap center before scaling");
	assert.match(ocr, /\$left = \$x \+ \$r\.x \/ \$scale/, "boxes are in frame pixels");
	assert.match(ocr, /w = \[int\]\[math\]::Round\(\$r\.w \/ \$scale\)/);
	assert.match(ocr, /\(\$cx -ge \$midX\) -eq \$right -and \(\$cy -ge \$midY\) -eq \$lower/, "a word overlapping quarters read in both is kept once");
});

test("setup commits a fresh key after typing, so a timeout preserves the old server but cannot report it as ready", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const setup = host.slice(host.indexOf("function Invoke-Setup"), host.indexOf("function Get-SetupStatus"));
	assert.match(setup, /\$key = New-Key/);
	assert.match(setup, /Send-Text \$m \$line[\s\S]*Set-Key \$vm \$key/, "the key file changes only after the entire command was sent");
	assert.match(setup, /remove-module psreadline/, "the dedicated setup shell avoids expensive long-line redraws");
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

test("a key combination that fails part-way lets go of the keys it held, so no modifier stays down in the guest", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const keys = host.slice(host.indexOf("function Send-Keys"), host.indexOf("# The synthetic mouse"));
	assert.match(keys, /try \{[\s\S]*'PressKey'[\s\S]*\} finally \{[\s\S]*'ReleaseKey'/);
});

test("Hyper-V's in-between states have names, since a restart inside Windows passes through them", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	assert.match(host, /4 = 'shutting down'/);
	assert.match(host, /10 = 'starting'/);
});

test("console scroll counts wheel notches, as Windows-MCP's scroll does, not Hyper-V's 120ths of one", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	assert.match(host, /'SetScrollPosition' @\{ scrollPositionDelta = \$notches \* 120 \}/);
});

test("the restart typed into the Run box stops and starts what the bootstrap installs", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	assert.match(bootstrap, new RegExp(`\\$taskName = '${SERVER_TASK}'`));
	assert.match(bootstrap, /Join-Path \$bin 'windows-mcp\.exe'/);
	assert.match(RESTART_SERVER, /taskkill \/f \/t \/im windows-mcp\.exe/);
	assert.match(RESTART_SERVER, new RegExp(`^cmd /c "schtasks /end /tn ${SERVER_TASK} & `), "an ended task takes the next start even while a server it started runs on");
	assert.match(RESTART_SERVER, new RegExp(`schtasks /run /tn ${SERVER_TASK}"$`));
	assert.ok(RESTART_SERVER.length < 200, "typed at about 30 characters a second");
	// The signed-in user can't stop a server with administrator rights (live: "Access is denied"); the task, which has them, can.
	const start = /\$serve = @\(([\s\S]*?)\)/.exec(bootstrap)?.[1] ?? "";
	assert.match(start, /'taskkill \/f \/t \/im windows-mcp\.exe >nul 2>&1'[\s\S]*'ping -n 3 127\.0\.0\.1 >nul'[\s\S]*serve 1>>/, "the task stops a server still running, lets its port go, then serves");
});

test("the bootstrap installs a Windows-MCP release line whose snapshot text windows_use was built against", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	assert.match(bootstrap, /tool install --upgrade --python 3\.14 'windows-mcp>=0\.8\.6,<0\.9'/);
});

test("the bootstrap starts the server at every sign-in through the Run key as well as the logon task", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	assert.match(bootstrap, /CurrentVersion\\Run' -Name 'pi-windows-use'/);
	assert.match(bootstrap, /schtasks\.exe`" \/run \/tn \$taskName/, "the Run key starts the task, so one definition runs the server");
	assert.match(bootstrap, /-MultipleInstances IgnoreNew/, "a trigger that does fire can't start a second server");
});

test("status skips the guest's IP, which Hyper-V takes one to two seconds to report", () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const status = host.slice(host.indexOf("function Get-Status"), host.indexOf("function Start-Machine"));
	assert.doesNotMatch(status, /Get-Ipv4/, "every reconnect waits on status; win.vms() still lists IPs");
});

test("both typed setup lines, which carry the key, are scrubbed from PSReadLine history", async () => {
	const { LAUNCHER, STUB } = await import("../lib/windows-use/install.ts");
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	const patterns = [...bootstrap.matchAll(/-notlike '((?:[^']|'')*)'/g)].map((m) => m[1]!.replaceAll("''", "'"));
	const like = (text: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(text);
	for (const line of [LAUNCHER.replace("__PAYLOAD__", "H4sIAAAA"), STUB.replace("__KEY__", "synthetic")]) {
		assert.ok(patterns.some((pattern) => like(line, pattern)), line.slice(0, 20));
	}
});

test("a reinstall that can't reach the package index keeps an installed release of the same line", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	const step = bootstrap.slice(bootstrap.indexOf("Set-Status 'installing windows-mcp'"), bootstrap.indexOf("$exe = Join-Path $bin"));
	assert.match(step, /'windows-mcp>=0\.8\.6,<0\.9'/);
	assert.match(step, /catch \{[\s\S]*uv tool list[\s\S]*\^windows-mcp v0\\\.8\\\.\(\\d\+\)'[\s\S]*-ge 6[\s\S]*if \(-not \$kept\) \{ throw \}/, "the same bounds as the install: 0.8.6 up to 0.9");
	assert.doesNotMatch(step, /Set-Status "FAIL/, "keeping it isn't a failure");
});

test("the bootstrap clears the typed stub, which shows the key, off the screen before anything else", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	const code = bootstrap.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
	assert.match(code[2]!, /^\$key = '__KEY__';/);
	assert.equal(code[3], "Remove-Variable k -ErrorAction SilentlyContinue; Clear-Host");
	const install = readFileSync(new URL("../lib/windows-use/install.ts", import.meta.url), "utf8");
	assert.match(install, /\{cls;sp /, "a refused payload clears the screen too, as its window stays open to read");
});
