# dsh-notify

[**English**](README.md) | **中文**

原生桌面通知插件：把 DSH 里值得注意的事件推到系统通知中心，不用一直盯着窗口。Windows 走原生 toast，macOS 走通知中心横幅。

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| **Windows** | ✅ 已支持 | Windows 10 / 11，原生 toast + 点击置前 |
| **macOS** | ✅ 已支持 | `osascript` 弹通知中心横幅、`afplay` 播提示音；**不支持点击置前** |
| Linux | ❌ 暂无计划 | —— |

> 其他平台加载时只打一条 warn 然后静默退出 —— 不报错、不崩溃，不影响 DSH 正常使用。
> 事件策略在 `lib/core.js`，跨平台通用；与系统相关的只有投递层 `lib/transport-*.js`。

## 触发的事件

| 事件 | 来源 | 弹出形式 | 默认 |
| --- | --- | --- | --- |
| 主会话任务完成 | `turn/end` reason=completed | 横幅 | 开 |
| 主会话任务**失败** | `turn/end` reason=error | 强提醒 | 开 |
| 主会话任务中断 | `turn/end` reason=aborted / max-tokens / blocked | 横幅 | 开 |
| **需要人工审批** | `approval/asked` | 强提醒 | 开 |
| **模型在提问等你回答** | `tool/call` name=ask_user_question | 强提醒（带问题标题） | 开 |
| 审批被自动拒绝 | `approval/asked` 且策略为 `never` | 横幅（不打扰） | 跟随上一条 |
| 上下文占用超阈值 | `contextPressure` 投影 | 横幅；≥95% 升为强提醒 | 开（80%） |
| 当日 token 预算超支 | `tokenUsage` 投影增量 | 强提醒（每天一次） | 关 |
| 子任务完成 | `turn/end` origin=subagent | 横幅 | **关** |

强提醒 = "必须看一眼"：Windows 是 `duration="long"` 的 toast，macOS 没有长驻横幅，改用重复提示音。两边默认都播一遍短音。

> 声音由插件自己播 —— Windows 用 `SoundPlayer`，macOS 用 `afplay`。Windows 上刻意**不放在 toast 的 `<audio>` 里**：后者对非打包桌面应用会静默失效（XML 收下，什么都不响，也不报错）。
> Windows 的音频文件从系统声音方案读取，你自定义过提示音也会跟着变；macOS 把 `soundEvent` 映射到 `/System/Library/Sounds` 里的系统音。
> 想换音色就改 `soundEvent`（如 `Notification.Calendar`、`Notification.Looping.Alarm`）或 macOS 专属的 `darwinSound`，想多响几次就调 `criticalRepeat`。

## 安装

安装期间 App 必须完全退出 —— `desktop` profile 由 App 独占，运行中改不了。

已在 DSH 0.2.2-rc.1 上验证：macOS 27（arm64）与 Windows 10 / 11 的 desktop profile。

> ⚠️ **必须用 `github:` 形式安装。**
> npm 上已经存在一个同名包 `dsh-notify`（[Pasumao/dsh-plugin-notify](https://github.com/Pasumao/dsh-plugin-notify)），
> 敲 `dsh plugin add dsh-notify` 装到的是它，不是本项目。

### macOS

```bash
# 1. 完全退出 DeepSeek Harness

# 2. 安装
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "github:NotLinky671/dsh-notify"

# 3. 手动重新打开 App
open -a "DeepSeek Harness"
```

需要锁定版本、或者 git 不可用时，改用 Release 里的 tarball：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "https://github.com/NotLinky671/dsh-notify/releases/latest/download/dsh-notify.tgz"
```

### Windows

```powershell
# 1. 完全退出 DeepSeek Harness（含托盘图标）

# 2. 安装
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:NotLinky671/dsh-notify"

# 3. 手动重新打开 App
```

Windows 的 tarball 备用装法：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/NotLinky671/dsh-notify/releases/latest/download/dsh-notify.tgz"
```

`dsh web` 用户把上面所有命令里的 `--profile desktop` 换成 `--profile web`。

### 确认已加载

宿主只在启动时挂载插件，所以要重启 App，刷新窗口不算。插件每次启动都会写一条 trace：

```bash
cat ~/.dsh/storages/dsh-notify/diag.log
```

看到 `[apply] {"platform":"darwin"}` 以及随后的 `[subscribed]` 就说明已经生效；把 `debug` 设为 `true` 会额外记录每个会话事件（启动和派发始终会记）。

### 本地开发

用软链安装，改完源码重启即生效，不用重装：

```bash
# macOS
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "link:$PWD"
```

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:$PWD"
```

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml`（`dsh web` 是 `.../profiles/web/`）里按 id 覆盖：

```yaml
- patch:
    - id: dsh-notify
      config:
        contextWarnPercent: 80      # 0 = 关闭上下文告警
        contextCooldownMs: 300000   # 同会话两次告警最小间隔
        dailyTokenBudget: 20000000  # 当日 20M token 预算，0 = 关闭
        quietHours: [23, 8]         # 23:00–08:00 不弹（可跨午夜）
        notifySubagentEnd: true     # 想收子任务通知就打开
        sound: false
        clickFocus: false           # 仅 Windows
        darwinSound: Pop            # 仅 macOS：声音名（Pop / Pop.aiff）或绝对路径
```

改完重启 App。

## 点击通知置前（仅 Windows）

macOS 的 `osascript` 横幅没有点击动作，所以点击置前只在 Windows 上存在。macOS 上该选项被忽略（加载时打一条 warn），点横幅只会打开通知中心。

Windows 上装好后首次加载会写入两个 **HKCU**（当前用户，免管理员）注册表项：

- `HKCU\SOFTWARE\Classes\AppUserModelID\DeepSeek.Harness.Notify` —— 让 Windows 接受我们的 toast，显示名为 "DeepSeek Harness"
- `HKCU\Software\Classes\dsh-notify` —— `dsh-notify:` URL 协议。点击 toast 时执行
  `wscript.exe //nologo scripts\focus.vbs`，由它再以**隐藏窗口**启动 `focus.ps1`。

这里有两个坑，都踩过：

1. **不能直接注册 `powershell.exe`**。它是控制台程序，协议处理器一拉就会分配控制台窗口，
   `-WindowStyle Hidden` 只能在窗口创建后藏起来，中间那一下闪烁躲不掉；默认终端是
   Windows Terminal 时 `-WindowStyle` 甚至被忽略，直接开一个标签页。改用 `wscript.exe`
   （GUI 子系统宿主）就完全没有控制台。
2. **裸 `SetForegroundWindow` 会被前台锁静默忽略**。后台进程没有前台权限，调用返回但什么
   都不发生。`focus.ps1` 因此走 `AttachThreadInput` 借前台线程的输入队列，再
   `BringWindowToTop` + `SetForegroundWindow`，最后用 `SwitchToThisWindow` 兜底。

不想写注册表就设 `clickFocus: false`，toast 依然正常弹，只是点了没反应。

## macOS 注意事项

- **权限与归属。** 脚本通知归到哪个 App 由系统判定（通常是「脚本编辑器」，也可能是宿主 App）。
  第一次弹可能需要到**系统设置 › 通知**里放行；被拒绝时 `osascript` 依然返回 `0`，横幅却不会出现。
  收不到通知先查这一项。
- **没有长驻横幅。** macOS 不支持长时间停留或模态通知，强提醒改用重复提示音表达（上限 5 次）。
- **声音映射。** `Notification.Default` → `Glass`、`Notification.IM` → `Ping`、
  `Notification.Mail` → `Pop`、`Notification.Reminder` → `Morse`、
  `Notification.Looping.Alarm` → `Sosumi`，其余落到 `Glass`。`darwinSound` 可覆盖：
  只写名字时去 `/System/Library/Sounds` 找，写绝对路径则原样使用。

## 实现要点

- **零运行时依赖**：Windows 靠 `powershell.exe`（Windows PowerShell 5.1）的 WinRT 投影；
  macOS 靠系统自带的 `osascript` 和 `afplay`。不需要 `node-notifier`、不需要编译原生模块。
- **Windows 必须用 5.1**：pwsh 7 没有 `Windows.UI.Notifications` 的 WinRT 投影，脚本会直接失败。
- **Windows 中文编码**：payload 走 UTF-8 JSON 临时文件而不是命令行参数，避免 PS 5.1 的参数编码问题；脚本读完即删。
- **macOS 引号处理**：标题和正文作为独立 `argv` 传给 `osascript`（脚本里用 `item 1 of argv` 取），
  从不拼进 AppleScript 源码，也不经过 shell。引号、反斜杠、换行、中文都无需转义。
- **失败隔离**：所有子进程都用 `stdio: 'ignore'` 异步起，并挂 `error` 监听；脚本内部 `try/catch/finally` 全包，通知挂了也绝不影响宿主。
  **Windows 上不要加 `detached: true`** —— libuv 会翻成 `DETACHED_PROCESS`，powershell 进程
  建出来但什么都不执行，且不报错（这个 bug 让插件静默失效过一轮）。
- **预算记账**：`~/.dsh/storages/dsh-notify/state.json` 存当日累计和每会话基线。插件启动后首次看到某会话只记基线、不把历史全算进今天。

## 安全与隐私

- **不联网**：插件本身不发起任何网络请求，只在本地 spawn 系统程序（Windows 的 `powershell.exe`、
  macOS 的 `osascript` / `afplay`）弹通知、播提示音。
- **不读消息正文**：只读取会话事件里的 `session/title`、`approval/policy` 元数据，以及 `tokenUsage` / `contextPressure` 两个纯数字聚合投影。
- **注册表只在 Windows 写、且只写 HKCU**（当前用户，不需要管理员）：AUMID 一个键 + `dsh-notify:` 协议一个键。设 `clickFocus: false` 可完全跳过；macOS 不写任何系统状态。
- **零第三方依赖**：`dependencies` 为空，不存在供应链面。

## 开发

```bash
git clone https://github.com/NotLinky671/dsh-notify.git
cd dsh-notify
node --test test/run.mjs
```

37 个离线用例，全部注入 fake（不弹通知、不碰真实 `~/.dsh`）。两个平台的投递层都接受可注入的 `spawn`，因此 argv 与重复次数能在不启动任何子进程的前提下断言。

单独验证 macOS 通道：

```bash
osascript -e 'on run argv' \
  -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
  -e 'end run' "dsh-notify" "hello"
afplay /System/Library/Sounds/Glass.aiff
```

单独验证 Windows toast 通道：

```powershell
@{ aumid='DeepSeek.Harness.Notify'; title='测试'; body='hello'; sound=$true; critical=$false; launch='' } |
  ConvertTo-Json | Set-Content "$env:TEMP\t.json" -Encoding utf8
powershell.exe -NoProfile -File .\scripts\toast.ps1 -Payload "$env:TEMP\t.json"
```

## 已知限制

- 目前支持 **Windows 与 macOS**；其他平台加载时只打一条 warn 后静默退出，不报错。
- 点击置前仅 Windows 可用；macOS 的 `osascript` 横幅点不了，点击只会打开通知中心。
- macOS 上通知是否显示取决于上面的系统权限；被静默拦截时 `osascript` 仍返回 `0`。
- 只在 DSH 宿主进程运行时有效 —— App 关掉就没有事件可听。
- 上下文百分比依赖 `@deepseek-ai/dsh-token-meter` 的 `contextPressure` 投影；宿主没注册该投影时自动跳过，不会报错也不会瞎猜。
- `projectedTokens` 是"下一次请求的预估"，与 UI 上显示的数字可能有细微差异，这是投影本身的定义。

## License

MIT
