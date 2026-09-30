import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { NO_FLASH, readRelayDeployed, RELAY_TASK, relayDeployCommands } from "../lib/windows-use/relay-deploy.ts";
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
	assert.match(install, /if \(-not \(\$current -and \$running -and \$task\)\)/, "the same relay already running is left alone");
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
