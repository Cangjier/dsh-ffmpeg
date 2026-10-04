using namespace Windows.Media.Ocr
using namespace Windows.Globalization
using namespace Windows.Graphics.Imaging

# Read the text off one image with the OCR engine Windows already ships, and print it as JSON.
#
# This exists so that `dsh-ffmpeg` can label the frames it extracts without depending on another
# plugin or on a 73 MB download. The offline engine in the sibling `dsh-ocr` plugin is better —
# it reads small mixed-script text far more accurately — and it is used first when it is there.
# This is the floor, not the ceiling.
#
# Windows' recogniser is only reachable through WinRT, which PowerShell 5.1 cannot await directly.
# Three details in here are load-bearing and were learned by breaking them:
#
#   1. WinRT types must be written as bracketed literals carrying the ContentType marker
#      ([Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]). A runtime
#      lookup through [Type]::GetType returns a CLR shadow type, and an instance made from it is
#      rejected by the engine with "cannot convert Windows.Globalization.Language to
#      Windows.Globalization.Language".
#   2. A line's bounding box is the union of its words. The recogniser splits CJK text into one
#      word per glyph, so the first word's rectangle is a single character wide.
#   3. stdout must be forced to UTF-8. PowerShell 5.1 writes the console code page, and Chinese
#      reaches a Node parent as mojibake: correct text that no lookup can match.
#
# Usage:
#   winrt-ocr.ps1 -Path frame.png [-Language zh-Hans-CN] [-Scale 2]
#
# Output: {"language":"…","lineCount":N,"elapsedMs":N,"lines":[{"text":"…","x":0,"y":0,"width":0,"height":0}]}

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Language = 'zh-Hans-CN',
  [int]$Scale = 1
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not (Test-Path $Path)) { throw "no such image: $Path" }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

# Upscaling helps the recogniser on small UI text, and coordinates are mapped back to the original
# image's space so they can still be compared against the frame they came from.
$source = [System.Drawing.Image]::FromFile((Resolve-Path $Path).Path)
try {
  if ($Scale -gt 1) {
    $scaled = New-Object System.Drawing.Bitmap([int]($source.Width * $Scale), [int]($source.Height * $Scale))
    $graphics = [System.Drawing.Graphics]::FromImage($scaled)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($source, 0, 0, $scaled.Width, $scaled.Height)
    $graphics.Dispose()
    $source.Dispose()
    $source = $scaled
  }
  $stream = New-Object System.IO.MemoryStream
  $source.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $stream.Position = 0
} finally {
  if ($source) { $source.Dispose() }
}

$decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
$engineType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$resultType = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]

$randomAccess = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)
$decoder = Await ($decoderType::CreateAsync($randomAccess)) $decoderType
$softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) $bitmapType

$languageType = 'Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime'
$engine = $engineType::TryCreateFromLanguage((New-Object $languageType -ArgumentList $Language))
if ($null -eq $engine) { $engine = $engineType::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw "no OCR recognizer is available for language $Language" }

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$result = Await ($engine.RecognizeAsync($softwareBitmap)) $resultType
$watch.Stop()
$stream.Dispose()

$factor = if ($Scale -gt 1) { $Scale } else { 1 }
$lines = @()

foreach ($line in $result.Lines) {
  $words = @($line.Words)
  if ($words.Count -eq 0) { continue }

  $minX = [double]::MaxValue
  $minY = [double]::MaxValue
  $maxX = [double]::MinValue
  $maxY = [double]::MinValue
  foreach ($word in $words) {
    $rect = $word.BoundingRect
    $wx = [double](@($rect.X)[0])
    $wy = [double](@($rect.Y)[0])
    $ww = [double](@($rect.Width)[0])
    $wh = [double](@($rect.Height)[0])
    if ($wx -lt $minX) { $minX = $wx }
    if ($wy -lt $minY) { $minY = $wy }
    if (($wx + $ww) -gt $maxX) { $maxX = $wx + $ww }
    if (($wy + $wh) -gt $maxY) { $maxY = $wy + $wh }
  }

  $lines += [ordered]@{
    text   = $line.Text
    x      = [int]($minX / $factor)
    y      = [int]($minY / $factor)
    width  = [int](($maxX - $minX) / $factor)
    height = [int](($maxY - $minY) / $factor)
  }
}

Write-Output (([ordered]@{
  language  = $engine.RecognizerLanguage.LanguageTag
  lineCount = $lines.Count
  elapsedMs = [int]$watch.ElapsedMilliseconds
  lines     = $lines
} | ConvertTo-Json -Depth 5 -Compress))
