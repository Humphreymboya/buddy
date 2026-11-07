$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class BuddyHotkeyWindow : NativeWindow {
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    public event EventHandler Pressed;
    public bool Registered = false;
    private const int HOTKEY_ID = 0xB0DD;

    public BuddyHotkeyWindow() {
        CreateHandle(new CreateParams());
        Registered = RegisterHotKey(this.Handle, HOTKEY_ID, 0x0003, 0x42); // Ctrl+Alt+B
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312 && m.WParam.ToInt32() == HOTKEY_ID) {
            var h = Pressed;
            if (h != null) h(this, EventArgs.Empty);
        }
        base.WndProc(ref m);
    }
}
"@

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'hotkey.log'
function Write-Log([string]$m) { "$(Get-Date -Format o) $m" | Out-File -FilePath $Log -Append -Encoding utf8 }

$focusScript = Join-Path $Root 'focus-buddy.ps1'
$startScript = Join-Path $Root 'start-buddy.ps1'

$win = New-Object BuddyHotkeyWindow
Write-Log "start registered=$($win.Registered)"
if (-not $win.Registered) { exit 0 }   # another instance already owns the hotkey

$win.add_Pressed({
    Write-Log 'hotkey pressed'
    $null = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $focusScript) `
        -WindowStyle Hidden
})

# Second press within 60s of a failed focus attempt starts the app instead.
$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
