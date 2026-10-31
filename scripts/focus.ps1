$ErrorActionPreference = 'SilentlyContinue'

# Toast click handler: bring the DeepSeek Harness main window to the foreground.
#
# A bare SetForegroundWindow from a background process is silently ignored by
# Windows' foreground lock, so this uses the standard escape hatch: attach to
# the current foreground thread's input queue, raise the window, then detach.
# SwitchToThisWindow is the last-resort fallback.
#
# Invoked through the `dsh-notify:` URL protocol, so it must exit quietly when
# the app is not running.

Add-Type -Namespace DshToast -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
'@

$target = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
  Select-Object -First 1

if ($null -eq $target) { exit 0 }

$handle = $target.MainWindowHandle

# SW_RESTORE = 9: un-minimize before raising.
if ([DshToast.Native]::IsIconic($handle)) {
  [void][DshToast.Native]::ShowWindowAsync($handle, 9)
}

$foreground = [DshToast.Native]::GetForegroundWindow()
$foregroundThread = 0
if ($foreground -ne [IntPtr]::Zero) {
  $unused = 0
  $foregroundThread = [DshToast.Native]::GetWindowThreadProcessId($foreground, [ref]$unused)
}

$ownThread = [DshToast.Native]::GetCurrentThreadId()
$attached = $false
if ($foregroundThread -ne 0 -and $foregroundThread -ne $ownThread) {
  $attached = [DshToast.Native]::AttachThreadInput($ownThread, $foregroundThread, $true)
}

[void][DshToast.Native]::BringWindowToTop($handle)
[void][DshToast.Native]::SetForegroundWindow($handle)

if ($attached) {
  [void][DshToast.Native]::AttachThreadInput($ownThread, $foregroundThread, $false)
}

# If the foreground lock still held, fall back to the legacy switcher.
if ([DshToast.Native]::GetForegroundWindow() -ne $handle) {
  [DshToast.Native]::SwitchToThisWindow($handle, $true)
}
