<#
  Windows OCR on a Hyper-V console frame, for screens UI Automation can't
  describe. host.ps1 imports it on the first request, so the host starts
  without loading WPF and WinRT.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]

# PowerShell can't await WinRT operations; AsTask turns one into a .NET task to wait on.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$engine = $null
# UI text is 11 or 12 pixels tall at 96 DPI, too small for Windows OCR to read
# reliably: an Event Viewer list at 1x got no time right ("1237:02"), at 2x all.
# A fractional scale blurs the glyphs and reads worse than either.
$upscale = 2

function Wait-Operation($operation, [type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    if (-not $task.Wait(30000)) { throw 'Windows OCR did not finish within 30 s' }
    $task.Result
}

# Windows OCR reads less of a busy picture: over a photo wallpaper it read none of a
# Run box from the whole frame, and all of it from a quarter. The quarters overlap
# by this share of the frame on each side of its middle, so a word cut by one
# quarter's edge is whole in the next.
$seam = 0.1

# The text Windows OCR reads in one rectangle of the frame, scaled up by $upscale.
function Read-Tile($source, [int]$x, [int]$y, [int]$w, [int]$h) {
    # WPF crops, scales and converts the pixels to the BGRA that OCR takes, with no per-pixel loop in script.
    $tile = New-Object System.Windows.Media.Imaging.CroppedBitmap($source, (New-Object System.Windows.Int32Rect($x, $y, $w, $h)))
    $scale = [math]::Min($upscale, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [math]::Max($w, $h))
    $large = New-Object System.Windows.Media.Imaging.TransformedBitmap($tile, (New-Object System.Windows.Media.ScaleTransform($scale, $scale)))
    $bgra = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($large, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
    $width = $bgra.PixelWidth
    $height = $bgra.PixelHeight
    $pixels = New-Object byte[] ($width * $height * 4)
    $bgra.CopyPixels($pixels, $width * 4, 0)
    $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($pixels)
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buffer, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $width, $height)
    try {
        @{ result = (Wait-Operation ($script:engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])); scale = $scale; width = $width; height = $height }
    } finally { $bitmap.Dispose() }
}

# OCR deskews around the image center. Its boxes need the reported clockwise
# rotation to return to the original image (OcrResult.TextAngle contract).
function Get-OcrBox($rect, [double]$angle, [double]$width, [double]$height) {
    $radians = $angle * [math]::PI / 180
    $cos = [math]::Cos($radians)
    $sin = [math]::Sin($radians)
    $dx = $rect.X + $rect.Width / 2 - $width / 2
    $dy = $rect.Y + $rect.Height / 2 - $height / 2
    $cx = $width / 2 + $dx * $cos - $dy * $sin
    $cy = $height / 2 + $dx * $sin + $dy * $cos
    $w = [math]::Abs($rect.Width * $cos) + [math]::Abs($rect.Height * $sin)
    $h = [math]::Abs($rect.Width * $sin) + [math]::Abs($rect.Height * $cos)
    @{ x = $cx - $w / 2; y = $cy - $h / 2; w = $w; h = $h }
}

# Bound pixel allocation as well as compressed input size.
function Assert-ImageSize([long]$width, [long]$height) {
    if ($width -lt 2 -or $height -lt 2 -or $width -gt 8192 -or $height -gt 8192 -or $width * $height -gt 33554432) { throw 'Screenshot dimensions exceed the supported bounds' }
}

# Both RGB565 console frames and guest PNGs use the same quarter-tile OCR.
function Read-SourceText($source) {
    $width = $source.PixelWidth
    $height = $source.PixelHeight
    Assert-ImageSize $width $height
    if (-not $script:engine) {
        $script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if (-not $script:engine) { throw "Windows OCR has no recognizer for this Windows user's languages; add one with OCR support under Settings > Time & language" }
    }
    $midX = [int]($width / 2)
    $midY = [int]($height / 2)
    $spanX = $midX + [int]($width * $seam)
    $spanY = $midY + [int]($height * $seam)
    $lines = @(foreach ($right in $false, $true) {
        foreach ($lower in $false, $true) {
            $x = if ($right) { $width - $spanX } else { 0 }
            $y = if ($lower) { $height - $spanY } else { 0 }
            $tile = Read-Tile $source $x $y $spanX $spanY
            $scale = $tile.scale
            foreach ($line in $tile.result.Lines) {
                $words = @(foreach ($word in $line.Words) {
                        $r = Get-OcrBox $word.BoundingRect ([double]$tile.result.TextAngle) $tile.width $tile.height
                        $left = $x + $r.x / $scale
                        $top = $y + $r.y / $scale
                        $cx = $left + $r.w / $scale / 2
                        $cy = $top + $r.h / $scale / 2
                        if (($cx -ge $midX) -eq $right -and ($cy -ge $midY) -eq $lower) {
                            [ordered]@{ text = $word.Text; x = [int][math]::Round($left); y = [int][math]::Round($top); w = [int][math]::Round($r.w / $scale); h = [int][math]::Round($r.h / $scale) }
                        }
                    })
                if ($words.Count -gt 0) { [ordered]@{ words = $words } }
            }
        }
    })
    [ordered]@{ width = $width; height = $height; lines = $lines }
}

function Read-FrameText([int]$width, [int]$height, [byte[]]$data) {
    $source = [System.Windows.Media.Imaging.BitmapSource]::Create($width, $height, 96, 96, [System.Windows.Media.PixelFormats]::Bgr565, $null, $data, $width * 2)
    Read-SourceText $source
}

# Bytes arrive over the existing stdio channel, never through a temporary image file.
function Read-ImageText($png) {
    if (-not $png -or $png.Count -lt 33 -or $png.Count -gt 16777216) { throw 'PNG screenshot is missing or exceeds 16 MiB' }
    $data = [byte[]]$png
    if (($data[0..15] -join ',') -ne '137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82') { throw 'Invalid PNG screenshot header' }
    $width = [BitConverter]::ToUInt32([byte[]]@($data[19], $data[18], $data[17], $data[16]), 0)
    $height = [BitConverter]::ToUInt32([byte[]]@($data[23], $data[22], $data[21], $data[20]), 0)
    Assert-ImageSize $width $height
    $stream = New-Object IO.MemoryStream(,$data)
    try {
        $decoder = [System.Windows.Media.Imaging.PngBitmapDecoder]::new($stream, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
        Read-SourceText $decoder.Frames[0]
    } finally { $stream.Dispose() }
}

Export-ModuleMember -Function Read-FrameText, Read-ImageText
