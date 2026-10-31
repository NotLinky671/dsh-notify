param(
  [Parameter(Mandatory = $true)][string]$Payload
)

# Show one Windows toast from a UTF-8 JSON payload file.
#
# Runs under Windows PowerShell 5.1 because the WinRT projection
# (Windows.UI.Notifications) is not available in pwsh 7. Everything is
# wrapped so a toast failure can never surface into the host process.

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

  $json = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json

  $aumid = [string]$json.aumid
  if ([string]::IsNullOrWhiteSpace($aumid)) { $aumid = 'DeepSeek.Harness.Notify' }

  # An unregistered AUMID makes Windows silently drop the toast.
  $regPath = "HKCU:\SOFTWARE\Classes\AppUserModelId\$aumid"
  if (-not (Test-Path -LiteralPath $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
    New-ItemProperty -Path $regPath -Name 'DisplayName' -Value 'DeepSeek Harness' -PropertyType String -Force | Out-Null
  }

  function ConvertTo-XmlText([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return '' }
    return ($value -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
  }

  $title = ConvertTo-XmlText ([string]$json.title)
  $body = ConvertTo-XmlText ([string]$json.body)

  $launch = ''
  if (-not [string]::IsNullOrWhiteSpace([string]$json.launch)) {
    $launch = ' activationType="protocol" launch="' + (ConvertTo-XmlText ([string]$json.launch)) + '"'
  }

  $critical = ($json.critical -eq $true)
  $duration = if ($critical) { ' duration="long"' } else { '' }

  # Deliberately NO <audio> element. Windows accepts it for unpackaged desktop
  # apps and then plays nothing, silently. The plugin plays the sound itself in
  # sound.ps1, which works regardless of packaging.

  $xml = '<toast' + $launch + $duration + '><visual><binding template="ToastGeneric"><text>' +
    $title + '</text><text>' + $body + '</text></binding></visual></toast>'

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
}
catch {
  # Swallow: a broken notification must never affect the harness.
}
finally {
  Remove-Item -LiteralPath $Payload -Force -ErrorAction SilentlyContinue
}
