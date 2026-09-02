' silent-run.vbs
' Runs a PowerShell script with ZERO console window flash.
' Usage: wscript.exe silent-run.vbs "C:\path\to\script.ps1"
' Called by Task Scheduler instead of powershell.exe directly.

Dim shell, scriptPath, cmd
Set shell = CreateObject("WScript.Shell")

scriptPath = WScript.Arguments(0)
cmd = "powershell.exe -ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File """ & scriptPath & """"

' Run() with second arg = 0 means completely hidden window, no flash at all
shell.Run cmd, 0, False

Set shell = Nothing
WScript.Quit 0
