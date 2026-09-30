/**
 * Installs the guest relay through Windows-MCP itself: no console typing, no
 * elevation beyond the server's own. It runs while the guest's IP still reaches
 * the server (a first install happens before the VPN connects), and from then
 * on the relay keeps the server reachable over a Hyper-V socket.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { RELAY_SCRIPT } from "./relay.ts";
import { SERVER_TASK } from "./stall.ts";

export const RELAY_TASK = "windows-mcp-relay";
/**
 * Windows-MCP runs each command as an encoded PowerShell command line, capped
 * at 32,767 characters; a 16 KB script base64'd whole failed live with "The
 * filename or extension is too long". Chunks stay well under the cap.
 */
const CHUNK = 6_000;
/** The flag Windows-MCP reads before drawing its glow around every capture. */
export const NO_FLASH = "set WINDOWS_MCP_DISABLE_FLASH=1";
const DONE = "PI_RELAY_DEPLOYED=";

const packed = gzipSync(Buffer.from(RELAY_SCRIPT, "utf8")).toString("base64");
const sha256 = createHash("sha256").update(RELAY_SCRIPT, "utf8").digest("hex").toUpperCase();
const dir = "$d = Join-Path $env:USERPROFILE '.windows-mcp'; $b = Join-Path $d 'guest-relay.py.gz.b64'";

/** The PowerShell commands, in order; each must succeed before the next. */
export function relayDeployCommands(): string[] {
	const chunks: string[] = [];
	for (let at = 0; at < packed.length; at += CHUNK) chunks.push(packed.slice(at, at + CHUNK));
	return [
		`${dir}; New-Item -ItemType Directory -Force -Path $d | Out-Null; Set-Content -Path $b -Value '' -NoNewline`,
		...chunks.map((chunk) => `${dir}; Add-Content -Path $b -Value '${chunk}' -NoNewline`),
		installCommand(),
	];
}

function installCommand(): string {
	return `$ErrorActionPreference = 'Stop'; ${dir}; $f = Join-Path $d 'guest-relay.py'; $cfg = Join-Path $d 'config.toml'
$gz = New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String((Get-Content $b -Raw).Trim()))), [IO.Compression.CompressionMode]::Decompress)
$out = New-Object IO.MemoryStream; $gz.CopyTo($out); $bytes = $out.ToArray(); Remove-Item $b
$sha = [Security.Cryptography.SHA256]::Create(); $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('X2') }); $sha.Dispose()
if ($hash -ne '${sha256}') { throw 'the relay arrived corrupted' }
$py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.ExecutablePath -like '*\\uv\\tools\\windows-mcp\\*' } | Select-Object -First 1 -ExpandProperty ExecutablePath
if (-not $py) { $py = Join-Path $env:APPDATA 'uv\\tools\\windows-mcp\\Scripts\\python.exe' }
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'; if (-not (Test-Path $pyw)) { throw "pythonw.exe is missing beside $py" }
Stop-ScheduledTask -TaskName '${RELAY_TASK}' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -like '*guest-relay.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
[IO.File]::WriteAllBytes($f, $bytes)
$who = "$env:USERDOMAIN\\$env:USERNAME"; $arguments = "\`"$f\`" --config \`"$cfg\`""; $mode = 'task'
$runLevel = try { (Get-ScheduledTask -TaskName '${SERVER_TASK}' -ErrorAction Stop).Principal.RunLevel } catch { 'Limited' }
try {
    # Its own task: the server's restart ends the server's task, and must leave the relay running.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName '${RELAY_TASK}' -Action (New-ScheduledTaskAction -Execute $pyw -Argument $arguments) -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $who) -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel $runLevel) -Force | Out-Null
    Start-ScheduledTask -TaskName '${RELAY_TASK}'
    $kick = "\`"$env:WINDIR\\System32\\conhost.exe\`" --headless \`"$env:WINDIR\\System32\\schtasks.exe\`" /run /tn ${RELAY_TASK}"
} catch {
    # A user who may not register tasks still starts it at every sign-in. Started through
    # WMI, not as this shell's child: the server's restart kills windows-mcp.exe's whole tree.
    $mode = 'runkey'; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "\`"$pyw\`" $arguments" }
    if ($r.ReturnValue -ne 0) { throw "starting the relay failed with $($r.ReturnValue)" }
    $kick = "\`"$pyw\`" $arguments"
}
New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'pi-windows-use-relay' -Value $kick -PropertyType String -Force | Out-Null
$start = Join-Path $d 'windows-use-start.cmd'; $flash = 'absent'
if (Test-Path $start) {
    $lines = @(Get-Content $start)
    if ($lines -contains '${NO_FLASH}') { $flash = 'present' }
    else { [IO.File]::WriteAllText($start, ((@($lines[0], '${NO_FLASH}') + @($lines | Select-Object -Skip 1)) -join "\`r\`n") + "\`r\`n", [Text.Encoding]::ASCII); $flash = 'added' }
}
'${DONE}' + (@{ mode = $mode; flash = $flash } | ConvertTo-Json -Compress)`;
}

export interface RelayDeployed {
	readonly mode: "task" | "runkey";
	/** Whether the server's start script already turned off Windows-MCP's capture flash. */
	readonly flash: "added" | "present" | "absent";
}

/** The install command's report, or an Error with the guest's own words. */
export function readRelayDeployed(text: string): RelayDeployed {
	const line = text.split(/\r?\n/).find((l) => l.includes(DONE));
	const value = line ? JSON.parse(line.slice(line.indexOf(DONE) + DONE.length).trim()) as Record<string, unknown> : undefined;
	if (!value || (value.mode !== "task" && value.mode !== "runkey") || !["added", "present", "absent"].includes(String(value.flash))) {
		throw new Error(`the relay install reported: ${text.replace(/\s+/g, " ").trim().slice(0, 400) || "nothing"}`);
	}
	return { mode: value.mode, flash: value.flash as RelayDeployed["flash"] };
}
