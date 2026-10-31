Option Explicit

' Toast click handler.
'
' Invoked by the `dsh-notify:` URL protocol. This wrapper exists for one reason:
' wscript.exe is a GUI-subsystem host, so nothing here ever allocates a console
' window. Launching powershell.exe directly from the protocol handler always
' flashes a terminal (and Windows Terminal ignores -WindowStyle Hidden outright).

Dim sh, ps, script, here
Set sh = CreateObject("WScript.Shell")

here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
script = here & "focus.ps1"

If Not CreateObject("Scripting.FileSystemObject").FileExists(script) Then
  WScript.Quit 0
End If

ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

' 0 = hidden window, False = do not wait for it to finish.
sh.Run """" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
