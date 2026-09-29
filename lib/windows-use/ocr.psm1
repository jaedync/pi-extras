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

# Text in a frame of little-endian RGB565 pixels, as Hyper-V sends them: lines
# of words with their boxes in frame pixels, read from the frame at $upscale times its size.
function Read-FrameText([int]$width, [int]$height, [byte[]]$data) {
    if (-not $script:engine) {
        $script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if (-not $script:engine) { throw "Windows OCR has no recognizer for this Windows user's languages; add one with OCR support under Settings > Time & language" }
    }
    # WPF scales and converts the pixels to the BGRA that OCR takes, with no per-pixel loop in script.
    $source = [System.Windows.Media.Imaging.BitmapSource]::Create($width, $height, 96, 96, [System.Windows.Media.PixelFormats]::Bgr565, $null, $data, $width * 2)
    $large = New-Object System.Windows.Media.Imaging.TransformedBitmap($source, (New-Object System.Windows.Media.ScaleTransform($upscale, $upscale)))
    $bgra = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($large, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
    $w = $bgra.PixelWidth
    $h = $bgra.PixelHeight
    $pixels = New-Object byte[] ($w * $h * 4)
    $bgra.CopyPixels($pixels, $w * 4, 0)
    $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($pixels)
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buffer, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $w, $h)
    $result = Wait-Operation ($script:engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    [ordered]@{
        width = $width
        height = $height
        lines = @(foreach ($line in $result.Lines) {
                [ordered]@{
                    words = @(foreach ($word in $line.Words) {
                            $r = $word.BoundingRect
                            [ordered]@{ text = $word.Text; x = [int][math]::Round($r.X / $upscale); y = [int][math]::Round($r.Y / $upscale); w = [int][math]::Round($r.Width / $upscale); h = [int][math]::Round($r.Height / $upscale) }
                        })
                }
            })
    }
}

Export-ModuleMember -Function Read-FrameText
