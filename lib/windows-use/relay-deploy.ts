/**
 * Installs the guest relay through Windows-MCP itself: no console typing, no
 * elevation beyond the server's own. It runs while the guest's IP still reaches
 * the server (a first install happens before the VPN connects), and from then
 * on the relay keeps the server reachable over a Hyper-V socket.
 */
import { gzipSync } from "node:zlib";
import { RELAY_SCRIPT, RELAY_SHA } from "./relay.ts";
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
const dir = "$d = Join-Path $env:USERPROFILE '.windows-mcp'; $b = Join-Path $d 'guest-relay.py.gz.b64'";

/**
 * The PowerShell commands, in order; each must succeed before the next.
 * `force` restarts the relay even when its file is current: the host saw an
 * older one answer, so what runs isn't what's on disk.
 */
export function relayDeployCommands(force = false): string[] {
	const chunks: string[] = [];
	for (let at = 0; at < packed.length; at += CHUNK) chunks.push(packed.slice(at, at + CHUNK));
	return [
		`${dir}; New-Item -ItemType Directory -Force -Path $d | Out-Null; Set-Content -Path $b -Value '' -NoNewline`,
		...chunks.map((chunk) => `${dir}; Add-Content -Path $b -Value '${chunk}' -NoNewline`),
		installCommand(force),
	];
}

/**
 * The same install for the setup bootstrap, which runs it once the server
 * listens: the relay then exists before any call needs it, so a first setup
 * under a guest VPN works. Sent only over key-value exchange, where its size
 * costs no typing. Its own scope keeps the bootstrap's variables as they were.
 */
export function relayBootstrapCommand(): string {
	return `& {\n${dir}; New-Item -ItemType Directory -Force -Path $d | Out-Null; Set-Content -Path $b -Value '${packed}' -NoNewline\n${installCommand(true, true)}\n} | Out-Null`;
}

/** inline: the setup bootstrap's restart, done before it reports the server ready rather than after an answer. */
function installCommand(force: boolean, inline = false): string {
	return `$ErrorActionPreference = 'Stop'; ${dir}; $f = Join-Path $d 'guest-relay.py'; $cfg = Join-Path $d 'config.toml'
$gz = New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String((Get-Content $b -Raw).Trim()))), [IO.Compression.CompressionMode]::Decompress)
$out = New-Object IO.MemoryStream; $gz.CopyTo($out); $bytes = $out.ToArray(); Remove-Item $b
function Get-Sha($data) { $sha = [Security.Cryptography.SHA256]::Create(); try { -join ($sha.ComputeHash($data) | ForEach-Object { $_.ToString('X2') }) } finally { $sha.Dispose() } }
if ((Get-Sha $bytes) -ne '${RELAY_SHA}') { throw 'the relay arrived corrupted' }
$py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.ExecutablePath -like '*\\uv\\tools\\windows-mcp\\*' } | Select-Object -First 1 -ExpandProperty ExecutablePath
if (-not $py) { $py = Join-Path $env:APPDATA 'uv\\tools\\windows-mcp\\Scripts\\python.exe' }
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'; if (-not (Test-Path $pyw)) { throw "pythonw.exe is missing beside $py" }
$who = "$env:USERDOMAIN\\$env:USERNAME"; $arguments = "\`"$f\`" --config \`"$cfg\`""
$running = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -like '*guest-relay.py*' }).Count
$current = (Test-Path $f) -and ((Get-Sha ([IO.File]::ReadAllBytes($f))) -eq '${RELAY_SHA}')
$task = Get-ScheduledTask -TaskName '${RELAY_TASK}' -ErrorAction SilentlyContinue
$registered = $task -or (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'pi-windows-use-relay' -ErrorAction SilentlyContinue)
$mode = if ($task) { 'task' } else { 'runkey' }; $restart = 'none'
# The same relay already running only answered slowly: leave it be.
if (${force ? "$true" : "$false"} -or -not ($current -and $running -and $registered)) {
    # Kept for the helper to roll back to: under a VPN a relay that fails to start leaves no route.
    $prev = "$f.prev"; if (Test-Path $f) { Copy-Item $f $prev -Force } else { Remove-Item $prev -ErrorAction SilentlyContinue }
    [IO.File]::WriteAllBytes($f, $bytes)
    $runLevel = try { (Get-ScheduledTask -TaskName '${SERVER_TASK}' -ErrorAction Stop).Principal.RunLevel } catch { 'Limited' }
    $launchTask = "Stop-ScheduledTask -TaskName '${RELAY_TASK}' -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Start-ScheduledTask -TaskName '${RELAY_TASK}'"
    $kickTask = "\`"$env:WINDIR\\System32\\conhost.exe\`" --headless \`"$env:WINDIR\\System32\\schtasks.exe\`" /run /tn ${RELAY_TASK}"
    $same = $task -and $task.Actions[0].Execute -eq $pyw -and $task.Actions[0].Arguments -eq $arguments
    $watched = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' -and "$($_.Repetition.Interval)" -eq 'PT1M' }).Count
    if ($same -and $watched) { $mode = 'task'; $launch = $launchTask; $kick = $kickTask }
    else { try {
        # Its own task: the server's restart ends the server's task, and must leave the relay running.
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
        # Restart-on-failure never fired for a relay that died (live), nor did a logon trigger's
        # repetition, which starts only at the next sign-in. A time trigger comes due every
        # minute from now on; while the relay runs, IgnoreNew makes that a no-op.
        $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName '${RELAY_TASK}' -Action (New-ScheduledTaskAction -Execute $pyw -Argument $arguments) -Trigger @((New-ScheduledTaskTrigger -AtLogOn -User $who), $every) -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel $runLevel) -Force | Out-Null
        $mode = 'task'; $launch = $launchTask; $kick = $kickTask
    } catch {
        # A task the elevated setup registered is the user's to run but not to change; the next setup adds the watchdog.
        if ($same) { $mode = 'task'; $launch = $launchTask; $kick = $kickTask } else {
        # A user who may not register tasks still starts it at every sign-in.
        $mode = 'runkey'; $launch = "Start-Process -FilePath '$($pyw -replace "'", "''")' -ArgumentList '$($arguments -replace "'", "''")'"
        $kick = "\`"$pyw\`" $arguments" }
    } }
    New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'pi-windows-use-relay' -Value $kick -PropertyType String -Force | Out-Null
    # A new relay that dies at start (a bind race, a script error) is rolled back to the old one.
    $relays = "Get-CimInstance Win32_Process | Where-Object { \`$_.Name -eq 'pythonw.exe' -and \`$_.CommandLine -like '*guest-relay.py*' }"
    $body = "$relays | ForEach-Object { Stop-Process -Id \`$_.ProcessId -Force -ErrorAction SilentlyContinue }; $launch; Start-Sleep -Seconds 10; if (-not ($relays) -and (Test-Path '$($prev -replace "'", "''")')) { Copy-Item '$($prev -replace "'", "''")' '$($f -replace "'", "''")' -Force; $launch }"
${inline ? `    # Nothing answers over the relay while setup runs, so it restarts now, before the host
    # hears the server is ready. Only as a task: this shell is elevated, and a relay it
    # started itself would be too. A Run-key relay starts at the next sign-in instead.
    if ($mode -eq 'task') { & ([scriptblock]::Create($body)); $restart = 'done' } else { $restart = 'none' }` : `    # Restarted after this command's answer is back, and outside windows-mcp.exe's process
    # tree: over the relay route, stopping it now would cut off this very answer.
    $helper = "Start-Sleep -Seconds 5; $body"
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper)) }
    if ($r.ReturnValue -ne 0) { throw "starting the relay failed with $($r.ReturnValue)" }
    $restart = 'scheduled'`}
}
$start = Join-Path $d 'windows-use-start.cmd'; $flash = 'absent'
if (Test-Path $start) {
    $lines = @(Get-Content $start)
    if ($lines -contains '${NO_FLASH}') { $flash = 'present' }
    else { [IO.File]::WriteAllText($start, ((@($lines[0], '${NO_FLASH}') + @($lines | Select-Object -Skip 1)) -join "\`r\`n") + "\`r\`n", [Text.Encoding]::ASCII); $flash = 'added' }
}
'${DONE}' + (@{ mode = $mode; flash = $flash; restart = $restart } | ConvertTo-Json -Compress)`;
}

export interface RelayDeployed {
	readonly mode: "task" | "runkey";
	/** Scheduled: the relay restarts in a moment with this script; none: the same one already runs. */
	readonly restart: "scheduled" | "none";
	/** Whether the server's start script already turned off Windows-MCP's capture flash. */
	readonly flash: "added" | "present" | "absent";
}

/** The install command's report, or an Error with the guest's own words. */
export function readRelayDeployed(text: string): RelayDeployed {
	const line = text.split(/\r?\n/).find((l) => l.includes(DONE));
	const value = line ? JSON.parse(line.slice(line.indexOf(DONE) + DONE.length).trim()) as Record<string, unknown> : undefined;
	if (!value || (value.mode !== "task" && value.mode !== "runkey") || !["added", "present", "absent"].includes(String(value.flash)) || (value.restart !== "scheduled" && value.restart !== "none")) {
		throw new Error(`the relay install reported: ${text.replace(/\s+/g, " ").trim().slice(0, 400) || "nothing"}`);
	}
	return { mode: value.mode, flash: value.flash as RelayDeployed["flash"], restart: value.restart };
}
