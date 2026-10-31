param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Aumid = 'DeepSeek.Harness.Notify'
)

# One-time, per-user registration (no administrator required):
#   1. the AppUserModelID that makes Windows accept our toasts, and
#   2. the `dsh-notify:` URL protocol that turns a toast click into focus.ps1.
#
# Idempotent: safe to run on every plugin load.

$ErrorActionPreference = 'SilentlyContinue'

# 1. AppUserModelID -----------------------------------------------------------
$appIdKey = "HKCU:\SOFTWARE\Classes\AppUserModelId\$Aumid"
if (-not (Test-Path -LiteralPath $appIdKey)) {
  New-Item -Path $appIdKey -Force | Out-Null
}
New-ItemProperty -Path $appIdKey -Name 'DisplayName' -Value 'DeepSeek Harness' -PropertyType String -Force | Out-Null

# 2. dsh-notify: URL protocol --------------------------------------------------
$focusScript = Join-Path $Root 'scripts\focus.ps1'
if (-not (Test-Path -LiteralPath $focusScript)) { return }

$protocolKey = 'HKCU:\Software\Classes\dsh-notify'
if (-not (Test-Path -LiteralPath $protocolKey)) {
  New-Item -Path $protocolKey -Force | Out-Null
}
Set-Item -Path $protocolKey -Value 'URL:DSH Toast Focus'
New-ItemProperty -Path $protocolKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

$commandKey = Join-Path $protocolKey 'shell\open\command'
if (-not (Test-Path -LiteralPath $commandKey)) {
  New-Item -Path $commandKey -Force | Out-Null
}

# Launch through wscript.exe (a GUI-subsystem host), NOT powershell.exe.
# PowerShell is a console app: the protocol handler would always flash a
# terminal window, and Windows Terminal ignores -WindowStyle Hidden entirely.
# focus.vbs then starts focus.ps1 with a hidden window.
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$focusVbs = Join-Path $Root 'scripts\focus.vbs'
if (Test-Path -LiteralPath $focusVbs) {
  $command = '"' + $wscript + '" //nologo "' + $focusVbs + '"'
}
else {
  # Fallback for an incomplete install: still better than no click handling.
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $command = '"' + $powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $focusScript + '"'
}
Set-Item -Path $commandKey -Value $command
