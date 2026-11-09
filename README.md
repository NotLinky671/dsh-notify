# dsh-notify

**English** | [**中文**](README.zh.md)

Native desktop notifications for DeepSeek Harness: pushes the events worth your attention to the system notification center, so you don't have to keep staring at the window.

## Platform support

| Platform | Status | Notes |
| --- | --- | --- |
| **Windows** | ✅ Supported | Windows 10 / 11, native toasts + click-to-focus |
| **macOS** | ✅ Supported | Notification Center banners via `osascript`, cue via `afplay`; no click-to-focus |
| Linux | ❌ Not planned | — |

> On any other platform the plugin logs a single warning and exits quietly — no error, no crash, no impact on DSH itself.
> The event policy lives in `lib/core.js` and is platform-neutral; only the delivery layer (`lib/transport-*.js`) is OS-specific.

## What triggers a notification

| Event | Source | Presentation | Default |
| --- | --- | --- | --- |
| Root turn completed | `turn/end` reason=completed | Banner | On |
| Root turn **failed** | `turn/end` reason=error | Alert | On |
| Root turn interrupted | `turn/end` reason=aborted / max-tokens / blocked | Banner | On |
| **Approval required** | `approval/asked` | Alert | On |
| **Agent is asking you a question** | `tool/call` name=ask_user_question | Alert (with the question header) | On |
| Approval auto-rejected | `approval/asked` with policy `never` | Banner (non-intrusive) | Follows the row above |
| Context above threshold | `contextPressure` projection | Banner; escalates to alert at ≥95% | On (80%) |
| Daily token budget exceeded | `tokenUsage` projection delta | Alert (once per day) | Off |
| Subagent turn ended | `turn/end` origin=subagent | Banner | **Off** |

Alert means "you must look at this": on Windows a `duration="long"` toast, on macOS a repeated cue (macOS has no sticky banners). Both play a short chime by default.

> The sound is played by the plugin itself — `SoundPlayer` on Windows, `afplay` on macOS. On Windows it is deliberately **not** the toast's `<audio>` element, which silently fails for unpackaged desktop apps (the XML is accepted, nothing plays, no error is reported).
> Windows resolves the wav from your current sound scheme, so a customised scheme is honoured; macOS maps `soundEvent` onto the stock alerts in `/System/Library/Sounds`.
> Change the timbre with `soundEvent` (e.g. `Notification.Calendar`, `Notification.Looping.Alarm`) or `darwinSound`, and the repeat count with `criticalRepeat`.

## Installation

The app must be fully quit during installation — the `desktop` profile is owned exclusively by the app and cannot be modified while it runs.

Verified on DSH 0.2.2-rc.1: desktop profile on macOS 27 (arm64) and Windows 10 / 11.

> ⚠️ **Install via the `github:` form.**
> An unrelated package named `dsh-notify` already exists on npm ([Pasumao/dsh-plugin-notify](https://github.com/Pasumao/dsh-plugin-notify)).
> Running `dsh plugin add dsh-notify` installs *that* one, not this project.

### macOS

```bash
# 1. Fully quit DeepSeek Harness

# 2. Install
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "github:NotLinky671/dsh-notify"

# 3. Start the app again
open -a "DeepSeek Harness"
```

Pin a version, or skip git, with the release tarball:

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "https://github.com/NotLinky671/dsh-notify/releases/latest/download/dsh-notify.tgz"
```

### Windows

```powershell
# 1. Fully quit DeepSeek Harness (including the tray icon)

# 2. Install
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:NotLinky671/dsh-notify"

# 3. Start the app again manually
```

Windows tarball fallback:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/NotLinky671/dsh-notify/releases/latest/download/dsh-notify.tgz"
```

For `dsh web`, replace `--profile desktop` with `--profile web` in every command above.

### Confirming it loaded

The host mounts plugins only at boot, so restart the app instead of reloading the window. The plugin always writes a startup trace:

```bash
cat ~/.dsh/storages/dsh-notify/diag.log
```

`[apply] {"platform":"darwin"}` followed by `[subscribed]` means it is live; `debug: true` adds one line per session event on top of the startup and dispatch lines.

### Local development

Link the checkout instead — edits take effect on restart, no reinstall needed:

```bash
# macOS
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "link:$PWD"
```

```powershell
# Windows
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
        clickFocus: false           # Windows only
        darwinSound: Pop            # macOS only: "Pop", "Pop.aiff", or an absolute path
```

Restart the app after editing.

## Click to focus (Windows only)

macOS banners raised through `osascript` carry no click action, so click-to-focus exists on Windows only. On macOS the option is ignored (one warning at load), and clicking a banner just opens Notification Center.

On Windows, the first load writes two **HKCU** (current user, no administrator) registry keys:

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

## macOS specifics

- **Permission and attribution.** macOS decides which app a scripted notification belongs to (usually
  Script Editor, sometimes the host app). The first banner may need approval under
  **System Settings › Notifications**, and a denied permission makes `osascript` drop the banner while
  still exiting `0`. If nothing appears, check that list first.
- **No sticky banners.** macOS has no long-duration or modal notification, so a critical event is
  expressed through a repeated cue instead (capped at 5).
- **Sound mapping.** `Notification.Default` → `Glass`, `Notification.IM` → `Ping`,
  `Notification.Mail` → `Pop`, `Notification.Reminder` → `Morse`, `Notification.Looping.Alarm` → `Sosumi`;
  anything unknown falls back to `Glass`. `darwinSound` overrides the mapping; a bare name is looked up in
  `/System/Library/Sounds`, an absolute path is used verbatim.

## Implementation notes

- **Zero runtime dependencies**: Windows uses the WinRT projection of `powershell.exe` (PowerShell 5.1);
  macOS uses the stock `osascript` and `afplay` binaries. No `node-notifier`, no native modules to compile.
- **PowerShell 5.1 is required on Windows**: pwsh 7 has no `Windows.UI.Notifications` WinRT projection,
  so the scripts fail outright.
- **Windows encoding**: the payload travels as a UTF-8 JSON temp file rather than command-line arguments,
  avoiding PS 5.1 argument-encoding issues; the script deletes it after reading.
- **macOS quoting**: the title and body are passed to `osascript` as `argv` items (`item 1 of argv`), never
  spliced into AppleScript source, and no shell is involved. Quotes, backslashes, newlines and CJK text
  therefore need no escaping at all.
- **Failure isolation**: every child process is spawned asynchronously with `stdio: 'ignore'` and an
  `error` listener; each PowerShell script wraps itself in `try/catch/finally`. A broken notification can
  never affect the host.
  **Do not add `detached: true` on Windows** — libuv turns it into `DETACHED_PROCESS`, where the powershell
  process is created but does nothing at all, without reporting an error. That bug once made the plugin fail silently.
- **Budget accounting**: `~/.dsh/storages/dsh-notify/state.json` holds the daily total and a per-session baseline. The first time the plugin sees a session it records only the baseline, so history is not charged to today.

## Security & privacy

- **No network access**: the plugin makes no requests; it only spawns local binaries (`powershell.exe` on
  Windows, `osascript` / `afplay` on macOS) to show a banner and play a cue.
- **No message content**: it reads only `session/title` and `approval/policy` metadata from session events, plus the two numeric projections `tokenUsage` / `contextPressure`.
- **Registry writes are Windows-only and HKCU only** (current user, no administrator): one AUMID key and one `dsh-notify:` protocol key. `clickFocus: false` skips them completely. macOS writes no system state at all.
- **Zero third-party dependencies**: `dependencies` is empty, so there is no supply-chain surface.

## Development

```bash
git clone https://github.com/NotLinky671/dsh-notify.git
cd dsh-notify
node --test test/run.mjs
```

37 offline test cases, all driven through injected fakes (no notification is shown, the real `~/.dsh` is never touched). Both transports are constructed with an injectable `spawn`, so argv and repetition logic are asserted without running a single child process.

To exercise the macOS transport alone:

```bash
osascript -e 'on run argv' \
  -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
  -e 'end run' "dsh-notify" "hello"
afplay /System/Library/Sounds/Glass.aiff
```

To exercise the Windows toast transport alone:

```powershell
@{ aumid='DeepSeek.Harness.Notify'; title='test'; body='hello'; sound=$true; critical=$false; launch='' } |
  ConvertTo-Json | Set-Content "$env:TEMP\t.json" -Encoding utf8
powershell.exe -NoProfile -File .\scripts\toast.ps1 -Payload "$env:TEMP\t.json"
```

## Known limitations

- **Windows and macOS only**; other platforms log one warning and exit quietly.
- Click-to-focus is Windows-only; macOS banners raised by `osascript` cannot run a command when clicked.
- On macOS, notification visibility depends on the system permission described above; `osascript` exits `0` even when the banner is suppressed.
- Only active while the DSH host process runs — no events exist once the app is closed.
- The context percentage depends on the `contextPressure` projection from `@deepseek-ai/dsh-token-meter`. When the host does not register that projection the check is skipped silently rather than guessed.
- `projectedTokens` is an estimate for the *next* request, so it can differ slightly from the number shown in the UI. That is the projection's own definition.

## License

MIT
