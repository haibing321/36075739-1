# Integrity check for the offline package (ASCII only on purpose).
# Windows PowerShell 5.1 reads BOM-less files as ANSI, so keep this file ASCII.
# Compares every entry in SHA256SUMS.txt with the actual file hash.
# Exit codes: 0 = all good, 1 = missing/changed files, 2 = list not found.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$list = Join-Path $root 'SHA256SUMS.txt'

Write-Host ''
if (-not (Test-Path -LiteralPath $list)) {
  Write-Host '  [!] SHA256SUMS.txt not found next to this script.' -ForegroundColor Yellow
  Write-Host '      The package may be incomplete, or the list was not copied.'
  exit 2
}

$ok = 0; $changed = 0; $missing = 0
$lines = Get-Content -LiteralPath $list -Encoding UTF8
foreach ($line in $lines) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line -split '\s+', 2
  if ($parts.Count -lt 2) { continue }
  $expect = $parts[0].Trim().ToLower()
  $rel = $parts[1].Trim()
  $full = Join-Path $root ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $full)) {
    Write-Host ('  [MISSING] ' + $rel) -ForegroundColor Red
    $missing++
    continue
  }
  try {
    $actual = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLower()
  } catch {
    Write-Host ('  [UNREADABLE] ' + $rel) -ForegroundColor Red
    $missing++
    continue
  }
  if ($actual -eq $expect) {
    $ok++
  } else {
    Write-Host ('  [CHANGED] ' + $rel) -ForegroundColor Yellow
    $changed++
  }
}

Write-Host ''
Write-Host ('  Result: OK=' + $ok + '  CHANGED=' + $changed + '  MISSING=' + $missing)
Write-Host ''
if ($missing -gt 0) {
  Write-Host '  Some files are missing - most likely quarantined by a security product.' -ForegroundColor Red
  Write-Host '  Restore them from the antivirus quarantine, then add this folder to the trust list.'
} elseif ($changed -gt 0) {
  Write-Host '  Some files differ from the list. If this package was just rebuilt,' -ForegroundColor Yellow
  Write-Host '  the list may be older than the files; otherwise treat it as tampering.'
} else {
  Write-Host '  All files match the checksum list.' -ForegroundColor Green
}
Write-Host ''
if (($missing + $changed) -gt 0) { exit 1 } else { exit 0 }
