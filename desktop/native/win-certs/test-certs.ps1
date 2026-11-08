# Test certificates for the certificate helper (CI, and the local bench):
# self-signed, in CurrentUser\My, with keys that can't be exported (as on a
# smart card). Writes what it made to a JSON file; -Remove deletes exactly
# those certificates (by thumbprint) and their keys, and the copies Windows
# puts in CurrentUser\CA, nothing else.
#
#   pwsh desktop/native/win-certs/test-certs.ps1 -Create -Out certs.json [-Only rsa]
#   pwsh desktop/native/win-certs/test-certs.ps1 -Remove -Out certs.json
param(
  [switch]$Create,
  [switch]$Remove,
  [Parameter(Mandatory)][string]$Out,
  [string[]]$Only
)
$ErrorActionPreference = 'Stop'

if ($Remove) {
  if (-not (Test-Path $Out)) { return }
  foreach ($c in (Get-Content $Out -Raw | ConvertFrom-Json)) {
    $path = "Cert:\CurrentUser\My\$($c.thumbprint)"
    if (Test-Path $path) {
      Remove-Item $path -DeleteKey -ErrorAction Continue
      Write-Host "removed $($c.label) ($($c.thumbprint))"
    }
    # New-SelfSignedCertificate also puts a copy in the intermediate
    # certificates store; remove that copy too (it has no key).
    $copy = "Cert:\CurrentUser\CA\$($c.thumbprint)"
    if (Test-Path $copy) { Remove-Item $copy -ErrorAction Continue }
  }
  Remove-Item $Out
  return
}
if (-not $Create) { throw 'Use -Create or -Remove' }

$signing = '2.5.29.37={text}1.3.6.1.5.5.7.3.4'
$specs = @(
  @{ label = 'rsa'; keyAlg = 'rsa'; curve = $null; expect = 'usable'
     args = @{ KeyAlgorithm = 'RSA'; KeyLength = 2048; Provider = 'Microsoft Software Key Storage Provider' } },
  @{ label = 'p256'; keyAlg = 'ec'; curve = 'P-256'; expect = 'usable'
     args = @{ KeyAlgorithm = 'ECDSA_nistP256'; Provider = 'Microsoft Software Key Storage Provider' } },
  @{ label = 'p384'; keyAlg = 'ec'; curve = 'P-384'; expect = 'usable'
     args = @{ KeyAlgorithm = 'ECDSA_nistP384'; Provider = 'Microsoft Software Key Storage Provider' } },
  @{ label = 'p521'; keyAlg = 'ec'; curve = 'P-521'; expect = 'usable'
     args = @{ KeyAlgorithm = 'ECDSA_nistP521'; Provider = 'Microsoft Software Key Storage Provider' } },
  # An older CryptoAPI key (as on many smart cards and tokens)
  @{ label = 'csp'; keyAlg = 'rsa'; curve = $null; expect = 'usable'
     args = @{ KeyAlgorithm = 'RSA'; KeyLength = 2048; KeySpec = 'Signature'; Provider = 'Microsoft Enhanced RSA and AES Cryptographic Provider' } },
  # Only for logging in: Acrobat hides it, so must Paperwing
  @{ label = 'login'; keyAlg = 'rsa'; curve = $null; expect = 'hidden'; eku = '2.5.29.37={text}1.3.6.1.5.5.7.3.2'
     args = @{ KeyAlgorithm = 'RSA'; KeyLength = 2048; Provider = 'Microsoft Software Key Storage Provider' } },
  # Expired: listed, but it can't sign
  @{ label = 'expired'; keyAlg = 'rsa'; curve = $null; expect = 'expired'; expired = $true
     args = @{ KeyAlgorithm = 'RSA'; KeyLength = 2048; Provider = 'Microsoft Software Key Storage Provider' } }
)
if ($Only) { $specs = $specs | Where-Object { $Only -contains $_.label } }

$made = @()
foreach ($s in $specs) {
  $a = $s.args
  $params = @{
    Subject           = "CN=Paperwing Test $($s.label.ToUpper()), O=Paperwing CI"
    CertStoreLocation = 'Cert:\CurrentUser\My'
    KeyExportPolicy   = 'NonExportable'
    KeyUsage          = 'DigitalSignature', 'NonRepudiation'
    HashAlgorithm     = 'SHA256'
    TextExtension     = @($(if ($s.eku) { $s.eku } else { $signing }))
    NotAfter          = (Get-Date).AddYears(1)
  }
  if ($s.expired) {
    $params.NotBefore = (Get-Date).AddYears(-2)
    $params.NotAfter = (Get-Date).AddDays(-1)
  }
  foreach ($k in $a.Keys) { $params[$k] = $a[$k] }
  $cert = New-SelfSignedCertificate @params
  Write-Host "made $($s.label): $($cert.Thumbprint)"
  $made += [pscustomobject]@{
    label      = $s.label
    thumbprint = $cert.Thumbprint
    id         = "cu:$($cert.Thumbprint)"
    keyAlg     = $s.keyAlg
    curve      = $s.curve
    expect     = $s.expect
    name       = "Paperwing Test $($s.label.ToUpper())"
  }
}
ConvertTo-Json -InputObject @($made) -Depth 3 | Set-Content -Encoding utf8 $Out
