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

$stateNames = @{ 2 = 'running'; 3 = 'off'; 6 = 'saved'; 32768 = 'paused'; 32769 = 'saved'; 32770 = 'starting'; 32773 = 'saving'; 32774 = 'stopping'; 32776 = 'pausing'; 32777 = 'resuming' }
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
function Get-FrameText([string]$vm) {
    Import-Module (Join-Path $PSScriptRoot 'ocr.psm1') -WarningAction SilentlyContinue | Out-Null
    $f = Get-FrameData $vm 0
    Read-FrameText $f.w $f.h $f.data
}

# ---- Input -------------------------------------------------------------------

# US-layout ASCII to PC/AT set-1 scancodes: make code and whether shift is held.
$scanMap = New-Object System.Collections.Hashtable([StringComparer]::Ordinal)
foreach ($row in @(
        @('1234567890-=', '!@#$%^&*()_+', 0x02),
        @('qwertyuiop[]', 'QWERTYUIOP{}', 0x10),
        @("asdfghjkl;'``", 'ASDFGHJKL:"~', 0x1E),
        @('\zxcvbnm,./', '|ZXCVBNM<>?', 0x2B))) {
    for ($k = 0; $k -lt $row[0].Length; $k++) {
        $scanMap[[string]$row[0][$k]] = @(($row[2] + $k), $false)
        $scanMap[[string]$row[1][$k]] = @(($row[2] + $k), $true)
    }
}
$scanMap[' '] = @(0x39, $false); $scanMap["`t"] = @(0x0F, $false); $scanMap["`n"] = @(0x1C, $false)

function ConvertTo-Scancodes([string]$text) {
    $out = New-Object System.Collections.Generic.List[byte]
    foreach ($ch in ($text -replace "`r`n", "`n").ToCharArray()) {
        $e = $scanMap[[string]$ch]
        if (-not $e) { throw "Cannot type character U+$(([int]$ch).ToString('X4')) through the console keyboard (US layout); win.type types any text through Windows-MCP" }
        if ($e[1]) { $out.Add(0x2A) }
        $out.Add([byte]$e[0]); $out.Add([byte]($e[0] -bor 0x80))
        if ($e[1]) { $out.Add(0xAA) }
    }
    , $out.ToArray()
}

# TypeText is ignored by console windows, so text goes in as scancodes, which
# behave like physical key presses. Input is asynchronous with a bounded guest
# buffer; a full buffer answers 32773 (Invalid parameter), so back off.
function Send-Text($machine, [string]$text) {
    $kb = Get-Device $machine 'Msvm_Keyboard'
    $codes = ConvertTo-Scancodes $text
    for ($i = 0; $i -lt $codes.Count; $i += 480) {
        $chunk = [byte[]]$codes[$i..([math]::Min($i + 480, $codes.Count) - 1)]
        for ($try = 0; ; $try++) {
            $rv = (Invoke-CimMethod -InputObject $kb -MethodName TypeScancodes -Arguments @{ scancodes = $chunk }).ReturnValue
            if ($rv -eq 0) { break }
            if ($rv -ne 32773 -or $try -ge 120) { throw (Get-Failure 'TypeScancodes' $rv) }
            Start-Sleep -Milliseconds 500
        }
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
    foreach ($c in $codes) { Invoke-Checked $kb 'PressKey' @{ keyCode = [uint32]$c } }
    [array]::Reverse($codes)
    foreach ($c in $codes) { Invoke-Checked $kb 'ReleaseKey' @{ keyCode = [uint32]$c } }
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
function Send-Drag($machine, [int]$x, [int]$y, [int]$x2, [int]$y2) {
    $mouse = Get-Device $machine 'Msvm_SyntheticMouse'
    Set-Pointer $mouse $x $y
    Invoke-Checked $mouse 'SetButtonState' @{ buttonIndex = [uint32]1; isPressed = $true }
    Start-Sleep -Milliseconds 100
    Invoke-Checked $mouse 'SetAbsolutePosition' @{ horizontalPosition = $x2; verticalPosition = $y2 }
    Start-Sleep -Milliseconds 100
    Invoke-Checked $mouse 'SetButtonState' @{ buttonIndex = [uint32]1; isPressed = $false }
}
function Send-Scroll($machine, [int]$x, [int]$y, [int]$amount) {
    $mouse = Get-Device $machine 'Msvm_SyntheticMouse'
    Set-Pointer $mouse $x $y
    Invoke-Checked $mouse 'SetScrollPosition' @{ scrollPosition = $amount }
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

function Get-Key([string]$vm, [bool]$rotate) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $file = Get-KeyFile $vm
    if ($rotate -or -not (Test-Path $file)) {
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        [IO.File]::WriteAllText($file, (-join ($bytes | ForEach-Object { $_.ToString('x2') })))
    }
    (Get-Content -Path $file -Raw).Trim()
}

# Installs Windows-MCP into the signed-in guest with nothing but the console:
# opens an elevated PowerShell from Start search, accepts UAC (host-injected
# keys reach the secure desktop) and types the bootstrap, compressed, into the
# caller's launcher line. The launcher arrives as data rather than living in
# this file: antivirus holds up scripts that decode and run payloads for many
# seconds before they start. Returns once typing is queued; the caller waits
# for the port. The desktop must be unlocked.
function Invoke-Setup([string]$vm, [int]$port, [string]$launcher) {
    if (-not $launcher.Contains('__PAYLOAD__')) { throw 'setup needs a launcher containing __PAYLOAD__' }
    $m = Get-RunningMachine $vm
    # A fresh key: a server being replaced keeps answering until the bootstrap
    # stops it, and must not pass for the new one. It also retires the last key typed.
    $key = Get-Key $vm $true
    # Tags the status the bootstrap publishes, so an earlier run's can't be mistaken for this one's.
    $run = -join (1..8 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    # Comment lines go: typing runs at a few dozen characters a second.
    $lines = (Get-Content -Path (Join-Path $PSScriptRoot 'guest-bootstrap.ps1')) | Where-Object { $_ -notmatch '^\s*#' }
    $script = ($lines -join "`n").Replace('__KEY__', $key).Replace('__PORT__', "$port").Replace('__RUN__', $run)
    $ms = New-Object IO.MemoryStream
    $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
    $raw = [Text.Encoding]::UTF8.GetBytes($script)
    $gz.Write($raw, 0, $raw.Length); $gz.Close()
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $line = $launcher.Replace('__PAYLOAD__', $b64) + "`n"
    Send-Keys $m 'esc'; Start-Sleep -Seconds 1
    Send-Keys $m 'win'; Start-Sleep -Seconds 2
    Send-Text $m 'powershell'; Start-Sleep -Seconds 2
    Send-Keys $m 'ctrl+shift+enter'; Start-Sleep -Seconds 4
    Send-Keys $m 'alt+y'; Start-Sleep -Seconds 5
    # The newline rides in the same scancode stream, so Enter can't overtake the text.
    Send-Text $m $line
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
    click      = { param($p) Send-Click (Get-RunningMachine $p.vm) $p.x $p.y $p.button ([bool]$p.double); @{ ok = $true } }
    move       = { param($p) Set-Pointer (Get-Device (Get-RunningMachine $p.vm) 'Msvm_SyntheticMouse') $p.x $p.y; @{ ok = $true } }
    drag       = { param($p) Send-Drag (Get-RunningMachine $p.vm) $p.x $p.y $p.x2 $p.y2; @{ ok = $true } }
    scroll     = { param($p) Send-Scroll (Get-RunningMachine $p.vm) $p.x $p.y $(if ($null -ne $p.amount) { $p.amount } else { -3 }); @{ ok = $true } }
    type       = { param($p) Send-Text (Get-RunningMachine $p.vm) ([string]$p.text); @{ ok = $true } }
    key        = { param($p) Send-Keys (Get-RunningMachine $p.vm) ([string]$p.keys); @{ ok = $true } }
    cad        = { param($p) Invoke-Checked (Get-Device (Get-RunningMachine $p.vm) 'Msvm_Keyboard') 'TypeCtrlAltDel' @{}; @{ ok = $true } }
    login      = { param($p) Invoke-Login $p.vm }
    setup      = { param($p) Invoke-Setup $p.vm (Get-Port $p) ([string]$p.launcher) }
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
