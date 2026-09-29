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
    $large = New-Object System.Windows.Media.Imaging.TransformedBitmap($tile, (New-Object System.Windows.Media.ScaleTransform($upscale, $upscale)))
    $bgra = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($large, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
    $width = $bgra.PixelWidth
    $height = $bgra.PixelHeight
    $pixels = New-Object byte[] ($width * $height * 4)
    $bgra.CopyPixels($pixels, $width * 4, 0)
    $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($pixels)
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buffer, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $width, $height)
    Wait-Operation ($script:engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
}

# Text in a frame of little-endian RGB565 pixels, as Hyper-V sends them: lines
# of words with their boxes in frame pixels, read a quarter of the frame at a
# time, each word from the quarter its center is in.
function Read-FrameText([int]$width, [int]$height, [byte[]]$data) {
    if (-not $script:engine) {
        $script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if (-not $script:engine) { throw "Windows OCR has no recognizer for this Windows user's languages; add one with OCR support under Settings > Time & language" }
    }
    $source = [System.Windows.Media.Imaging.BitmapSource]::Create($width, $height, 96, 96, [System.Windows.Media.PixelFormats]::Bgr565, $null, $data, $width * 2)
    $midX = [int]($width / 2)
    $midY = [int]($height / 2)
    $spanX = $midX + [int]($width * $seam)
    $spanY = $midY + [int]($height * $seam)
    $lines = @(foreach ($right in $false, $true) {
        foreach ($lower in $false, $true) {
            $x = if ($right) { $width - $spanX } else { 0 }
            $y = if ($lower) { $height - $spanY } else { 0 }
            foreach ($line in (Read-Tile $source $x $y $spanX $spanY).Lines) {
                $words = @(foreach ($word in $line.Words) {
                        $r = $word.BoundingRect
                        $left = $x + $r.X / $upscale
                        $top = $y + $r.Y / $upscale
                        $cx = $left + $r.Width / $upscale / 2
                        $cy = $top + $r.Height / $upscale / 2
                        if (($cx -ge $midX) -eq $right -and ($cy -ge $midY) -eq $lower) {
                            [ordered]@{ text = $word.Text; x = [int][math]::Round($left); y = [int][math]::Round($top); w = [int][math]::Round($r.Width / $upscale); h = [int][math]::Round($r.Height / $upscale) }
                        }
                    })
                if ($words.Count -gt 0) { [ordered]@{ words = $words } }
            }
        }
    })
    [ordered]@{ width = $width; height = $height; lines = $lines }
}

Export-ModuleMember -Function Read-FrameText
