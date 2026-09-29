# Runs inside the guest, in an elevated PowerShell in the signed-in user's
# desktop session. The windows_use host fills in the key, port, run id and
# run level, gzips and base64s this file, and types it in, so the guest needs
# no file copy, credentials or network access from the host. Idempotent:
# rerunning repairs.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$key = '__KEY__'; $port = __PORT__; $run = '__RUN__'; $runLevel = '__RUNLEVEL__'
$utf8 = New-Object Text.UTF8Encoding $false
$done = $false
$statusDir = 'C:\ProgramData\pi-windows-use'
New-Item -ItemType Directory -Force -Path $statusDir | Out-Null
# Guest-to-host items; the service's own intrinsic items live in the sibling Auto key.
$kvp = 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest'
$taskName = 'windows-mcp-server'
function Set-Status($s) {
    [IO.File]::WriteAllText("$statusDir\status.txt", "$s`r`n", $utf8)
    Write-Host "[windows_use] $s"
    # Hyper-V key-value exchange is the host's only view of this script. The run
    # id lets it ignore an earlier run's status. Without the integration service
    # the write fails, and the host falls back to waiting for the port.
    $v = ("$run $s" -replace '\s+', ' ').Trim()
    if ($v.Length -gt 500) { $v = $v.Substring(0, 500) }
    try { New-ItemProperty -Path $kvp -Name 'PiWindowsUse' -Value $v -PropertyType String -Force -ErrorAction Stop | Out-Null } catch { Write-Host "  (status not published: $($_.Exception.Message))" }
}
function Invoke-Native([scriptblock]$cmd, [string]$what) {
    # PS 5.1 turns native stderr into terminating errors under 'Stop'; uv logs progress there.
    $ErrorActionPreference = 'Continue'
    $out = @(& $cmd 2>&1 | ForEach-Object { $line = "$_"; Write-Host "  $line"; $line })
    if ($LASTEXITCODE -ne 0) {
        $last = ($out | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' '
        throw "$what failed ($LASTEXITCODE): $last"
    }
}
function Stop-Server {
    # A running server holds its environment open, and uv can't replace an environment in use.
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'windows-mcp(\.exe)?"? serve|windows_mcp' -or $_.ExecutablePath -like '*\uv\tools\windows-mcp\*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
}
try {
    Set-Status 'installing uv'
    $who = "$env:USERDOMAIN\$env:USERNAME"
    $bin = Join-Path $env:USERPROFILE '.local\bin'
    $uv = Join-Path $bin 'uv.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    if (-not (Test-Path $uv)) {
        $env:UV_UNMANAGED_INSTALL = $bin   # fixed location, no PATH edits
        Invoke-Native { powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://astral.sh/uv/install.ps1 | iex' } 'uv install'
    }
    Set-Status 'stopping any running server'
    Stop-Server
    Set-Status 'installing windows-mcp'
    $env:UV_TOOL_BIN_DIR = $bin
    # Within the release line windows_use reads the snapshot text of; a new line may change it.
    Invoke-Native { & $uv tool install --upgrade --python 3.14 'windows-mcp>=0.8.6,<0.9' } 'uv tool install windows-mcp'
    $exe = Join-Path $bin 'windows-mcp.exe'
    if (-not (Test-Path $exe)) { throw "windows-mcp.exe missing at $exe" }

    Set-Status 'configuring'
    $cfgDir = Join-Path $env:USERPROFILE '.windows-mcp'
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    # Stateless HTTP so the host bridge can reconnect without session bookkeeping.
    $toml = "[server]`ntransport = `"streamable-http`"`nhost = `"0.0.0.0`"`nport = $port`nauth_key = `"$key`"`nstateless_http = true`n"
    [IO.File]::WriteAllText((Join-Path $cfgDir 'config.toml'), $toml, $utf8)
    $start = Join-Path $cfgDir 'windows-use-start.cmd'
    # First stop a server still running, which a restart typed as the signed-in user can't
    # when the server has administrator rights, and give its port a moment to close.
    $serve = @('@echo off', 'taskkill /f /t /im windows-mcp.exe >nul 2>&1', 'ping -n 3 127.0.0.1 >nul',
        "`"$exe`" serve 1>>`"$cfgDir\server.log`" 2>>`"$cfgDir\server.error.log`"")
    [IO.File]::WriteAllText($start, ($serve -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)

    # Logon task: the server lives in the interactive session (UIA needs it) and conhost
    # --headless keeps a console window off the desktop the agent drives. Its run level is
    # Limited, or Highest when the host asks for administrator rights (PI_WINDOWS_USE_ELEVATED).
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless cmd.exe /c `"$start`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $who
    # Restarts cover a crash while the user stays signed in, which the host cannot repair without clicking blind.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel $runLevel
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    # In testing the logon trigger never fired after a restart. Explorer runs the Run key at every
    # sign-in, automatic ones included; it starts the same task, whose IgnoreNew policy stops doubles.
    $kick = "`"$env:WINDIR\System32\conhost.exe`" --headless `"$env:WINDIR\System32\schtasks.exe`" /run /tn $taskName"
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'pi-windows-use' -Value $kick -PropertyType String -Force | Out-Null

    Set-Status 'firewall'
    Remove-NetFirewallRule -Name 'hvcu-windows-mcp' -ErrorAction SilentlyContinue   # rule name before pi-extras
    Remove-NetFirewallRule -Name 'pi-windows-use' -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name 'pi-windows-use' -DisplayName 'Windows-MCP for pi windows_use' -Direction Inbound -Protocol TCP `
        -LocalPort $port -RemoteAddress LocalSubnet -Profile Any -Action Allow | Out-Null

    Set-Status 'starting'
    Start-ScheduledTask -TaskName $taskName
    foreach ($i in 1..60) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { break }
        Start-Sleep -Seconds 2
    }
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        $tail = if (Test-Path "$cfgDir\server.error.log") { (Get-Content "$cfgDir\server.error.log" -Tail 20) -join "`n" } else { '' }
        throw "server did not start listening on $port. $tail"
    }
    Set-Status "OK listening on $port"
    $done = $true
} catch {
    Set-Status "FAIL $($_.Exception.Message)"
}
# The typed one-liner carries the auth key; keep it out of PSReadLine history.
try {
    $history = (Get-PSReadLineOption).HistorySavePath
    if (Test-Path $history) { Set-Content -Path $history -Value @(Get-Content $history | Where-Object { $_ -notlike '$b=''H4sI*' }) }
} catch { }
# On success close the window so it doesn't cover the desktop the agent drives;
# on failure leave it open with the error for a screenshot.
if ($done) { Start-Sleep -Seconds 2; exit }
