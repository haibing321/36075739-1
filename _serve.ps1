# Local static server for the Railway Safety Assistant (zero dependency: Windows PowerShell only).
# ---------------------------------------------------------------------------
# Why it exists: opening index.html directly uses the file:// protocol, where Service Worker
#   (offline capability) is unavailable and some browser APIs are restricted. Serving over
#   http://127.0.0.1 (a "secure context" for browsers) keeps SW / offline / PWA working exactly
#   like the hosted site. Loopback only: nothing is exposed to the LAN.
# Usage (normally called by the .bat next to it):
#   powershell -NoProfile -ExecutionPolicy Bypass -File _serve.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File _serve.ps1 -Port 9000 -NoOpen
# NOTE: keep this file ASCII-only -- Windows PowerShell 5.1 reads BOM-less files as ANSI,
#   and non-ASCII bytes can corrupt parsing. User-facing prompts live in the .bat instead.
param(
  [int]$Port = 8788,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $root 'index.html'))) {
  Write-Host '  [X] index.html not found next to this script.' -ForegroundColor Red
  exit 1
}

function Start-LocalListener {
  param([int]$p)
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://127.0.0.1:$p/")
    $l.Start()
    return $l
  } catch { return $null }
}

function Open-BrowserWindow {
  param([string]$u)
  $pf = ${env:ProgramFiles}
  $pf86 = ${env:ProgramFiles(x86)}
  $cands = New-Object System.Collections.ArrayList
  if ($pf) { [void]$cands.Add((Join-Path $pf 'Microsoft\Edge\Application\msedge.exe')) }
  if ($pf86) { [void]$cands.Add((Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe')) }
  if ($pf) { [void]$cands.Add((Join-Path $pf 'Google\Chrome\Application\chrome.exe')) }
  if ($pf86) { [void]$cands.Add((Join-Path $pf86 'Google\Chrome\Application\chrome.exe')) }
  $b = $null
  foreach ($c in $cands) { if (Test-Path $c) { $b = $c; break } }
  try {
    if ($b) { Start-Process $b -ArgumentList "--app=$u" } else { Start-Process $u }
  } catch {
    try { Start-Process $u } catch { }
  }
}

function Send-File {
  param($ctx, [string]$rootDir, $mime)
  try {
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = '/' }
    if ($rel -eq '/') { $rel = '/index.html' }
    $relPath = $rel.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $full = Join-Path $rootDir $relPath
    if (Test-Path -LiteralPath $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
      else { $ctx.Response.ContentType = 'application/octet-stream' }
      $ctx.Response.Headers['Cache-Control'] = 'no-store'
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found: ' + $rel)
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch { }
  finally { try { $ctx.Response.Close() } catch { } }
}

$listener = $null
$startedPort = 0
for ($p = $Port; $p -lt ($Port + 20); $p++) {
  $listener = Start-LocalListener -p $p
  if ($listener) { $startedPort = $p; break }
}
if (-not $listener) {
  Write-Host "  [X] Ports $Port..$($Port + 19) are all in use." -ForegroundColor Red
  exit 1
}

$url = "http://127.0.0.1:$startedPort/"
Write-Host "  [OK] Server started: $url" -ForegroundColor Green
Write-Host '       (loopback only - not reachable from other devices)' -ForegroundColor DarkGray
if (-not $NoOpen) { Open-BrowserWindow -u $url }

$mime = @{}
$mime['.html'] = 'text/html; charset=utf-8'
$mime['.js'] = 'text/javascript; charset=utf-8'
$mime['.css'] = 'text/css; charset=utf-8'
$mime['.json'] = 'application/json; charset=utf-8'
$mime['.webmanifest'] = 'application/manifest+json; charset=utf-8'
$mime['.png'] = 'image/png'
$mime['.jpg'] = 'image/jpeg'
$mime['.jpeg'] = 'image/jpeg'
$mime['.gif'] = 'image/gif'
$mime['.svg'] = 'image/svg+xml'
$mime['.ico'] = 'image/x-icon'
$mime['.woff'] = 'font/woff'
$mime['.woff2'] = 'font/woff2'
$mime['.ttf'] = 'font/ttf'
$mime['.txt'] = 'text/plain; charset=utf-8'
$mime['.md'] = 'text/markdown; charset=utf-8'
$mime['.pdf'] = 'application/pdf'
$mime['.wasm'] = 'application/wasm'
$mime['.map'] = 'application/json'

Write-Host '  [..] Close this window (or Ctrl+C) to stop the server.' -ForegroundColor DarkGray
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    Send-File -ctx $ctx -rootDir $root -mime $mime
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch { }
  Write-Host '  [--] Server stopped.' -ForegroundColor DarkGray
}
