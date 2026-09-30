/** Native checks use synthetic artifacts and query their own session; they never drive a real VM. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SESSION_CHECK } from "../lib/windows-use/desktop-session.ts";
import { readFrame, toPng } from "../lib/windows-use/frame.ts";
import { hostFrame } from "./support/windows-frames.ts";

const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const wsl = process.platform === "linux" && existsSync(WSL_POWERSHELL);
const native = { skip: process.platform !== "win32" && !wsl };
function powershell(command: string): string {
	const exe = wsl ? WSL_POWERSHELL : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", timeout: 25_000 }).trim();
}

test("native WTS query compiles on Windows PowerShell and returns structured session state", native, () => {
	const text = powershell(SESSION_CHECK);
	assert.match(text, /^PI_WINDOWS_SESSION=/);
	const value = JSON.parse(text.slice("PI_WINDOWS_SESSION=".length));
	assert.ok(Number.isInteger(value.id) && value.id >= 0);
	assert.ok(Number.isInteger(value.console) && value.console >= 0);
	assert.ok(Number.isInteger(value.state) && value.state >= 0 && value.state <= 9);
	assert.equal(typeof value.locked, "boolean");
	assert.equal(typeof value.elevated, "boolean");
});

function modulePath(): string {
	const file = fileURLToPath(new URL("../lib/windows-use/ocr.psm1", import.meta.url));
	return (wsl ? execFileSync("wslpath", ["-w", file], { encoding: "utf8" }).trim() : file).replaceAll("'", "''");
}

test("native OCR boxes rotate back around the image center before scaling to screen pixels", native, () => {
	const script = `$ErrorActionPreference='Stop'; Import-Module '${modulePath()}' -WarningAction SilentlyContinue; & (Get-Module ocr) { Get-OcrBox @{ X=10; Y=20; Width=20; Height=10 } 90 100 80 } | ConvertTo-Json -Compress`;
	const box = JSON.parse(powershell(script));
	for (const [key, expected] of Object.entries({ x: 60, y: 0, w: 10, h: 20 })) assert.ok(Math.abs(box[key] - expected) < 0.001, key);
	const unchanged = JSON.parse(powershell(script.replace("} 90 100 80", "} 0 100 80")));
	assert.deepEqual(unchanged, { x: 10, y: 20, w: 20, h: 10 });
	const pipeline = JSON.parse(powershell(`$ErrorActionPreference='Stop'; Import-Module '${modulePath()}' -WarningAction SilentlyContinue; & (Get-Module ocr) {
		function Read-Tile($source, $x, $y, $w, $h) {
			$lines = if ($x -eq 0 -and $y -eq 0) { @(@{ Words=@(@{ Text='synthetic'; BoundingRect=@{ X=42; Y=48; Width=20; Height=40 } }) }) } else { @() }
			@{ result=@{ TextAngle=90; Lines=$lines }; width=120; height=96; scale=2 }
		}
		Read-SourceText @{ PixelWidth=100; PixelHeight=80 }
	} | ConvertTo-Json -Depth 6 -Compress`));
	assert.equal(pipeline.lines.length, 1, "rotated centers determine quarter ownership");
	assert.deepEqual(pipeline.lines[0].words, [{ text: "synthetic", x: 10, y: 15, w: 20, h: 10 }]);
});

test("native console typing uses one paired TypeKey per character with settled grouped modifiers", native, () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const code = host.slice(host.indexOf("# US-layout ASCII"), host.indexOf("$vkNames ="));
	const script = `$ErrorActionPreference='Stop'; $calls=[Collections.Generic.List[object]]::new();
		function Get-Device { 'synthetic' }
		function Invoke-CimMethod { param($InputObject,$MethodName,$Arguments); $calls.Add(@{ method=$MethodName;key=$Arguments.keyCode }); @{ ReturnValue=0 } }
		function Invoke-Checked { param($Device,$Method,$Arguments); $r=Invoke-CimMethod -InputObject $Device -MethodName $Method -Arguments $Arguments; if($r.ReturnValue -ne 0){throw 'synthetic invalid parameter'} }
		function Start-Sleep { param($Milliseconds); $calls.Add(@{ delay=$Milliseconds }) }
		${code}
		Send-Text 'synthetic' 'aB$'; ConvertTo-Json -InputObject @($calls.ToArray()) -Depth 6 -Compress`;
	type Event = { method?: string; key?: number; delay?: number; queued?: boolean };
	const calls: Event[] = JSON.parse(powershell(script));
	const events = (xs: Event[]) => xs.filter(c => c.method).map(c => [c.method, c.key]);
	assert.deepEqual(events(calls), [["TypeKey", 65], ["PressKey", 16], ["TypeKey", 66], ["TypeKey", 52], ["ReleaseKey", 16], ["ReleaseKey", 16]]);
	for (let i = 0; i < calls.length - 1; i++) if (calls[i]?.method) assert.ok((calls[i + 1]?.delay ?? 0) >= 50, "let the guest consume the paired stroke and each modifier transition");
	const plain: Event[] = JSON.parse(powershell(script.replace("Send-Text 'synthetic' 'aB$';", "Send-Text 'synthetic' 'abc';")));
	assert.deepEqual(events(plain), [["TypeKey", 65], ["TypeKey", 66], ["TypeKey", 67], ["ReleaseKey", 16]], "one CIM call per plain character, not separate make/break calls");
	const queued: Event[] = JSON.parse(powershell(script.replace("Send-Text 'synthetic' 'aB$';", () => "Send-Text 'synthetic' 'abc' { $calls.Add(@{queued=$true}) };")));
	assert.ok(queued.findIndex(c => c.queued) > queued.findIndex(c => c.method === "TypeKey" && c.key === 67));
	assert.ok(queued.findIndex(c => c.queued) < queued.findIndex(c => c.method === "ReleaseKey"), "commit after the final stroke but before cleanup");
	const failing = script.replace("@{ ReturnValue=0 }", "if($MethodName -eq 'TypeKey' -and $Arguments.keyCode -eq 66){throw 'synthetic typing failure'}; @{ ReturnValue=0 }")
		.replace("Send-Text 'synthetic' 'aB$';", () => "try { Send-Text 'synthetic' 'aB$' } catch { $caught=$_.Exception.Message }; if ($caught -notmatch 'synthetic typing failure') { throw 'expected typing failure' };");
	const failed: Event[] = JSON.parse(powershell(failing));
	assert.equal(failed.filter(c => c.method === "TypeKey" && c.key === 66).length, 1, "do not replay a failed stroke");
	assert.deepEqual(events(failed).slice(-2), [["ReleaseKey", 66], ["ReleaseKey", 16]], "release the possibly held ordinary key and Shift");
	const cleanupFailure = failing.replace("@{ ReturnValue=0 }", "if($MethodName -eq 'ReleaseKey' -and $Arguments.keyCode -eq 66){throw 'synthetic cleanup failure'}; @{ ReturnValue=0 }");
	assert.deepEqual(events(JSON.parse(powershell(cleanupFailure))).at(-1), ["ReleaseKey", 16], "a failed ordinary-key cleanup must not skip Shift release");
	const unsupported = script.replace("Send-Text 'synthetic' 'aB$';", () => "try { Send-Text 'synthetic' ([string][char]233) } catch { $caught=$_.Exception.Message }; if($caught -notmatch 'U\\+00E9'){throw 'expected unsupported character'};");
	assert.deepEqual(JSON.parse(powershell(unsupported)), [], "validate all text before sending any input");
});

test("native setup prepares its shell and commits the key only after complete typing", native, () => {
	const host = readFileSync(new URL("../lib/windows-use/host.ps1", import.meta.url), "utf8");
	const code = host.slice(host.indexOf("function Invoke-Setup("), host.indexOf("# The \"<run> <status>\""));
	const fixture = `$ErrorActionPreference='Stop'; $PSScriptRoot='synthetic'; $script:activeKey='old'; $script:events=[Collections.Generic.List[string]]::new(); $script:failTyping=$FAIL; $script:failCleanup=$FAILCLEANUP;
		function Get-RunningMachine { 'synthetic' }
		function New-Key { 'new' }
		function Set-Key { param($vm,$key); $script:activeKey=$key; $script:events.Add('commit') }
		function Get-Key { param($vm,$rotate); if($rotate){$script:activeKey='new'}; $script:activeKey }
		function Get-Content { '__KEY__' }
		function Join-Path { 'synthetic' }
		function Start-Sleep { }
		function Send-Text { param($machine,$text,$onQueued); $script:events.Add($(if($text -match 'remove-module psreadline'){'prepare'}else{'type'})); if($text -notmatch 'remove-module psreadline'){if($script:failTyping){throw 'synthetic typing failure'}; if($onQueued){& $onQueued}; if($script:failCleanup){throw 'synthetic final cleanup failure'}} }
		${code}
		try { $null=Invoke-Setup 'synthetic' 8000 '__PAYLOAD__' $false } catch { if($_.Exception.Message -notmatch '^synthetic (typing|final cleanup) failure$'){throw} }
		@{key=$script:activeKey;events=@($script:events.ToArray())}|ConvertTo-Json -Depth 4 -Compress`;
	const run = (failTyping: boolean, failCleanup = false) => JSON.parse(powershell(fixture.replace("$FAIL", failTyping ? "$true" : "$false").replace("$FAILCLEANUP", failCleanup ? "$true" : "$false")));
	const failed = run(true);
	assert.equal(failed.key, "old", "a typing failure leaves the running server's host key usable");
	assert.deepEqual(failed.events, ["prepare", "type"]);
	const complete = run(false);
	assert.equal(complete.key, "new");
	assert.deepEqual(complete.events, ["prepare", "type", "commit"]);
	assert.equal(run(false, true).key, "new", "the queued install still needs its new key even if final keyboard cleanup fails");
	const keys = host.slice(host.indexOf("function New-Key"), host.indexOf("# Opens an administrator's PowerShell"));
	assert.equal(powershell(`$ErrorActionPreference='Stop'; $dataDir=Join-Path $env:TEMP ('pi-wu-key-fixture-'+[Guid]::NewGuid().ToString('N'));
		function Get-KeyFile { param($vm); Join-Path $dataDir 'synthetic.fixture' }
		${keys}
		try {
			Set-Key 'synthetic' 'old'; if((Get-Key 'synthetic' $false) -ne 'old'){throw 'initial fixture write failed'};
			Set-Key 'synthetic' 'new'; if((Get-Key 'synthetic' $false) -ne 'new'){throw 'atomic fixture replacement failed'};
			if(@(Get-ChildItem $dataDir -Filter '*.tmp').Count){throw 'temporary fixture left behind'}; 'fixture passed'
		} finally { if(Test-Path $dataDir){[IO.Directory]::Delete($dataDir,$true)} }`), "fixture passed");
});

test("native Windows OCR decodes a synthetic guest PNG with the original dimensions", native, () => {
	const path = modulePath();
	const png = toPng(readFrame(hostFrame({ taskbar: true, width: 64, height: 48 })));
	const text = powershell(`$ErrorActionPreference='Stop'; Import-Module '${path}' -WarningAction SilentlyContinue; Read-ImageText ([byte[]]@(${[...png].join(",")})) | ConvertTo-Json -Depth 8 -Compress`);
	const value = JSON.parse(text);
	assert.equal(value.width, 64);
	assert.equal(value.height, 48);
	assert.ok(Array.isArray(value.lines));
});
