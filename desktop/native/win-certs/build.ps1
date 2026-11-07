# Builds paperwing-certs.exe, Paperwing's certificate helper for Windows
# (signing with certificates in the Windows store, smart cards and tokens).
# Needs the .NET SDK (any recent version); the result runs on .NET Framework
# 4.8, which Windows 10 and 11 include.
#
#   pwsh desktop/native/win-certs/build.ps1 [-Test]
#
# Output: desktop/native/win-certs/out/paperwing-certs.exe. The packaging
# (scripts/after-pack.cjs) puts it in the app's resources/certs. -Test also
# runs the unit tests and checks that `list` runs and prints a certs line.
param([switch]$Test)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force $out | Out-Null

function Invoke-Dotnet([string[]]$arguments) {
  & dotnet @arguments
  if ($LASTEXITCODE) { throw "dotnet failed: $arguments" }
}

Invoke-Dotnet @('build', (Join-Path $here 'PaperwingCerts.csproj'), '-c', 'Release', '-nologo', '-v', 'q', '-o', $out)
Remove-Item (Join-Path $out '*.pdb'), (Join-Path $out '*.config') -ErrorAction SilentlyContinue

if ($Test) {
  $testOut = Join-Path $here 'tests/bin'
  Invoke-Dotnet @('build', (Join-Path $here 'tests/PaperwingCertsTests.csproj'), '-c', 'Release', '-nologo', '-v', 'q', '-o', $testOut)
  & (Join-Path $testOut 'paperwing-certs-tests.exe')
  if ($LASTEXITCODE) { throw 'unit tests failed' }

  $listed = & (Join-Path $out 'paperwing-certs.exe') list
  if ($LASTEXITCODE) { throw "list failed: $listed" }
  if ($listed -notmatch '^\{"type":"certs","certs":\[') { throw "list printed no certs line: $listed" }
  $err = & (Join-Path $out 'paperwing-certs.exe') sign -Id 'cu:0000000000000000000000000000000000000000' -Hash 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' -Alg sha256
  if ($LASTEXITCODE -ne 2 -or $err -notmatch '"code":"key-unusable"') { throw "an unknown certificate wasn't reported: $err" }
  Write-Host 'certificate helper ok'
}
exit 0
