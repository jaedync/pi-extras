<#
  windows_use host. Runs on the Windows side of WSL, started by pi-extras, and
  speaks JSON-RPC 2.0 over stdio, one message per line. It drives Hyper-V
  guests through WMI (screen, keyboard, mouse) and relays MCP messages to
  Windows-MCP inside them. The host can always reach its guests, which WSL's
  NAT often cannot. stdout carries protocol messages only.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object Text.UTF8Encoding $false
$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"
$ns = 'root\virtualization\v2'
$dataDir = Join-Path $env:LOCALAPPDATA 'pi-extras\windows-use'
$defaultPort = 8000
Add-Type -AssemblyName System.Net.Http
Import-Module Hyper-V -ErrorAction Stop

# Pre-serialized JSON, embedded in a response as is.
class RawJson { [string]$Text; RawJson([string]$text) { $this.Text = $text } }

# ---- VMs -------------------------------------------------------------------

$stateNames = @{ 2 = 'running'; 3 = 'off'; 4 = 'shutting down'; 6 = 'saved'; 10 = 'starting'; 32768 = 'paused'; 32769 = 'saved'; 32770 = 'starting'; 32773 = 'saving'; 32774 = 'stopping'; 32776 = 'pausing'; 32777 = 'resuming' }
function Get-StateName($state) { $n = $stateNames[[int]$state]; if ($n) { $n } else { "state $state" } }
function Get-SafeName([string]$vm) { $vm -replace '[^\w-]', '_' }
function Get-KeyFile([string]$vm) { Join-Path $dataDir ((Get-SafeName $vm) + '.key') }

function Get-Machine([string]$vm) {
    if (-not $vm) { throw 'vm is required' }
    $m = Get-CimInstance -Namespace $ns -ClassName Msvm_ComputerSystem -Filter "Caption='Virtual Machine' AND ElementName='$($vm -replace "'", "''")'"
    if (-not $m) { throw "There is no Hyper-V VM named '$vm'" }
    @($m)[0]
}
function Get-RunningMachine([string]$vm) {
    $m = Get-Machine $vm
    if ($m.EnabledState -ne 2) { throw "VM '$vm' is $(Get-StateName $m.EnabledState), not running" }
    $m
}
function Get-Device($machine, [string]$class) {
    $d = Get-CimAssociatedInstance -InputObject $machine -ResultClassName $class | Select-Object -First 1
    if (-not $d) { throw "$class not found on '$($machine.ElementName)'" }
    $d
}
function Get-Resolution($machine) {
    $head = Get-CimAssociatedInstance -InputObject $machine -ResultClassName Msvm_VideoHead | Select-Object -First 1
    @{ w = [int](@($head.CurrentHorizontalResolution)[0]); h = [int](@($head.CurrentVerticalResolution)[0]) }
}
function Get-Ipv4([string]$vm) {
    (Get-VMNetworkAdapter -VMName $vm).IPAddresses |
        Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notmatch '^169\.254\.' } | Select-Object -First 1
}
# Hyper-V's method return codes, named so errors say what went wrong.
$returnCodes = @{
    32768 = 'failed'; 32769 = 'access denied'; 32770 = 'not supported'; 32771 = 'status unknown'
    32772 = 'timed out'; 32773 = 'invalid parameter'; 32774 = 'system in use'
    32775 = 'invalid state: the VM may be saving, restarting or stopping'; 32776 = 'incorrect data type'
    32777 = 'system not available'; 32778 = 'out of memory'
}
function Get-Failure([string]$method, $code) {
    $name = $returnCodes[[int]$code]
    if ($name) { "$method failed with code $code ($name)" } else { "$method failed with code $code" }
}
function Invoke-Checked($obj, [string]$method, $arguments) {
    $r = Invoke-CimMethod -InputObject $obj -MethodName $method -Arguments $arguments
    if ($r.ReturnValue -ne 0) { throw (Get-Failure $method $r.ReturnValue) }
}

function Get-Vms {
    $list = @(Get-VM | Sort-Object Name | ForEach-Object {
        $vm = $_.Name
        $running = $_.State -eq 'Running'
        [ordered]@{ name = $vm; state = "$($_.State)".ToLowerInvariant(); running = $running; installed = (Test-Path (Get-KeyFile $vm)); ip = $(if ($running) { Get-Ipv4 $vm } else { $null }) }
    })
    , $list
}
# Heartbeat: $true once Windows answers the heartbeat integration service,
# $false while it is still starting or stopping, $null when that service is off.
# Uptime: seconds since Windows last started; a restart inside the guest resets it.
function Get-Liveness([string]$vm) {
    $hv = Get-VM -Name $vm
    $state = "$($hv.Heartbeat)"
    @{ heartbeat = $(if ($state) { $state -like 'Ok*' } else { $null }); uptime = [int]$hv.Uptime.TotalSeconds }
}
function Get-Status([string]$vm) {
    $m = Get-Machine $vm
    $running = $m.EnabledState -eq 2
    $size = if ($running) { Get-Resolution $m } else { @{ w = 0; h = 0 } }
    $live = if ($running) { Get-Liveness $vm } else { @{ heartbeat = $null; uptime = $null } }
    [ordered]@{ vm = $vm; state = (Get-StateName $m.EnabledState); running = $running; ip = $(if ($running) { Get-Ipv4 $vm } else { $null }); width = $size.w; height = $size.h; installed = (Test-Path (Get-KeyFile $vm)); heartbeat = $live.heartbeat; uptime = $live.uptime }
}
function Start-Machine([string]$vm) {
    Start-VM -Name $vm | Out-Null
    Get-Status $vm
}

# ---- Screen ------------------------------------------------------------------

# The console as raw RGB565 pixels, scaled by Hyper-V to the requested width.
# pi-extras encodes and inspects them: pixel work here would get this script
# held up by antivirus, which watches PowerShell that copies image memory.
function Get-FrameData([string]$vm, [int]$width) {
    $m = Get-RunningMachine $vm
    $size = Get-Resolution $m
    $w = if ($width -gt 0 -and $width -lt $size.w) { $width } else { $size.w }
    $h = [int][math]::Round($w * $size.h / [math]::Max(1, $size.w))
    $vmms = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService
    $vssd = Get-CimAssociatedInstance -InputObject $m -ResultClassName Msvm_VirtualSystemSettingData |
        Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
    $r = Invoke-CimMethod -InputObject $vmms -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $vssd; WidthPixels = [uint16]$w; HeightPixels = [uint16]$h }
    if ($r.ReturnValue -ne 0) { throw (Get-Failure 'GetVirtualSystemThumbnailImage' $r.ReturnValue) }
    [pscustomobject]@{ w = $w; h = $h; data = [byte[]]$r.ImageData }
}
function Get-Frame([string]$vm, [int]$width) {
    $f = Get-FrameData $vm $width
    [RawJson]::new('{"width":' + $f.w + ',"height":' + $f.h + ',"data":"' + [Convert]::ToBase64String($f.data) + '"}')
}

# The console's text through Windows OCR, at full resolution. The module loads
# on first use; its warnings and output must stay off stdout, which carries the protocol.
function Get-ImageText($png) {
    Import-Module (Join-Path $PSScriptRoot 'ocr.psm1') -WarningAction SilentlyContinue | Out-Null
    Read-ImageText $png
}
function Get-FrameText([string]$vm) {
    Import-Module (Join-Path $PSScriptRoot 'ocr.psm1') -WarningAction SilentlyContinue | Out-Null
    $f = Get-FrameData $vm 0
    Read-FrameText $f.w $f.h $f.data
}

# ---- Input -------------------------------------------------------------------

# US-layout ASCII to virtual key codes and whether Shift is held.
$keyMap = New-Object System.Collections.Hashtable([StringComparer]::Ordinal)
foreach ($row in @(
        @('1234567890-=', '!@#$%^&*()_+', @(0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x30,0xBD,0xBB)),
        @('qwertyuiop[]', 'QWERTYUIOP{}', @(0x51,0x57,0x45,0x52,0x54,0x59,0x55,0x49,0x4F,0x50,0xDB,0xDD)),
        @("asdfghjkl;'``", 'ASDFGHJKL:"~', @(0x41,0x53,0x44,0x46,0x47,0x48,0x4A,0x4B,0x4C,0xBA,0xDE,0xC0)),
        @('\zxcvbnm,./', '|ZXCVBNM<>?', @(0xDC,0x5A,0x58,0x43,0x56,0x42,0x4E,0x4D,0xBC,0xBE,0xBF)))) {
    for ($k = 0; $k -lt $row[0].Length; $k++) {
        $keyMap[[string]$row[0][$k]] = @($row[2][$k], $false)
        $keyMap[[string]$row[1][$k]] = @($row[2][$k], $true)
    }
}
$keyMap[' '] = @(0x20, $false); $keyMap["`t"] = @(0x09, $false); $keyMap["`n"] = @(0x0D, $false)

function ConvertTo-KeyEvents([string]$text) {
    $out = New-Object System.Collections.Generic.List[object]
    $shifted = $false
    foreach ($ch in ($text -replace "`r`n", "`n").ToCharArray()) {
        $e = $keyMap[[string]$ch]
        if (-not $e) { throw "Cannot type character U+$(([int]$ch).ToString('X4')) through the console keyboard (US layout); win.type types any text through Windows-MCP" }
        if ($e[1] -ne $shifted) {
            $out.Add([pscustomobject]@{ Method = $(if ($e[1]) { 'PressKey' } else { 'ReleaseKey' }); Key = 0x10 })
            $shifted = $e[1]
        }
        $out.Add([pscustomobject]@{ Method = 'TypeKey'; Key = $e[0] })
    }
    if ($shifted) { $out.Add([pscustomobject]@{ Method = 'ReleaseKey'; Key = 0x10 }) }
    , $out.ToArray()
}

# TypeText is ignored by console windows. TypeKey supplies a physical paired
# stroke in one CIM call; separate scancode calls made large input too slow.
# Settlement is still essential: unsynchronised Shift typed '$x' as '4x' live.
$textEventSettleMs = 50
function Send-Text($machine, [string]$text, [scriptblock]$onQueued) {
    $events = ConvertTo-KeyEvents $text
    $kb = Get-Device $machine 'Msvm_Keyboard'
    $pendingKey = $null
    $errors = @()
    $lastStroke = $events.Count - 1
    if ($lastStroke -ge 0 -and $events[$lastStroke].Method -ne 'TypeKey') { $lastStroke-- }
    try {
        for ($i = 0; $i -lt $events.Count; $i++) {
            $event = $events[$i]
            if ($event.Method -eq 'TypeKey') { $pendingKey = $event.Key }
            Invoke-Checked $kb $event.Method @{ keyCode = [uint32]$event.Key }
            $pendingKey = $null
            if ($i -eq $lastStroke -and $onQueued) { & $onQueued }
            Start-Sleep -Milliseconds $textEventSettleMs
        }
    } catch { $errors = @($_.Exception.Message) }
    finally {
        # A failed paired stroke may have pressed its ordinary key. Release it
        # without replaying, and attempt Shift cleanup even if that release fails.
        $release = if ($null -ne $pendingKey) { @($pendingKey, 0x10) } else { @(0x10) }
        foreach ($releaseCode in $release) {
            try { Invoke-Checked $kb 'ReleaseKey' @{ keyCode = [uint32]$releaseCode } }
            catch { $errors = @($errors + $_.Exception.Message) }
        }
        if ($errors.Count) { throw ("Console text input failed; earlier characters may already be typed. The failed stroke was not repeated. " + ($errors -join '; ')) }
    }
}

$vkNames = @{
    ctrl = 0x11; control = 0x11; alt = 0x12; shift = 0x10; win = 0x5B; super = 0x5B
    enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; backspace = 0x08; delete = 0x2E; del = 0x2E
    space = 0x20; up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23
    pageup = 0x21; pagedown = 0x22; insert = 0x2D; apps = 0x5D; menu = 0x5D; printscreen = 0x2C
}
function Get-Vk([string]$name) {
    $n = $name.Trim().ToLowerInvariant()
    if ($vkNames.ContainsKey($n)) { return $vkNames[$n] }
    if ($n -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
    if ($n -match '^[a-z0-9]$') { return [int][char]$n.ToUpperInvariant() }
    throw "Unknown key '$name'"
}
function Send-Keys($machine, [string]$keys) {
    $kb = Get-Device $machine 'Msvm_Keyboard'
    $codes = @($keys -split '\+' | ForEach-Object { Get-Vk $_ })
    # Hold in order, release in reverse, so combos like ctrl+shift+esc register.
    # Whatever went down comes up even if a press fails, or Ctrl stays held in the guest.
    $held = New-Object System.Collections.Generic.List[int]
    $failed = $null
    try {
        foreach ($c in $codes) { Invoke-Checked $kb 'PressKey' @{ keyCode = [uint32]$c }; $held.Insert(0, $c) }
    } finally {
        foreach ($c in $held) {
            $r = Invoke-CimMethod -InputObject $kb -MethodName 'ReleaseKey' -Arguments @{ keyCode = [uint32]$c }
            if ($r.ReturnValue -ne 0 -and -not $failed) { $failed = Get-Failure 'ReleaseKey' $r.ReturnValue }
        }
    }
    if ($failed) { throw $failed }
}

# The synthetic mouse drops a click unless the pointer has just moved, so every
# positioning goes through a one-pixel nudge.
function Set-Pointer($mouse, [int]$x, [int]$y) {
    Invoke-Checked $mouse 'SetAbsolutePosition' @{ horizontalPosition = [math]::Max(0, $x - 1); verticalPosition = $y }
    Start-Sleep -Milliseconds 80
    Invoke-Checked $mouse 'SetAbsolutePosition' @{ horizontalPosition = $x; verticalPosition = $y }
}
function Send-Click($machine, [int]$x, [int]$y, [string]$button, [bool]$double) {
    $mouse = Get-Device $machine 'Msvm_SyntheticMouse'
    Set-Pointer $mouse $x $y
    Start-Sleep -Milliseconds 50
    $index = @{ left = 1; right = 2; middle = 3 }[$(if ($button) { $button } else { 'left' })]
    if (-not $index) { throw "Unknown button '$button'" }
    Invoke-Checked $mouse 'ClickButton' @{ buttonIndex = [uint32]$index }
    if ($double) { Invoke-Checked $mouse 'ClickButton' @{ buttonIndex = [uint32]$index } }
}
# Windows starts a drag only after the pointer moves with the button down, and a
# window being moved follows the moves it sees, so the pointer travels in steps.
function Send-Drag($machine, [int]$x, [int]$y, [int]$x2, [int]$y2) {
    $mouse = Get-Device $machine 'Msvm_SyntheticMouse'
    Set-Pointer $mouse $x $y
    Invoke-Checked $mouse 'SetButtonState' @{ buttonIndex = [uint32]1; isDown = $true }
    Start-Sleep -Milliseconds 150
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
        Invoke-Checked $mouse 'SetAbsolutePosition' @{ horizontalPosition = [int]($x + ($x2 - $x) * $i / $steps); verticalPosition = [int]($y + ($y2 - $y) * $i / $steps) }
        Start-Sleep -Milliseconds 25
    }
    Start-Sleep -Milliseconds 150
    Invoke-Checked $mouse 'SetButtonState' @{ buttonIndex = [uint32]1; isDown = $false }
}
# Notches of the wheel: negative scrolls down. Hyper-V takes 120ths of a notch.
function Send-Scroll($machine, [int]$x, [int]$y, [int]$notches) {
    $mouse = Get-Device $machine 'Msvm_SyntheticMouse'
    Set-Pointer $mouse $x $y
    Invoke-Checked $mouse 'SetScrollPosition' @{ scrollPositionDelta = $notches * 120 }
}

# Signs in the last-used account at the console. A passwordless account's tile
# shows a "Sign in" button just below screen center; lab VMs often use one.
# Only call this when the console is known to be at the lock or sign-in screen.
function Invoke-Login([string]$vm) {
    $m = Get-RunningMachine $vm
    $kb = Get-Device $m 'Msvm_Keyboard'
    Invoke-Checked $kb 'TypeKey' @{ keyCode = [uint32]0x10 }   # wake the display
    Start-Sleep -Seconds 2
    Invoke-Checked $kb 'TypeKey' @{ keyCode = [uint32]0x20 }   # lift the lock curtain
    Start-Sleep -Seconds 2
    $size = Get-Resolution $m
    Send-Click $m ([int]($size.w / 2)) ([int]($size.h / 2) + 42) 'left' $false
    [ordered]@{ clicked = @([int]($size.w / 2), [int]($size.h / 2) + 42) }
}

# ---- Setup -------------------------------------------------------------------

function New-Key {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Set-Key([string]$vm, [string]$key) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $file = Get-KeyFile $vm
    $pending = $file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($pending, $key)
        # PS5.1 converts $null to an empty string here; the API needs a real null.
        if (Test-Path $file) { [IO.File]::Replace($pending, $file, [NullString]::Value) }
        else { [IO.File]::Move($pending, $file) }
    } finally { if (Test-Path $pending) { [IO.File]::Delete($pending) } }
}

function Get-Key([string]$vm, [bool]$rotate) {
    $file = Get-KeyFile $vm
    if ($rotate -or -not (Test-Path $file)) { Set-Key $vm (New-Key) }
    (Get-Content -Path $file -Raw).Trim()
}

# Opens an administrator's PowerShell at the console of a signed-in, unlocked
# guest: Run (Win+R), which explorer serves even while Start search hangs, then
# Ctrl+Shift+Enter, and Yes on UAC (host-injected keys reach the secure desktop).
# The caller reads the console to check it opened before calling setup.
function Open-AdminShell([string]$vm) {
    $m = Get-RunningMachine $vm
    Send-Keys $m 'esc'; Start-Sleep -Seconds 1
    Send-Keys $m 'win+r'; Start-Sleep -Seconds 2
    Send-Text $m 'powershell'; Start-Sleep -Seconds 1
    Send-Keys $m 'ctrl+shift+enter'; Start-Sleep -Seconds 4
    Send-Keys $m 'alt+y'
    @{ ok = $true }
}

# Installs Windows-MCP by typing the bootstrap, compressed, into the caller's
# launcher line, at the administrator's PowerShell Open-AdminShell opened. The
# launcher arrives as data rather than living in this file: antivirus holds up
# scripts that decode and run payloads for many seconds before they start.
# Returns once typing is queued; the caller waits for the port.
function Invoke-Setup([string]$vm, [int]$port, [string]$launcher, [bool]$elevated) {
    if (-not $launcher.Contains('__PAYLOAD__')) { throw 'setup needs a launcher containing __PAYLOAD__' }
    $m = Get-RunningMachine $vm
    # Disable sensitive command history and per-character line redraws only
    # in this disposable shell. The user's profile remains unchanged.
    Send-Text $m "if(get-module psreadline){remove-module psreadline}`n"
    Start-Sleep -Seconds 2
    # Keep the active key usable if typing times out before the command enters.
    $key = New-Key
    # Tags the status the bootstrap publishes, so an earlier run's can't be mistaken for this one's.
    $run = -join (1..8 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    # Comment lines go: paced console input makes every extra character costly.
    $lines = (Get-Content -Path (Join-Path $PSScriptRoot 'guest-bootstrap.ps1')) | Where-Object { $_ -notmatch '^\s*#' }
    $runLevel = if ($elevated) { 'Highest' } else { 'Limited' }
    $script = ($lines -join "`n").Replace('__KEY__', $key).Replace('__PORT__', "$port").Replace('__RUNLEVEL__', $runLevel).Replace('__RUN__', $run)
    $ms = New-Object IO.MemoryStream
    $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
    $raw = [Text.Encoding]::UTF8.GetBytes($script)
    $gz.Write($raw, 0, $raw.Length); $gz.Close()
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $line = $launcher.Replace('__PAYLOAD__', $b64) + "`n"
    # Enter follows the same sequential key-event path, so it cannot overtake text.
    # Commit when Enter is queued, before cleanup that can itself fail. The old
    # server must not masquerade as ready after the new install may have started.
    Send-Text $m $line { Set-Key $vm $key }
    [ordered]@{ typed = $line.Length; port = $port; run = $run }
}

# The "<run> <status>" the guest bootstrap last published over Hyper-V
# key-value exchange, or $null. Best effort: a VM without the integration
# service still installs, and the caller just waits for the port instead.
function Get-SetupStatus([string]$vm) {
    try {
        $k = Get-CimAssociatedInstance -InputObject (Get-Machine $vm) -ResultClassName Msvm_KvpExchangeComponent
        foreach ($item in @($k.GuestExchangeItems | Where-Object { $_ })) {
            $props = ([xml]$item).INSTANCE.PROPERTY
            if (($props | Where-Object { $_.NAME -eq 'Name' }).VALUE -eq 'PiWindowsUse') { return [string]($props | Where-Object { $_.NAME -eq 'Data' }).VALUE }
        }
    } catch { [Console]::Error.WriteLine("setup status unreadable for '$vm': $($_.Exception.Message)") }
    $null
}

function Test-Port([string]$vm, [int]$port) {
    $ip = Get-Ipv4 $vm
    if (-not $ip) { return [ordered]@{ reachable = $false; ip = $null; setup = (Get-SetupStatus $vm) } }
    $tcp = New-Object Net.Sockets.TcpClient
    try { $ok = $tcp.ConnectAsync($ip, $port).Wait(2000) -and $tcp.Connected } catch { $ok = $false } finally { $tcp.Dispose() }
    [ordered]@{ reachable = $ok; ip = $ip; setup = (Get-SetupStatus $vm) }
}

# ---- MCP relay -----------------------------------------------------------------

$handler = New-Object Net.Http.HttpClientHandler
$handler.UseProxy = $false            # corporate proxies must not see host-to-guest traffic
$handler.AllowAutoRedirect = $false   # a redirect would silently drop the Authorization header
$http = New-Object Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromMinutes(10)

# Posts one JSON-RPC message to the guest's Windows-MCP (stateless Streamable
# HTTP) and returns the JSON messages it answers with, SSE or plain.
function Send-Mcp([string]$vm, [int]$port, [string]$message) {
    $ip = Get-Ipv4 $vm
    if (-not $ip) { throw "VM '$vm' has no IPv4 address yet" }
    $keyFile = Get-KeyFile $vm
    if (-not (Test-Path $keyFile)) { throw "Windows-MCP is not set up on '$vm'" }
    $req = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Post, "http://${ip}:$port/mcp")
    $req.Content = New-Object Net.Http.StringContent($message, $utf8, 'application/json')
    $req.Headers.Accept.ParseAdd('application/json')
    $req.Headers.Accept.ParseAdd('text/event-stream')
    [void]$req.Headers.TryAddWithoutValidation('Authorization', 'Bearer ' + (Get-Content -Path $keyFile -Raw).Trim())
    try { $resp = $http.SendAsync($req, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult() }
    catch {
        $base = $_.Exception.GetBaseException()
        # Only a connection that never opened proves the request didn't arrive, so
        # only then may the caller send it again; any other failure may follow a run.
        $unsent = $base -is [Net.Sockets.SocketException] -and "$($base.SocketErrorCode)" -in @('ConnectionRefused', 'TimedOut', 'HostUnreachable', 'NetworkUnreachable', 'HostNotFound', 'HostDown')
        if ($unsent) { throw "cannot reach Windows-MCP on '$vm' (${ip}:$port): $($base.Message)" }
        throw "lost the connection to Windows-MCP on '$vm' (${ip}:$port) during the call: $($base.Message)"
    }
    try {
        if ([int]$resp.StatusCode -eq 202) { return [RawJson]::new('{"messages":[]}') }
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { throw "Windows-MCP on '$vm' answered HTTP $([int]$resp.StatusCode): $body" }
        $messages = New-Object System.Collections.Generic.List[string]
        if ($resp.Content.Headers.ContentType.MediaType -eq 'text/event-stream') {
            $data = New-Object Text.StringBuilder
            foreach ($l in ($body -split "`r?`n")) {
                if ($l -eq '') { if ($data.Length) { $messages.Add($data.ToString()); [void]$data.Clear() } }
                elseif ($l.StartsWith('data:')) { $v = $l.Substring(5); if ($v.StartsWith(' ')) { $v = $v.Substring(1) }; if ($data.Length) { [void]$data.Append("`n") }; [void]$data.Append($v) }
            }
            if ($data.Length) { $messages.Add($data.ToString()) }
        } elseif ($body.Trim()) { $messages.Add($body.Trim()) }
        # Each message is already JSON from the server, so it is embedded unparsed.
        [RawJson]::new('{"messages":[' + ($messages -join ',') + ']}')
    } finally { $resp.Dispose() }
}

# ---- Protocol ------------------------------------------------------------------

function Get-Port($p) { if ($p.port) { [int]$p.port } else { $defaultPort } }

$handlers = @{
    vms        = { param($p) Get-Vms }
    status     = { param($p) Get-Status $p.vm }
    start      = { param($p) Start-Machine $p.vm }
    frame      = { param($p) Get-Frame $p.vm $(if ($p.width) { [int]$p.width } else { 0 }) }
    ocr        = { param($p) Get-FrameText $p.vm }
    ocrImage   = { param($p) Get-ImageText $p.png }
    click      = { param($p) Send-Click (Get-RunningMachine $p.vm) $p.x $p.y $p.button ([bool]$p.double); @{ ok = $true } }
    move       = { param($p) Set-Pointer (Get-Device (Get-RunningMachine $p.vm) 'Msvm_SyntheticMouse') $p.x $p.y; @{ ok = $true } }
    drag       = { param($p) Send-Drag (Get-RunningMachine $p.vm) $p.x $p.y $p.x2 $p.y2; @{ ok = $true } }
    scroll     = { param($p) Send-Scroll (Get-RunningMachine $p.vm) $p.x $p.y $(if ($null -ne $p.amount) { $p.amount } else { -3 }); @{ ok = $true } }
    type       = { param($p) Send-Text (Get-RunningMachine $p.vm) ([string]$p.text); @{ ok = $true } }
    key        = { param($p) Send-Keys (Get-RunningMachine $p.vm) ([string]$p.keys); @{ ok = $true } }
    cad        = { param($p) Invoke-Checked (Get-Device (Get-RunningMachine $p.vm) 'Msvm_Keyboard') 'TypeCtrlAltDel' @{}; @{ ok = $true } }
    login      = { param($p) Invoke-Login $p.vm }
    adminShell = { param($p) Open-AdminShell $p.vm }
    setup      = { param($p) Invoke-Setup $p.vm (Get-Port $p) ([string]$p.launcher) ($p.elevated -eq $true) }
    probe      = { param($p) Test-Port $p.vm (Get-Port $p) }
    mcp        = { param($p) Send-Mcp $p.vm (Get-Port $p) ([string]$p.message) }
}

function Write-Message([string]$idJson, [string]$body) { $stdout.WriteLine('{"jsonrpc":"2.0","id":' + $idJson + ',' + $body + '}') }

while ($null -ne ($line = $stdin.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $idJson = 'null'
    try {
        $req = $line | ConvertFrom-Json
        if ($null -eq $req.id) { continue }   # notifications need no answer
        $idJson = ConvertTo-Json $req.id -Compress
        $run = $handlers[[string]$req.method]
        if (-not $run) { throw "unknown method '$($req.method)'" }
        $params = if ($req.params) { $req.params } else { [pscustomobject]@{} }
        $result = & $run $params
        $json = if ($result -is [RawJson]) { $result.Text } else { ConvertTo-Json -InputObject $result -Depth 6 -Compress }
        Write-Message $idJson ('"result":' + $json)
    } catch {
        $message = ConvertTo-Json -InputObject ([string]$_.Exception.Message) -Compress
        Write-Message $idJson ('"error":{"code":-32000,"message":' + $message + '}')
    }
}
