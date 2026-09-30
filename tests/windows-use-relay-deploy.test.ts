import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { NO_FLASH, readRelayDeployed, relayBootstrapCommand, RELAY_TASK, relayDeployCommands } from "../lib/windows-use/relay-deploy.ts";
import { RELAY_SCRIPT } from "../lib/windows-use/relay.ts";

/** CreateProcess's limit, which Windows-MCP's -EncodedCommand line must fit under. */
const COMMAND_LINE_MAX = 32_767;
const encodedLength = (command: string) => Math.ceil(Buffer.byteLength(command, "utf16le") / 3) * 4;

test("each deploy command fits the command line Windows-MCP runs it on", () => {
	const commands = relayDeployCommands();
	assert.ok(commands.length >= 3);
	for (const command of commands) assert.ok(encodedLength(command) + 200 < COMMAND_LINE_MAX, `${encodedLength(command)} encoded characters`);
});

test("the chunks reassemble to exactly the relay script, and the install checks its hash", () => {
	const commands = relayDeployCommands();
	const chunks = commands.slice(1, -1).map((command) => /-Value '([A-Za-z0-9+/=]+)' -NoNewline$/.exec(command)?.[1]);
	assert.ok(chunks.every((chunk) => chunk !== undefined), "chunks are plain base64, safe inside single quotes");
	const script = gunzipSync(Buffer.from(chunks.join(""), "base64")).toString("utf8");
	assert.equal(script, RELAY_SCRIPT);
	const install = commands.at(-1)!;
	assert.ok(install.includes(createHash("sha256").update(RELAY_SCRIPT, "utf8").digest("hex").toUpperCase()));
	assert.ok(install.includes(`-TaskName '${RELAY_TASK}'`));
	assert.ok(install.includes(NO_FLASH));
	assert.doesNotMatch(install, /auth_key|\.key\b/, "the relay reads its key from the server's config; none travels in the command");
	// Over the relay route, stopping the relay inside this command would cut off its own answer.
	const restartAt = install.indexOf("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
	assert.ok(restartAt > 0, "the relay restarts from a detached helper");
	assert.ok(!/^Stop-ScheduledTask|^Get-CimInstance.*Stop-Process/m.test(install), "never stopped inline");
	assert.match(install, /if \(\$false -or -not \(\$current -and \$running -and \$registered\)\)/, "the same relay already running is left alone");
});

test("an upgrade the host knows is due restarts the relay even when its file is current", () => {
	assert.match(relayDeployCommands().at(-1)!, /if \(\$false -or -not/);
	assert.match(relayDeployCommands(true).at(-1)!, /if \(\$true -or -not/);
	assert.match(relayDeployCommands().at(-1)!, /\$registered = \$task -or \(Get-ItemProperty [^\n]*'pi-windows-use-relay'/, "a Run-key relay counts as installed too");
});

test("a new relay that dies at start is rolled back to the previous one, so a VPN never leaves no route", () => {
	const install = relayDeployCommands(true).at(-1)!;
	assert.match(install, /Copy-Item \$f \$prev -Force/, "the previous relay is kept before it is overwritten");
	assert.match(install, /\$helper = "Start-Sleep -Seconds 5; \$body"/, "the install's answer gets back before the relay carrying it stops");
	const body = /\$body = "([^\n]+)"/.exec(install)?.[1] ?? "";
	assert.match(body, /\$launch; Start-Sleep -Seconds 10; if \(-not \(\$relays\) -and \(Test-Path .+\)\) \{ Copy-Item .+ -Force; \$launch \}$/);
});

test("a reinstall restarts the relay only through its task, never with the bootstrap's administrator rights", () => {
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	const tail = bootstrap.slice(bootstrap.indexOf("Stop-Server also stopped"));
	assert.match(tail, /Start-ScheduledTask -TaskName 'windows-mcp-relay'/);
	assert.doesNotMatch(bootstrap, /Start-Process|pi-windows-use-relay/, "the Run key's command line is the user's to write; run elevated, it would make an administrator's relay");
	assert.ok(tail.indexOf("windows-mcp-relay") < tail.indexOf('Set-Status "OK listening'), "before the host is told the server is ready");
});

test("the install's report is read strictly, and any other output is shown as the failure", () => {
	assert.deepEqual(readRelayDeployed('Response: PI_RELAY_DEPLOYED={"mode":"task","flash":"added","restart":"scheduled"}\nStatus Code: 0'), { mode: "task", flash: "added", restart: "scheduled" });
	assert.deepEqual(readRelayDeployed('Response: PI_RELAY_DEPLOYED={"restart":"none","flash":"present","mode":"runkey"}\n'), { mode: "runkey", flash: "present", restart: "none" });
	assert.throws(() => readRelayDeployed('Response: PI_RELAY_DEPLOYED={"mode":"task","flash":"added"}'), /the relay install reported/, "an older install's report lacks the restart");
	assert.throws(() => readRelayDeployed('Response: PI_RELAY_DEPLOYED={"mode":"service","flash":"added"}'), /the relay install reported/);
	assert.throws(() => readRelayDeployed("Response: pythonw.exe is missing\nStatus Code: 1"), /pythonw\.exe is missing/);
	assert.throws(() => readRelayDeployed(""), /reported: nothing/);
});

const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const native = { skip: process.platform !== "win32" && !(process.platform === "linux" && existsSync(WSL_POWERSHELL)) };

test("native Windows PowerShell 5.1 parses every deploy command without errors", native, () => {
	const exe = process.platform === "win32" ? "powershell.exe" : WSL_POWERSHELL;
	for (const command of relayDeployCommands()) {
		// Parse only: nothing runs, so this never touches the host's scheduled tasks or files.
		const check = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command, "utf8").toString("base64")}')), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message } } else { 'parsed' }`;
		assert.equal(execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", check], { encoding: "utf8", timeout: 25_000 }).trim(), "parsed");
	}
});

test("a setup whose installer comes over key-value exchange installs the relay with the server, so a first setup under a VPN works", () => {
	const command = relayBootstrapCommand();
	assert.match(command, /^& \{\n/, "its own scope: the bootstrap's variables stay as they were");
	assert.match(command, /if \(\$true -or -not/, "forced: the bootstrap stopped the old relay");
	// Restarted before the host hears the server is ready: a delayed restart would cut the host's first call.
	assert.doesNotMatch(command, /Win32_Process -MethodName Create|Start-Sleep -Seconds 5/);
	assert.match(command, /if \(\$mode -eq 'task'\) \{ & \(\[scriptblock\]::Create\(\$body\)\); \$restart = 'done' \} else \{ \$restart = 'none' \}/, "only as a task: a relay the elevated bootstrap started would be elevated");
	const packed = /Set-Content -Path \$b -Value '([A-Za-z0-9+/=]+)' -NoNewline/.exec(command)?.[1] ?? "";
	assert.equal(gunzipSync(Buffer.from(packed, "base64")).toString("utf8"), RELAY_SCRIPT);
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8");
	const at = bootstrap.indexOf("__RELAY__");
	assert.ok(at > bootstrap.indexOf("server did not start listening"), "after the server listens: the relay runs on its Python");
	assert.ok(at < bootstrap.indexOf('Set-Status "OK listening'));
	assert.match(bootstrap, /try \{ __RELAY__ \} catch \{/, "a relay that won't install leaves the server's install standing");
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const setup = host.slice(host.indexOf("function Invoke-Setup("), host.indexOf("# The \"<run> <status>\""));
	assert.match(setup, /Replace\('__RELAY__', \$relay\)/, "over key-value exchange");
	assert.match(setup, /Replace\('__RELAY__', ''\)/, "typed: 7 KB more would take minutes");
});

test("native Windows PowerShell 5.1 parses the bootstrap with the relay's install in it", native, () => {
	const exe = process.platform === "win32" ? "powershell.exe" : WSL_POWERSHELL;
	const bootstrap = readFileSync(new URL("../lib/windows-use/guest-bootstrap.ps1", import.meta.url), "utf8")
		.replace("'__KEY__'", "$k").replace("__PORT__", "8000").replace("__RUN__", "synthetic").replace("__RUNLEVEL__", "Limited").replace("__RELAY__", relayBootstrapCommand());
	const check = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(bootstrap, "utf8").toString("base64")}')), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message } } else { 'parsed' }`;
	assert.equal(execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", check], { encoding: "utf8", timeout: 25_000 }).trim(), "parsed");
});

test("an upgrade keeps a relay task the elevated setup registered, which the server may run but not change", () => {
	const install = relayDeployCommands(true).at(-1)!;
	const reuse = install.indexOf("if ($task -and $task.Actions[0].Execute -eq $pyw -and $task.Actions[0].Arguments -eq $arguments) { $mode = 'task'; $launch = $launchTask; $kick = $kickTask }");
	assert.ok(reuse > 0, "the same command line is kept as is");
	assert.ok(reuse < install.indexOf("Register-ScheduledTask -TaskName"), "checked before registering again");
});
