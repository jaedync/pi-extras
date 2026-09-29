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

function Wait-Operation($operation, [type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    if (-not $task.Wait(30000)) { throw 'Windows OCR did not finish within 30 s' }
    $task.Result
}

# Text in a frame of little-endian RGB565 pixels, as Hyper-V sends them: lines
# of words with their boxes in frame pixels.
function Read-FrameText([int]$width, [int]$height, [byte[]]$data) {
    if (-not $script:engine) {
        $script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if (-not $script:engine) { throw "Windows OCR has no recognizer for this Windows user's languages; add one with OCR support under Settings > Time & language" }
    }
    # WPF converts the pixels to the BGRA that OCR takes, with no per-pixel loop in script.
    $source = [System.Windows.Media.Imaging.BitmapSource]::Create($width, $height, 96, 96, [System.Windows.Media.PixelFormats]::Bgr565, $null, $data, $width * 2)
    $bgra = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($source, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
    $pixels = New-Object byte[] ($width * $height * 4)
    $bgra.CopyPixels($pixels, $width * 4, 0)
    $buffer = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($pixels)
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buffer, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $width, $height)
    $result = Wait-Operation ($script:engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    [ordered]@{
        width = $width
        height = $height
        lines = @(foreach ($line in $result.Lines) {
                [ordered]@{
                    words = @(foreach ($word in $line.Words) {
                            $r = $word.BoundingRect
                            [ordered]@{ text = $word.Text; x = [int][math]::Round($r.X); y = [int][math]::Round($r.Y); w = [int][math]::Round($r.Width); h = [int][math]::Round($r.Height) }
                        })
                }
            })
    }
}

Export-ModuleMember -Function Read-FrameText
