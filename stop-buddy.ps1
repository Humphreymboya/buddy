$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProfileDir = Join-Path $Root 'chrome-profile'

Write-Host 'Buddy: shutting down...' -ForegroundColor Cyan

# 1. ask the server to exit cleanly (also grab its pid as a fallback)
$serverPid = $null
try {
  $st = Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/status' -TimeoutSec 2
  $serverPid = $st.pid
  Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/shutdown' -Method Post -TimeoutSec 2 | Out-Null
} catch {}

# 2. stop the node server if still alive
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*Buddy*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if ($serverPid) { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue }

# 3. close the HUD window only (uses its own Chrome profile)
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like "*$ProfileDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 4. stop the global hotkey watcher
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*hotkey.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host 'Buddy is offline.' -ForegroundColor Green
