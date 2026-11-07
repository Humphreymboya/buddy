[CmdletBinding()]
param(
  [switch]$NoAutostart,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vbs  = Join-Path $Root 'start-buddy.vbs'

Write-Host ''
Write-Host '  B U D D Y   //   installer' -ForegroundColor Cyan
Write-Host '  -------------------------' -ForegroundColor DarkCyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  ERROR: Node.js is required and was not found on PATH.' -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data')  | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs')  | Out-Null

$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell

function New-BuddyShortcut([string]$Path) {
  $sc = $shell.CreateShortcut($Path)
  $sc.TargetPath       = $wscript
  $sc.Arguments        = '"' + $Vbs + '"'
  $sc.WorkingDirectory = $Root
  $sc.IconLocation     = (Join-Path $Root 'public\favicon.ico') + ',0'
  $sc.Description      = 'Buddy - JARVIS-style voice assistant'
  $sc.Save()
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Buddy.lnk'
New-BuddyShortcut $lnk
Write-Host "  [ok] Desktop shortcut: $lnk" -ForegroundColor Green

if (-not $NoAutostart) {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk2 = Join-Path $startup 'Buddy.lnk'
  New-BuddyShortcut $lnk2
  Write-Host "  [ok] Starts automatically at sign-in" -ForegroundColor Green
} else {
  Write-Host '  [--] Autostart skipped (-NoAutostart)' -ForegroundColor DarkGray
}

# Also register the custom agent prompt if the config folder was reset.
$agentDir = Join-Path $env:USERPROFILE '.config\opencode\agent'
if (-not (Test-Path (Join-Path $agentDir 'buddy.md'))) {
  New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
  Copy-Item (Join-Path $Root 'agent\buddy.md') (Join-Path $agentDir 'buddy.md') -Force
  Write-Host '  [ok] Restored OpenCode agent profile' -ForegroundColor Green
}

Write-Host ''
Write-Host '  Hotkey: Ctrl+Alt+B summons the window.' -ForegroundColor Cyan
Write-Host '  Wake word: "Buddy" (or "Hey Buddy").' -ForegroundColor Cyan
Write-Host '  Server: http://127.0.0.1:7777' -ForegroundColor Cyan
Write-Host ''

if (-not $NoLaunch) {
  Start-Process -FilePath $wscript -ArgumentList ('"' + $Vbs + '"')
  Write-Host '  Launching Buddy...' -ForegroundColor Green
}
