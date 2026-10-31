param(
  [switch]$Critical,
  [string]$Event = 'Notification.Default',
  [int]$Repeat = 1
)

# Play a notification sound ourselves.
#
# Toast `<audio>` elements are unreliable for unpackaged desktop apps: Windows
# accepts the XML and then plays nothing, with no error anywhere. Playing the
# wav directly through SoundPlayer sidesteps that entirely.
#
# The sound file is resolved from the user's current sound scheme, so a
# customised scheme is respected; the fallback table only covers a scheme that
# has no entry for the requested event.

$ErrorActionPreference = 'SilentlyContinue'

# Backward compatibility: callers from before the `-Event` refactor passed
# `-Critical`. Treat it as the short cue, once — the 5.6s alarm was the thing
# being fixed, and a missing parameter would otherwise mute the notification.
if ($Critical) {
  $Event = 'Notification.Default'
  $Repeat = 1
}

if ($Repeat -lt 1) { $Repeat = 1 }
if ($Repeat -gt 10) { $Repeat = 10 }

$path = ''
$schemeKey = "HKCU:\AppEvents\Schemes\Apps\.Default\$Event\.Current"
if (Test-Path -LiteralPath $schemeKey) {
  $path = [string](Get-Item -LiteralPath $schemeKey).GetValue('')
}
if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) {
  # Short by default: the looping alarm is 5.6s per play, so three repeats
  # become an 18-second interruption.
  $fallback = if ($Event -like '*Alarm*') { 'Alarm01.wav' } else { 'Windows Notify System Generic.wav' }
  $path = Join-Path $env:SystemRoot "Media\$fallback"
}
if (-not (Test-Path -LiteralPath $path)) { exit 0 }

try {
  $player = New-Object System.Media.SoundPlayer $path
  for ($i = 0; $i -lt $Repeat; $i++) {
    $player.PlaySync()
    if ($i -lt $Repeat - 1) { Start-Sleep -Milliseconds 350 }
  }
}
catch {
  # A silent notification is better than a broken one.
}
