# Builds the Explorer thumbnail provider (Windows, needs Visual Studio's C++ tools).
#
#   pwsh desktop/native/win-thumbnails/build.ps1 [-Test]
#
# Output in desktop/native/win-thumbnails/out: PaperwingThumbnails.dll and the
# pdfium.dll it renders with. The desktop packaging (scripts/after-pack.cjs)
# picks them up from there. -Test also builds and runs test-thumbnail.exe.
param([switch]$Test)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$out = Join-Path $here 'out'
$obj = Join-Path $here 'obj'
New-Item -ItemType Directory -Force $out, $obj | Out-Null

# PDFium from https://github.com/bblanchon/pdfium-binaries, pinned by checksum
$pdfiumRelease = 'chromium/8057'
$pdfiumSha256 = 'e307d519e42f2e69b1b531f0c2a32dffcdf3891ec0eba60328ba51a57cec01ed'
$pdfiumDll = Join-Path $out 'pdfium.dll'
if (-not (Test-Path $pdfiumDll)) {
  $tgz = Join-Path $obj 'pdfium-win-x64.tgz'
  Invoke-WebRequest "https://github.com/bblanchon/pdfium-binaries/releases/download/$pdfiumRelease/pdfium-win-x64.tgz" -OutFile $tgz
  $hash = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToLower()
  if ($hash -ne $pdfiumSha256) { throw "pdfium checksum mismatch: $hash" }
  tar -xzf $tgz -C $obj
  Copy-Item (Join-Path $obj 'bin/pdfium.dll') $pdfiumDll
  Copy-Item (Join-Path $obj 'LICENSE') (Join-Path $out 'pdfium-LICENSE.txt') -ErrorAction SilentlyContinue
}

# Visual Studio's x64 build environment
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ build tools not found' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'

# Load the compiler environment into this session
cmd /c "`"$vcvars`" && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) }
}
if (-not (Get-Command cl -ErrorAction SilentlyContinue)) { throw 'cl.exe not available after vcvars64' }

function Invoke-Cl([string[]]$arguments) {
  & cl @arguments
  if ($LASTEXITCODE) { throw "cl failed: $arguments" }
}

$common = @('/nologo', '/O2', '/W4', '/EHsc', '/permissive-', '/std:c++17', '/DUNICODE', '/D_UNICODE', '/DWIN32_LEAN_AND_MEAN')
Push-Location $obj
try {
  Invoke-Cl ($common + @('/DNOMINMAX', '/LD', "$here\PaperwingThumbnails.cpp", "/Fe:$out\PaperwingThumbnails.dll",
      '/link', "/DEF:$here\PaperwingThumbnails.def", 'ole32.lib', 'shlwapi.lib', 'gdi32.lib'))
  if ($Test) {
    Invoke-Cl ($common + @("$here\test-thumbnail.cpp", "/Fe:$obj\test-thumbnail.exe", '/link', 'ole32.lib', 'shlwapi.lib', 'gdi32.lib'))
  }
} finally {
  Pop-Location
}
Remove-Item (Join-Path $out '*.exp'), (Join-Path $out '*.lib') -ErrorAction SilentlyContinue

if ($Test) {
  $fixtures = Resolve-Path (Join-Path $here '..\..\..\src\tests\fixtures')
  & (Join-Path $obj 'test-thumbnail.exe') (Join-Path $out 'PaperwingThumbnails.dll') `
    (Join-Path $fixtures 'sample.pdf') (Join-Path $fixtures 'protected.pdf') (Join-Path $obj 'thumbnail.bmp')
  if ($LASTEXITCODE) { throw 'thumbnail test failed' }
}
Write-Host "Built $out\PaperwingThumbnails.dll"
