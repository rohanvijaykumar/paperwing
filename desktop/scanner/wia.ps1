# Paperwing's scanner helper for Windows (see desktop/scan.cjs): WIA, Windows'
# own scanner API, through its COM automation layer (wiaaut.dll, part of
# Windows). One JSON object per line on stdout.
#
#   wia.ps1 list
#   wia.ps1 caps -DeviceId <id>
#   wia.ps1 scan -DeviceId <id> -OutDir <folder> -Options <base64 JSON>
#
# WIA 2.0 drivers (most scanners since Windows 7) show the flatbed and the
# document feeder as separate items; older (WIA 1) drivers have one item and
# choose the feeder with a device setting. Both are handled.
param(
  [Parameter(Position = 0)][string]$Command,
  [string]$DeviceId,
  [string]$OutDir,
  [string]$Options
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

# WIA property IDs
$DOCUMENT_HANDLING_CAPABILITIES = 3086
$DOCUMENT_HANDLING_SELECT = 3088
$PAGES = 3096
$HORIZONTAL_BED_SIZE = 3074
$VERTICAL_BED_SIZE = 3075
$HORIZONTAL_SHEET_FEED_SIZE = 3076
$VERTICAL_SHEET_FEED_SIZE = 3077
$ITEM_CATEGORY = 4125
$CUR_INTENT = 6146
$XRES = 6147
$YRES = 6148
$XPOS = 6149
$YPOS = 6150
$XEXTENT = 6151
$YEXTENT = 6152
$MAX_HORIZONTAL_SIZE = 6165
$MAX_VERTICAL_SIZE = 6166

# Document handling flags
$FEEDER = 1
$FLATBED = 2
$DUPLEX = 4

# Item categories (WIA 2.0)
$CATEGORY_FLATBED = '{FB607B1F-43F3-488B-855B-FB703EC342A6}'
$CATEGORY_FEEDER = '{FE131934-F84C-42AD-8DA4-6129CDDD7288}'

# Intents: color, grayscale, text (black and white)
$INTENT = @{ color = 1; gray = 2; bw = 4 }

$FORMAT_BMP = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'
$FORMAT_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'

# WIA errors, as Paperwing names them
$ERRORS = @{
  # (hex literals this size are signed 32-bit numbers in PowerShell)
  0x80210002 = 'paper-jam'
  0x80210003 = 'feeder-empty'
  0x80210005 = 'offline'
  0x80210006 = 'busy'
  0x80210007 = 'warming-up'
  0x8021000A = 'offline'
  0x80210015 = 'no-scanner'
  0x80210016 = 'cover-open'
}

function ErrorCode($err) {
  $e = $err.Exception
  while ($e) {
    # (HResult and the keys above are both signed 32-bit numbers)
    $h = [int]$e.HResult
    if ($ERRORS.ContainsKey($h)) { return $ERRORS[$h] }
    $e = $e.InnerException
  }
  return 'failed'
}

function Prop($props, [int]$id) {
  try { return $props.Item([string]$id) } catch { return $null }
}

function SetProp($props, [int]$id, $value) {
  $p = Prop $props $id
  if ($p) { try { $p.Value = $value } catch { } }
}

# The values a property may take: its list, or every step of its range
function Values($p) {
  if (-not $p) { return @() }
  try {
    if ($p.SubType -eq 2) { return @($p.SubTypeValues | ForEach-Object { [int]$_ }) }
    if ($p.SubType -eq 1) {
      $step = [Math]::Max([int]$p.SubTypeStep, 1)
      $out = @()
      foreach ($d in 75, 100, 150, 200, 240, 300, 400, 600, 1200) {
        if ($d -ge $p.SubTypeMin -and $d -le $p.SubTypeMax -and (($d - $p.SubTypeMin) % $step) -eq 0) { $out += $d }
      }
      return $out
    }
  } catch { }
  try { return @([int]$p.Value) } catch { return @() }
}

function Connect([string]$id) {
  $dm = New-Object -ComObject WIA.DeviceManager
  foreach ($info in $dm.DeviceInfos) {
    if ($info.DeviceID -eq $id) { return $info.Connect() }
  }
  throw [Runtime.InteropServices.COMException]::new('Scanner not found', [int]0x80210015)
}

# The flatbed and feeder items of a device: @{ flatbed = item; feeder = item }
# (WIA 1: the same single item for both, chosen with DOCUMENT_HANDLING_SELECT)
function SourceItems($device) {
  $found = @{}
  foreach ($item in $device.Items) {
    $cat = Prop $item.Properties $ITEM_CATEGORY
    $g = if ($cat) { "$($cat.Value)".ToUpper() } else { '' }
    if ($g -eq $CATEGORY_FLATBED) { $found.flatbed = $item }
    elseif ($g -eq $CATEGORY_FEEDER) { $found.feeder = $item }
  }
  if ($found.Count) { $found.wia2 = $true; return $found }
  # WIA 1
  $item = $device.Items.Item(1)
  $capsProp = Prop $device.Properties $DOCUMENT_HANDLING_CAPABILITIES
  $caps = if ($capsProp) { [int]$capsProp.Value } else { $FLATBED }
  if (($caps -band $FLATBED) -or -not ($caps -band $FEEDER)) { $found.flatbed = $item }
  if (($caps -band $FEEDER) -ne 0) { $found.feeder = $item }
  $found.wia2 = $false
  $found.wia1Caps = $caps
  return $found
}

function Inches($props, [int]$id, [double]$fallback) {
  $p = Prop $props $id
  if ($p -and [double]$p.Value -gt 0) { return [Math]::Round([double]$p.Value / 1000, 2) }
  return $fallback
}

function Describe($device, $items, [string]$source) {
  $item = $items[$source]
  $colors = @()
  $intent = Prop $item.Properties $CUR_INTENT
  $flags = 0
  if ($intent) {
    try { foreach ($v in $intent.SubTypeValues) { $flags = $flags -bor [int]$v } } catch { }
    if (-not $flags) { try { $flags = [int]$intent.SubTypeMax } catch { } }
  }
  if (-not $flags) { $flags = 7 }
  foreach ($c in 'color', 'gray', 'bw') { if ($flags -band $INTENT[$c]) { $colors += $c } }
  $duplex = $false
  if ($source -eq 'feeder') {
    $capsProp = if ($items.wia2) { Prop $item.Properties $DOCUMENT_HANDLING_CAPABILITIES } else { Prop $device.Properties $DOCUMENT_HANDLING_CAPABILITIES }
    if ($capsProp) { $duplex = ([int]$capsProp.Value -band $DUPLEX) -ne 0 }
  }
  if ($items.wia2) {
    $w = Inches $item.Properties $MAX_HORIZONTAL_SIZE 8.5
    $h = Inches $item.Properties $MAX_VERTICAL_SIZE 11.7
  } elseif ($source -eq 'feeder') {
    $w = Inches $device.Properties $HORIZONTAL_SHEET_FEED_SIZE 8.5
    $h = Inches $device.Properties $VERTICAL_SHEET_FEED_SIZE 14
  } else {
    $w = Inches $device.Properties $HORIZONTAL_BED_SIZE 8.5
    $h = Inches $device.Properties $VERTICAL_BED_SIZE 11.7
  }
  return @{
    id = $source
    duplex = $duplex
    resolutions = @(Values (Prop $item.Properties $XRES))
    colors = $colors
    width = $w
    height = $h
  }
}

function Save($image, [string]$file) {
  # Lossless PNG, whatever the scanner sent
  if ("$($image.FormatID)".ToUpper() -ne $FORMAT_PNG) {
    $ip = New-Object -ComObject WIA.ImageProcess
    $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
    $ip.Filters.Item(1).Properties.Item('FormatID').Value = $FORMAT_PNG
    $image = $ip.Apply($image)
  }
  if (Test-Path $file) { Remove-Item $file -Force }
  $image.SaveFile($file)
}

try {
  switch ($Command) {
    'list' {
      $dm = New-Object -ComObject WIA.DeviceManager
      $scanners = @()
      foreach ($info in $dm.DeviceInfos) {
        if ($info.Type -ne 1) { continue } # ScannerDeviceType
        $name = try { "$($info.Properties.Item('Name').Value)" } catch { $info.DeviceID }
        $scanners += @{ id = $info.DeviceID; name = $name }
      }
      Emit @{ type = 'scanners'; scanners = @($scanners) }
    }
    'caps' {
      $device = Connect $DeviceId
      $items = SourceItems $device
      $sources = @()
      foreach ($s in 'flatbed', 'feeder') {
        if ($items[$s]) { $sources += (Describe $device $items $s) }
      }
      Emit @{ type = 'caps'; sources = @($sources) }
    }
    'scan' {
      $o = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Options)) | ConvertFrom-Json
      $device = Connect $DeviceId
      $items = SourceItems $device
      $item = $items[$o.source]
      if (-not $item) { throw [Runtime.InteropServices.COMException]::new('No such source', [int]0x80210015) }

      # Flatbed or feeder (one or both sides)
      $handling = if ($o.source -eq 'feeder') { $FEEDER } else { $FLATBED }
      if ($o.duplex) { $handling = $handling -bor $DUPLEX }
      if ($items.wia2) {
        if ($o.source -eq 'feeder') { SetProp $item.Properties $DOCUMENT_HANDLING_SELECT $handling }
      } else {
        SetProp $device.Properties $DOCUMENT_HANDLING_SELECT $handling
        SetProp $device.Properties $PAGES ($(if ($o.source -eq 'feeder') { 0 } else { 1 }))
      }
      if ($items.wia2 -and $o.source -eq 'feeder') { SetProp $item.Properties $PAGES 0 }

      # Color mode, then resolution, then the area (its range follows the resolution)
      SetProp $item.Properties $CUR_INTENT $INTENT[[string]$o.color]
      SetProp $item.Properties $XRES ([int]$o.dpi)
      SetProp $item.Properties $YRES ([int]$o.dpi)
      SetProp $item.Properties $XPOS 0
      SetProp $item.Properties $YPOS 0
      $xp = Prop $item.Properties $XEXTENT
      $yp = Prop $item.Properties $YEXTENT
      $w = [int][Math]::Round([double]$o.width * [int]$o.dpi)
      $h = [int][Math]::Round([double]$o.height * [int]$o.dpi)
      if ($xp) { try { $w = [Math]::Min($w, [int]$xp.SubTypeMax) } catch { }; SetProp $item.Properties $XEXTENT $w }
      if ($yp) { try { $h = [Math]::Min($h, [int]$yp.SubTypeMax) } catch { }; SetProp $item.Properties $YEXTENT $h }

      $n = 0
      while ($true) {
        try {
          $image = $item.Transfer($FORMAT_BMP)
        } catch {
          $code = ErrorCode $_
          # A feeder scan ends when the feeder is empty
          if ($code -eq 'feeder-empty' -and $n -gt 0) { break }
          Emit @{ type = 'error'; code = $code; message = "$($_.Exception.Message)" }
          exit 2
        }
        $n++
        $file = Join-Path $OutDir ("page-{0}.png" -f $n)
        Save $image $file
        Emit @{ type = 'page'; file = $file; dpi = [int]$o.dpi }
        # The flatbed scans one page a pass
        if ($o.source -ne 'feeder') { break }
      }
      Emit @{ type = 'done'; pages = $n }
    }
    default {
      Emit @{ type = 'error'; code = 'failed'; message = "Unknown command: $Command" }
      exit 1
    }
  }
} catch {
  Emit @{ type = 'error'; code = (ErrorCode $_); message = "$($_.Exception.Message)" }
  exit 2
}
