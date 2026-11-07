Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
Here = fso.GetParentFolderName(WScript.ScriptFullName)
Cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & Here & "\start-buddy.ps1"""
sh.Run Cmd, 0, False
