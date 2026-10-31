# dsh-notify

**English** | [**中文**](README.zh.md)

Native Windows toast notifications for DeepSeek Harness: pushes the events worth your attention to the system notification center, so you don't have to keep staring at the window.

## Platform support

| Platform | Status | Notes |
| --- | --- | --- |
| **Windows** | ✅ Supported | Windows 10 / 11, native toasts + click-to-focus |
| **macOS** | 🚧 Planned | Needs `osascript` / `UNUserNotificationCenter`; both notification and focus APIs differ completely from Windows |
| Linux | ❌ Not planned | — |

> ⚠️ **This release supports Windows only.**
> On macOS / Linux the plugin logs a single warning and exits quietly — no error, no crash, no impact on DSH itself.
> Configuration and event logic are already cross-platform; only the delivery layer (`scripts/*.ps1`) would need replacing.

## What triggers a notification

| Event | Source | Presentation | Default |
| --- | --- | --- | --- |
| Root turn completed | `turn/end` reason=completed | Banner | On |
| Root turn **failed** | `turn/end` reason=error | Alert (sticky + sound) | On |
| Root turn interrupted | `turn/end` reason=aborted / max-tokens / blocked | Banner | On |
| **Approval required** | `approval/asked` | Alert | On |
| **Agent is asking you a question** | `tool/call` name=ask_user_question | Alert (with the question header) | On |
| Approval auto-rejected | `approval/asked` with policy `never` | Banner (non-intrusive) | Follows the row above |
| Context above threshold | `contextPressure` projection | Banner; escalates to alert at ≥95% | On (80%) |
| Daily token budget exceeded | `tokenUsage` projection delta | Alert (once per day) | Off |
| Subagent turn ended | `turn/end` origin=subagent | Banner | **Off** |

Alert = `duration="long"` plus a single sound cue (a short ~1.3s chime by default). Windows toasts have no real modal dialog, so this is the closest thing to "you must look at this".

> The sound is played by the plugin itself via `SoundPlayer`, **not through the toast's `<audio>` element** — the latter silently fails for unpackaged desktop apps (the XML is accepted, nothing plays, no error is reported).
> The wav is resolved from your current sound scheme, so a customised scheme is honoured.
> Change the timbre with `soundEvent` (e.g. `Notification.Calendar`, `Notification.Looping.Alarm`), or the repeat count with `criticalRepeat`.

## Installation

**Windows only** (macOS is planned, see [platform support](#platform-support)). Verified on DSH 0.2.x Desktop. The app must be fully quit during installation — the `desktop` profile is owned exclusively by the app and cannot be modified while it runs.

> ⚠️ **Install via the `github:` form.**
> An unrelated package named `dsh-notify` already exists on npm ([Pasumao/dsh-plugin-notify](https://github.com/Pasumao/dsh-plugin-notify)).
> Running `dsh plugin add dsh-notify` installs *that* one, not this project.

```powershell
# 1. Fully quit DeepSeek Harness (including the tray icon)

# 2. Install
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:NotLinky671/dsh-notify"

# 3. Start the app again manually
```

`dsh web` users: replace `--profile desktop` with `--profile web`.

For local development, link the checkout instead — edits take effect on restart, no reinstall needed:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:$PWD"
```

## Configuration

Override by id in `~/.dsh/profiles/desktop/cordis.patch.yml` (`.../profiles/web/` for `dsh web`):

```yaml
- patch:
    - id: dsh-notify
      config:
        contextWarnPercent: 80      # 0 disables the context warning
        contextCooldownMs: 300000   # min gap between two warnings in one session
        dailyTokenBudget: 20000000  # 20M tokens/day; 0 disables
        quietHours: [23, 8]         # no toasts 23:00-08:00 (may wrap midnight)
        notifySubagentEnd: true     # opt into subagent notifications
        sound: false
        clickFocus: false
```

Restart the app after editing.

## Click to focus

On first load the plugin writes two **HKCU** (current user, no administrator) registry keys:

- `HKCU\SOFTWARE\Classes\AppUserModelID\DeepSeek.Harness.Notify` — lets Windows accept our toasts, displayed as "DeepSeek Harness"
- `HKCU\Software\Classes\dsh-notify` — the `dsh-notify:` URL protocol. Clicking a toast runs
  `wscript.exe //nologo scripts\focus.vbs`, which starts `focus.ps1` with a **hidden window**.

Two traps were hit here, both worth knowing:

1. **Never register `powershell.exe` directly.** It is a console program, so the protocol handler always
   gets a console window allocated. `-WindowStyle Hidden` can only hide a window after it exists, so the
   flash is unavoidable; and when the default terminal is Windows Terminal, `-WindowStyle` is ignored
   outright and you get a new tab. Going through `wscript.exe` (a GUI-subsystem host) means no console at all.
2. **A bare `SetForegroundWindow` is silently ignored** by Windows' foreground lock. A background process
   has no foreground rights, so the call returns and nothing happens. `focus.ps1` therefore uses
   `AttachThreadInput` to borrow the foreground thread's input queue, then `BringWindowToTop` +
   `SetForegroundWindow`, with `SwitchToThisWindow` as a last resort.

Set `clickFocus: false` to skip the registry entirely — toasts still appear, they just do nothing when clicked.

## Implementation notes

- **Zero runtime dependencies**: notifications go through the WinRT projection of `powershell.exe` (Windows PowerShell 5.1) — no `node-notifier`, no native modules to compile.
- **PowerShell 5.1 is required**: pwsh 7 has no `Windows.UI.Notifications` WinRT projection, so the scripts fail outright.
- **Encoding**: the payload travels as a UTF-8 JSON temp file rather than command-line arguments, avoiding PS 5.1 argument-encoding issues; the script deletes it after reading.
- **Failure isolation**: every PowerShell call is spawned asynchronously with `stdio: 'ignore'`, and each script wraps itself in `try/catch/finally`, so a broken notification can never affect the host.
  **Do not add `detached: true`** — libuv turns it into `DETACHED_PROCESS` on Windows, where the powershell
  process is created but does nothing at all, without reporting an error. That bug once made the plugin fail silently.
- **Budget accounting**: `~/.dsh/storages/dsh-notify/state.json` holds the daily total and a per-session baseline. The first time the plugin sees a session it records only the baseline, so history is not charged to today.

## Security & privacy

- **No network access**: the plugin makes no requests; it only spawns `powershell.exe` locally to show a toast.
- **No message content**: it reads only `session/title` and `approval/policy` metadata from session events, plus the two numeric projections `tokenUsage` / `contextPressure`.
- **Registry writes are HKCU only** (current user, no administrator): one AUMID key and one `dsh-notify:` protocol key. `clickFocus: false` skips them completely.
- **Zero third-party dependencies**: `dependencies` is empty, so there is no supply-chain surface.

## Development

```powershell
git clone https://github.com/NotLinky671/dsh-notify.git
cd dsh-notify
node --test test/run.mjs
```

26 offline test cases, all driven through injected fakes (no toast is shown, the real `~/.dsh` is never touched).

To exercise the toast transport alone:

```powershell
@{ aumid='DeepSeek.Harness.Notify'; title='test'; body='hello'; sound=$true; critical=$false; launch='' } |
  ConvertTo-Json | Set-Content "$env:TEMP\t.json" -Encoding utf8
powershell.exe -NoProfile -File .\scripts\toast.ps1 -Payload "$env:TEMP\t.json"
```

## Known limitations

- **Windows only** for now; macOS support is planned. On other platforms the plugin logs one warning and exits quietly.
- Only active while the DSH host process runs — no events exist once the app is closed.
- The context percentage depends on the `contextPressure` projection from `@deepseek-ai/dsh-token-meter`. When the host does not register that projection the check is skipped silently rather than guessed.
- `projectedTokens` is an estimate for the *next* request, so it can differ slightly from the number shown in the UI. That is the projection's own definition.

## License

MIT
