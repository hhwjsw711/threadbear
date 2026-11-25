# Converts one picture with Windows' own imaging (WIC, through WPF), for
# src/images.ts on Windows, where there's no sips or ImageMagick. Run as a
# short-lived hidden powershell.exe; images.ts puts the line `$p = '...'`
# in front: base64 of the source, the output, png or jpeg, the JPEG quality
# the longest output side in pixels (0: as it is), and optional source-side
# and source-pixel limits (0: none), joined by NULs.
# Only Windows' own assemblies, by full name, and no modules: with module
# loading off, nothing from a folder a thread can write is loaded by name
# (as win32-helper.ps1). images.ts only hands it a file whose first bytes
# say it's a picture.
# A phone photo's turn-me tag is applied, as sips does; the decoder is
# picked by Windows from the bytes, and none of WIC's runs anything.
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)).Split([char]0)
$src = $a[0]; $out = $a[1]; $format = $a[2]; $quality = [int]$a[3]; $maxPx = [int]$a[4]
$limitSide = if ($a.Length -gt 5) { [int]$a[5] } else { 0 }
$limitPixels = if ($a.Length -gt 6) { [long]$a[6] } else { 0 }
foreach ($n in 'WindowsBase', 'PresentationCore') { [void][Reflection.Assembly]::Load("$n, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35") }
$in = [IO.File]::OpenRead($src)
try {
  # Metadata first; OnLoad decoded pixels before the dimensions were checked.
  # OnDemand keeps the input open through encoding, so the guarded frame is
  # the one used below, not a reopened path.
  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($in, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnDemand)
  if ($limitSide -gt 0 -or $limitPixels -gt 0) {
    if ($dec.Frames.Count -gt 32) { throw 'Tool image has too many frames to convert' }
    [long]$pixels = 0
    foreach ($f in $dec.Frames) {
      $w = $f.PixelWidth; $h = $f.PixelHeight
      if ($w -le 0 -or $h -le 0 -or ($limitSide -gt 0 -and ($w -gt $limitSide -or $h -gt $limitSide))) { throw 'Tool image has too many pixels to convert' }
      $pixels += ([long]$w * [long]$h)
      if ($limitPixels -gt 0 -and $pixels -gt $limitPixels) { throw 'Tool image has too many pixels to convert' }
    }
  }
$frame = $dec.Frames[0]
$bmp = [System.Windows.Media.Imaging.BitmapSource]$frame
$o = 1
try { $q = $frame.Metadata.GetQuery('System.Photo.Orientation'); if ($q) { $o = [int]$q } } catch { }
$turn = switch ($o) { 3 { 180 } 6 { 90 } 8 { 270 } default { 0 } }
if ($turn) { $bmp = [System.Windows.Media.Imaging.TransformedBitmap]::new($bmp, ([System.Windows.Media.RotateTransform]::new($turn))) }
if ($maxPx -gt 0) {
  $longer = [Math]::Max($bmp.PixelWidth, $bmp.PixelHeight)
  if ($longer -gt $maxPx) { $s = $maxPx / $longer; $bmp = [System.Windows.Media.Imaging.TransformedBitmap]::new($bmp, ([System.Windows.Media.ScaleTransform]::new($s, $s))) }
}
if ($format -eq 'jpeg') {
  $bmp = [System.Windows.Media.Imaging.FormatConvertedBitmap]::new($bmp, [System.Windows.Media.PixelFormats]::Bgr24, $null, 0)
  $enc = [System.Windows.Media.Imaging.JpegBitmapEncoder]::new()
  if ($quality -gt 0) { $enc.QualityLevel = $quality }
} else { $enc = [System.Windows.Media.Imaging.PngBitmapEncoder]::new() }
$enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bmp))
$w = [IO.File]::Create($out)
try { $enc.Save($w) } finally { $w.Close() }
} finally { $in.Close() }
