$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BuddyFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Root 'logs\focus.log'
function Write-Log([string]$m) { "$(Get-Date -Format o) $m" | Out-File -FilePath $Log -Append -Encoding utf8 }
Write-Log 'invoked'

$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq 'BUDDY' } | Select-Object -First 1
if ($proc -and $proc.MainWindowHandle -ne 0) {
  Write-Log "found pid=$($proc.Id) handle=$($proc.MainWindowHandle) iconic=$([BuddyFocus]::IsIconic($proc.MainWindowHandle))"
  if ([BuddyFocus]::IsIconic($proc.MainWindowHandle)) { [void][BuddyFocus]::ShowWindow($proc.MainWindowHandle, 9) }
  [void][BuddyFocus]::ShowWindow($proc.MainWindowHandle, 5)
  $ok = [BuddyFocus]::SetForegroundWindow($proc.MainWindowHandle)
  Write-Log "foreground=$ok iconicNow=$([BuddyFocus]::IsIconic($proc.MainWindowHandle))"
} else {
  Write-Log 'window not found; starting app'
  $null = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Join-Path $Root 'start-buddy.ps1')) `
    -WindowStyle Hidden
}
