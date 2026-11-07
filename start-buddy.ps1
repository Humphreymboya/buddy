$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 7777
$Url = "http://127.0.0.1:$Port"
$Logs = Join-Path $Root 'logs'
$ProfileDir = Join-Path $Root 'chrome-profile'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Test-Buddy {
  try {
    $r = Invoke-RestMethod -Uri "$Url/api/status" -TimeoutSec 1
    return [bool]$r.ok
  } catch { return $false }
}

# ---------- bring an existing window forward ----------
function Focus-Buddy {
  if (-not ('BuddyWin' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BuddyWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
  }
  $proc = Get-Process | Where-Object { $_.MainWindowTitle -eq 'BUDDY' } | Select-Object -First 1
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    if ([BuddyWin]::IsIconic($proc.MainWindowHandle)) { [void][BuddyWin]::ShowWindow($proc.MainWindowHandle, 9) }
    [void][BuddyWin]::SetForegroundWindow($proc.MainWindowHandle)
    return $true
  }
  return $false
}

# ---------- 1. server ----------
if (-not (Test-Buddy)) {
  Start-Process -FilePath 'node' -ArgumentList @((Join-Path $Root 'server.js')) -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Logs 'server.out.log') `
    -RedirectStandardError (Join-Path $Logs 'server.err.log')
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Buddy) { break }
  }
}
if (-not (Test-Buddy)) {
  Write-Host 'Buddy: server failed to start. See logs\server.err.log' -ForegroundColor Red
  exit 1
}

# ---------- 2. wake-word / hotkey watcher ----------
$hk = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object { $_.CommandLine -like '*hotkey.ps1*' }
if (-not $hk) {
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Join-Path $Root 'hotkey.ps1')) `
    -WindowStyle Hidden
}

# ---------- 3. HUD window ----------
$already = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
           Where-Object { $_.CommandLine -like "*$ProfileDir*" }
if ($already -and (Focus-Buddy)) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = [Math]::Min(1120, $wa.Width - 60)
$h = [Math]::Min(760, $wa.Height - 60)
$x = $wa.X + [int](($wa.Width - $w) / 2)
$y = $wa.Y + [int](($wa.Height - $h) / 2)

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $chrome)) {
  Start-Process $Url
  exit 0
}

$args = @(
  "--app=$Url/",
  "--window-size=$w,$h",
  "--window-position=$x,$y",
  "--user-data-dir=$ProfileDir",
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble'
)
Start-Process -FilePath $chrome -ArgumentList $args
