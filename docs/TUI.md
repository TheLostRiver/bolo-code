# CLI TUI

> 无遥测。品牌见 `docs/BRAND.md`。  
> **现状：** OI-09–OI-13 建立的 Bolo 水晶、slash 菜单/参数提示、`/context`、paste
> 事务、分段 Thinking/Thought、权限详情与非 TTY fallback 等业务能力，已在
> OI-14A–H 迁入单一 retained TTY 架构。旧 direct-write surface、字符串布局补丁、
> 局部 raw owner 与 engine selector 均已删除；只剩 OI-H3 真人 Windows Terminal 走查。
> **框架选择：** OI-14A 已选定精确版本的 Pi TUI direct bundle，不再继续扩展自研
> `TerminalSurface + contentPrefixer + tiny Markdown`。分切片复用 renderer/Markdown/
> keys/StdinBuffer 并保留 Bolo terminal adapter 与输入业务层；Node、Windows、
> 体积、资产和许可证据见
> [CLI_TUI_RENDERER_DECISION.md](./CLI_TUI_RENDERER_DECISION.md)。
> **状态层：** OI-14B `269b39c` 已在 `packages/shared` 建立无 I/O 的
> `CliTuiViewState`、稳定 block id、stream/tool/search 合并、resume replay 与
> composer/overlay/segment elapsed 状态。OI-14C `1798a7c` 已建立 Bolo terminal
> adapter、稳定 retained root、theme/width/resize 与水晶 welcome；OI-14D
> `8b060e5` 已按 stable block id 迁入 retained transcript 与 Pi Markdown；OI-14E
> `d0fb822` 已迁常驻 Bolo Composer、分段 activity 与 footer；OI-14F `31384d4`
> 已迁 permission/question/provider/effort/diff/pager 到唯一 OverlayHost。OI-14G
> `6f4764f`–`accc22c` 已完成默认切换、长会话/resize/backpressure、final flush、
> crash cleanup 与性能预算；OI-14H `39e66b4`–`d4eaed0` 已完成 legacy 删除、
> static owner/absence guard 与发布审计。
> Diff 轨见 [ROADMAP.md](./ROADMAP.md) §3 ·
> [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) 轨 B。

---

## 1. 模式（已有）

| 条件 | 行为 |
|------|------|
| stdin/stdout 双 TTY + stdin 支持 raw mode | 响应式水晶工作台 + 常驻全宽 composer + slash 参数提示 + context 仪表盘 + 动态 Thinking/Running 时间线 |
| TTY 但 raw mode 不可用 | 回落 readline `bolo>`；不发送动态光标控制 |
| 非 TTY / pipe / `-p` / `--print` | 追加式纯文本；不回显伪输入框、不挂起等按键 |
| `NO_COLOR` | 关闭 SGR 颜色，保留欢迎页结构与真实输入能力 |
| `BOLO_ASCII=1` | 欢迎页使用 ASCII 水晶和 ASCII 分隔符；不改变 TUI 能力 |
| `BOLO_PLAIN=1` / `BOLO_THEME=plain` | 关闭颜色并简化欢迎区；真实输入能力仍可用 |
| `BOLO_TUI_INPUT=0` | 关闭动态输入/时间线，回落 readline |
| `BOLO_TUI_LAYOUT=0` / `TERM=dumb` | 关闭 layout 与动态路径，回落 readline |
| `>=96` 列 | 最大 100-cell 工作台：完整水晶在左，Ready/workspace/model/session 在右 |
| `56–95` 列 | 单列工作台：中型水晶、居中状态、左对齐 metadata |
| `38–55` 列 | 单列工作台：6 行紧凑水晶；动态文本按 cell 宽度裁切 |
| `<38` 列 | 欢迎页回落无边框纯文本，避免最小终端破框 |
| `BOLO_MASCOT=0` | 隐藏水晶，保留品牌字标和 workspace/model/session 信息 |
| `--resume` 无 id | **箭头键 picker**（↑↓ Enter；`BOLO_ARROW_PICKER=0` 用编号） |
| 非 TTY resume | 表格式列表 + 要求 `--resume <id>` |
| `runtime list\|inspect` + stdin/stdout 双 TTY + 多页 | 进入轻量 runtime pager |
| runtime pipe / `--json` / 空结果或单页 | 一次性完整输出；不启 pager、不读 stdin |

---

## 2. 模块（已有）

| 文件 | 角色 |
|------|------|
| `packages/shared/src/cliTuiViewState.ts` | **OI-14B**：有序 live blocks、稳定 id、SessionEvent/resume 投影、composer/overlay/elapsed 纯状态真源 |
| `packages/shared/src/runtimePager.ts` | **OI-14F–H**：pager key/state/result 纯 reducer，由 retained OverlayHost 消费 |
| `tui/boloTerminalAdapter.ts` | **OI-14C–H**：dynamic TTY 唯一原始 writer 与 stdin owner；resize/render epoch/scrollback、Pi `StdinBuffer`、raw/mode-2004 与异常 acquisition/cleanup |
| `tui/retainedTui.ts` | **OI-14C–H**：稳定 Pi root/controller、theme/viewport/welcome、view-state、transcript/activity/composer/footer/overlay 根布局、精确 stream fallback 与 final flush |
| `tui/retainedTranscript.ts` | **OI-14D**：按 stable block id 缓存 User/Assistant/Thought/Tool/Search/Error/Warning/Summary 组件；Pi Markdown、整宽用户块、物理 gutter 与父级 section gap |
| `tui/retainedComposer.ts` | **OI-14E**：稳定 Bolo Composer/Footer；复用输入 reducer、slash/hint/history，补 undo、Pi keys 与 `CURSOR_MARKER` |
| `tui/retainedActivity.ts` | **OI-14E**：把既有分段 activity 的当前帧投影为 retained child，不直接写 stdout |
| `tui/retainedOverlay.ts` | **OI-14F–H**：唯一 OverlayHost；承载 permission/question/picker/diff/pager，保留 Composer identity/focus 与单一 stdin/writer owner |
| `tui/crystalLogo.ts` | 水晶常量、源稿归一化、整块 cell-width 居中与 ASCII 降级 |
| `tui/inkLayout.ts` | 一次性水晶工作台；宽屏 split、中/紧凑单列，不伪装成输入框 |
| `tui/frame.ts` | 100-cell welcome、160-cell content 与全宽 dock 三套明确宽度契约 |
| `tui/contentLayout.ts` | retained transcript/dashboard 共用的响应式 gutter 常量与解析 |
| `tui/contextDashboard.ts` | core `ContextUsageViewModel` 的响应式 TTY 仪表盘 |
| `tui/inputBox.ts` | 输入/slash reducer、argument hint、CJK-safe renderer、capability 判断与共享结果类型；不持有 stdin |
| `tui/terminalText.ts` | 字段级 ANSI/CJK/emoji cell-width helper；block wrap 由 retained Markdown/layout 负责 |
| `tui/turnActivity.ts` | reasoning/tool/search/retry 分段生命周期、动画与独立计时 |
| `tui/arrowPicker.ts` | 箭头选择 reducer/formatter 与非动态编号文本回落 |
| `tui/theme.ts` | F-T9：主题 |
| `tui/banner.ts` · `statusLine.ts` | 启动/状态 |
| `tui/formatSessionEvent.ts` | non-TTY/plain user/reasoning/tool/assistant 追加式 formatter |
| `tui/diffPane.ts` | retained diff overlay 消费的结果类型 |
| `tui/permissionPanel.ts` · `askPermissionTty.ts` | command/cwd/关键参数 view-model、once/always/deny reducer 与文本回落 |
| `packages/core/src/runtimeTextView.ts` | AR1C：纯 runtime text page renderer；CLI 与 slash 共用 |
| `tui/runtimePager.ts` | AR1C/OI-14F–H：standalone retained OverlayHost pager；复用 shared pager reducer |
| `slashCandidates.ts` | core 候选与 CLI-local `/exit`/`/quit` 的无副作用合并层 |
| `runtimeCli.ts` | AR1：顶层 runtime query/action consumer 与 automation 输出 |
| `newSessionCli.ts` · `resumeCli.ts` · `main.ts` | 入口 |

### 2.1 当前架构边界

dynamic TTY 只有一个 component tree、一个 `BoloTerminalAdapter`、一个 raw stdin
owner 和一个 terminal writer。SessionEvent 先进入 shared `CliTuiViewState`，再由
retained transcript/activity/composer/footer/OverlayHost 读取；renderer 不重建
tool/search/resume 业务状态。所有 block 先按 viewport 计算物理行，resize 从原始文本
重排，局部组件不直接发送 cursor/erase 序列。

non-TTY、pipe、JSON、`--print` 和 raw-mode 不可用宿主走独立 plain/readline 路径。
这条兼容边界不使用 dynamic renderer，也不代表存在第二套 TTY surface。OI-14H 已物理
删除 compatibility bridge、legacy pager/picker/panel、`TerminalSurface`、raw editor/
spacer、字符串 prefix/tiny Markdown 与 engine selector；ownership/absence 门禁禁止
它们重新接回生产路径。

自动化由 `@xterm/headless` 覆盖 cell auto-wrap、双宽字符、scrollback、24–220 列
resize、stream/paste/overlay、故障注入、cleanup 与性能预算。仍无法替代的只有真实
Windows Terminal 字体、颜色、动画主观流畅度和真人按键/鼠标手感，见 OI-H3。

---

## 3. 会话交互（OI-14 retained 当前契约）

以下交互由 retained dynamic TTY 与独立 plain fallback 共同守护。slash、context、
paste、Thought、权限与非 TTY 行为都进入默认门禁。

### 3.1 欢迎首页

默认欢迎页使用 `bolo-logo-tui.txt` 的 **Bolo Crystal**，产品名/version 嵌入顶边框。
96 列以上使用完整源稿，并把水晶与 Ready/workspace/model/session/runtime state
组成 Bolo 自有双列工作台；56–95 列与 38–55 列分别使用中型/紧凑水晶和单列状态，
不是复制 Claude 的文案、配色、图标或 action card。图形先去公共缩进，再按整块
最大 cell 宽居中；动态值使用 grapheme cell 宽度裁切，所以 CJK、emoji、长模型名
和长路径不会越界。`BOLO_MASCOT=0` 在宽屏也回落单列，不留下空水晶栏。

欢迎内容由 `resolveTuiWelcomeWidth()` 在超宽终端封顶 100 cells；普通内容页继续由
`resolveTuiFrameWidth()` 封顶 160 cells；用户历史块、composer/status dock 使用
`resolveTuiDockWidth()` 跟随终端可用宽度。正文 gutter 在 24–31 列为 0、
32–47 列为 2、48 列以上为 4；retained transcript 先从 viewport 扣除 gutter，
再给 Markdown 生成的每条物理行加回同一 gutter。transcript、用户块、activity、
composer 与 footer 由同一个常驻 layout tree 计算，terminal auto-wrap 不再绕过
布局账本。
`NO_COLOR` 只移除颜色；`BOLO_ASCII=1` 保留结构并切成 ASCII 字符；
`BOLO_THEME=plain` / `BOLO_PLAIN=1` 才简化为纯文本；`BOLO_MASCOT=0` 只隐藏水晶。

### 3.2 输入

| 键 | 动作 |
|----|------|
| `Enter` | slash 菜单打开且有选中项时补成 `/<name> `；否则发送当前输入 |
| `Ctrl+J` | 插入换行 |
| `←/→` · `Home/End` | 按 grapheme 移动光标 |
| `↑/↓` | slash 菜单打开时循环选择候选；否则浏览本进程最近 100 条输入 |
| `Tab` | slash 菜单打开时补全选中项；否则插入两个空格 |
| `Esc` | 关闭 slash 菜单并保留输入 |
| `Backspace/Delete` | 删除前/后一个 grapheme |
| `Ctrl+A/E` | 整个输入 buffer 首/尾 |
| `Ctrl+U/K/W` | 删除光标前/后/前一个词 |
| `Ctrl+L` | 清屏后重绘输入框 |
| `Ctrl+D` | 空输入退出；非空时删除光标后的字符 |
| `Ctrl+C` | 空闲输入时退出 REPL；turn 运行时请求 interrupt |

整行以单个 `/` 开始、光标位于命令 token 尾部且尚无参数时打开菜单：裸 `/` 显示
可见全量，继续输入按 exact/prefix 过滤；`//`、普通文本和带参数输入不会触发。
内置、CLI-local、Plugin command 与 user-invocable Skill 使用同一菜单，动态来源显示
短标签；无匹配显示明确空态。Tab/Enter 只写回 `/<name> `，第二次 Enter 才走既有
submit/dispatch，reducer 不执行命令副作用。补全后菜单关闭；当输入仍是精确命令和
首个尾随空格、光标位于末尾且尚无实参时，renderer 会显示 candidate 提供的弱化
argument hint。`/effort ` 的 hint 来自当前 provider/model 方言真源；Plugin、Skill
和其它内置命令复用各自 usage。提示只参与显示，不进入 value/cursor；开始输入实参
或第二个空格后立即消失。其它不可见 C0/C1 控制符不会进入输入框。
输入框最多显示四行，菜单默认最多显示六项并随选中项滚动；完整文本与候选仍保留在
state 中。同一 `RetainedComposer` 节点在 idle/running 间只切 mode，
value/cursor/history/undo/menu 保留在 component-local 状态，Pi `CURSOR_MARKER`
定位硬件光标。composer 与 transcript/activity 之间的完整 gap 由父级 retained
layout 负责，因此 turn 完成后最终回答不会贴框。

permission/question/provider/effort/diff/pager 都挂在同一 root 的 OverlayHost；
overlay 期间 Composer 不卸载，输入状态、focus、raw stdin 与 writer owner 不转交。
文本/非动态回落使用明确的 numbered prompt 或 fail-closed 结果，不创建局部 terminal
surface。

adapter 获取 raw stdin 时启用 terminal mode 2004，退出、提交和 abort 时恢复。收到
`paste-start` 后跨 data chunk 聚合正文，到 `paste-end` 才规范化 CRLF/CR 并调用一次
`insertText()`、重绘一次；marker 不进入输入 state，粘贴中的换行也不会触发 submit。
不支持 bracketed paste 的普通按键/文本路径保持原行为。

### 3.3 Turn 时间线

| 时点 / 事件 | 人类可见结果 |
|-------------|--------------|
| 提交普通消息 | 立即进入与 composer 同宽的背景用户消息块；不等 provider 首 token |
| provider 尚未输出 | `✦/✧/✶/✧ Thinking · 本段耗时 · Ctrl+C interrupt` 原位刷新 |
| reasoning / silent provider wait | 当前段持续动画；边界到达后留下 `Thought for <duration>`，即使 provider 未发送可见 reasoning delta |
| `tool_start/end` | 进入永久工具时间线；结束后回到 Thinking |
| `tool_progress` | 只在 activity 原位更新“工具名 · 进度”，不把每个 tick 刷成永久消息 |
| assistant text | 正文所有物理续行保留稳定 gutter；完整 block Markdown 在当前 width 重排 |
| turn 完成 | 清掉活动行并把常驻 composer 从 running 切回 idle；共享 gap 保留，不冒充输出总思考耗时 |
| slash command | 回显用户命令但不启动虚假的模型 Thinking |
| composer footer | 按宽度保留 model/mode/effort、高亮按键与 `↓input ↑output`；估算 usage 加 `~` |

activity 使用确定性 `✦ → ✧ → ✶ → ✧` 状态帧，每 250ms 更新 glyph 与本段耗时；model、
tool、search、retry 切换会重置段起点，同一 reasoning chunk 不会误重置。每帧把
当前完整状态交给同一 `turnActivity` 状态机，再只更新 `RetainedActivity` child，
由根 renderer 合并帧，因此不会先清空整行再绘制或产生第二 writer。每帧仍读取
当前终端列宽，完整文案放不下时依次退化为紧凑/最小文案，避免自动换行残影。
`NO_COLOR` 只移除 SGR。永久 Thought 的资格由 activity 是否交回已结束 thinking
segment elapsed 决定，不再依赖是否展示过 reasoning 文本；消费后清空段状态，所以
正文的后续 chunk 或 `endTurn` 不会重复打印。

### 3.4 Context 仪表盘

- `/context` 先在 core 建立 `ContextUsageViewModel`。TTY CLI 渲染响应式使用率图、
  已用/可用窗口、阈值、pressure、model/effort 和主要分类；数据源明确标为
  `actual`、`estimated` 或 `hybrid`，不会把估算冒充 provider 精确 usage。
- 24/38/80/160 列分别使用窄屏分行或宽屏概览；CJK/emoji、ANSI/`NO_COLOR` 都按
  terminal cell 宽度约束。dashboard 使用正文 gutter 后的可用宽度。
- 非 TTY 输出同一 view-model 的紧凑纯文本。`/context details` 与
  `/context --details` 保留 sections、skills、memory、cache、prepare/compact 等
  完整诊断，不把诊断 dump 塞回默认概览。

### 3.5 权限与临时面板

- 非文件工具默认进入三态面板：**Allow once**、**Always allow this tool for this
  session**、**Deny**；默认选中 Deny，可用 `↑/↓`、数字或 `y/a/n`。
- Bash 显示实际 command、cwd、foreground/background 和生效 timeout；未知 input
  只做有界、安全的键值摘要，不泄漏 secret。
- Always 的真实作用域是“本会话后续同名工具”，不是“只记住这一条命令”。
- 文件变更继续使用可滚 Diff view-model，不复制 diff 算法。
- arrow/diff/question/permission 都通过同一 OverlayHost 渲染，不直接发送
  `ESC[2J` 或全局 Home。用户主动 `Ctrl+L` 仍保留明确的清屏语义。
- 非 TTY、abort 或面板不可用时保持 fail-closed，并保留兼容文本路径。

### 3.6 输出边界

- 动态时间线只在 `shouldUseDynamicTui()` 为真时启用。
- pipe、JSON、`-p`/`--print` 与 raw-mode 不可用的 fallback 不输出动态 activity、清行、
  cursor move 或用户回显，旧自动化无需清洗 TUI。
- `formatSessionEventChunks()` 等追加式 plain formatter 继续保留；retained 时间线复用事件语义，
  不在 CLI 重建 core 状态机。
- 当前已实现会话输入框内的 slash completion；尚无 PowerShell/Bash 外壳级 shell
  completion、鼠标输入或跨进程持久命令历史，它们不是 OI-10 的完成条件。

---

## 4. Runtime query pager（AR1C）

`bolo runtime list|inspect` 的 renderer 只消费共享 `RuntimeQueryView`，不会读取 coordinator、provider 或 session 私有对象。分页状态、终端尺寸、filter 和 cursor 只存在当前函数调用栈，不写入 snapshot、protocol、JSONL 或磁盘。

只有 text 模式、stdin/stdout 都是 TTY 且渲染结果超过一页时才读键：

| 动作 | 键 / 结果 |
|------|-----------|
| 下一页 | `n` · `j` · `↓` · `→` |
| 上一页 | `p` · `k` · `↑` · `←` |
| 正常退出 | `q` · `Esc` · EOF；exit 0 |
| 中断 | `Ctrl-C`；exit 130 |
| reader/driver 错误 | `pager_failed`；exit 1 |

0/1 页直接输出，不等待键盘。多页 pager 复用
`packages/shared/src/runtimePager.ts` 的 reducer，并使用 standalone retained
OverlayHost，不发送整屏 `ESC[2J`。data、end、error、abort/Ctrl-C 的全部终态都移除
listener，并把 stdin raw mode 恢复到进入前状态。

pipe 与 `--json` 永不启用 pager、永不读取 stdin，也不输出 ANSI、clear-screen、banner 或 summary。JSON query success 保留原始 `runtime.list|runtime.inspect` view；failure 固定为 `{ok:false,code,detail}`。JSON usage failure 只向 stdout 输出一个 payload、stderr 为空并 exit 2。

---

## 5. Diff 展示水位

| 层 | 状态 | 说明 |
|----|------|------|
| 文本 dump `/diff` · tool_end ANSI | ✅ D7 | 轨 A |
| 权限 preview 多行着色 | ✅ D7 | 回落文本路径 |
| **可滚 Diff 面板** | ✅ U1 | TTY `/diff` · `BOLO_DIFF_PANEL=0` 关 |
| **Provider 箭头选择** | ✅ P4.1 | TTY `/provider` · `BOLO_PROVIDER_PANEL=0` 关 |
| **Effort 箭头选择** | ✅ E8 | TTY `/effort` · `BOLO_EFFORT_PANEL=0` 关 |
| **ask 内嵌可滚 preview** | ✅ U2 | `y/a/N` · `BOLO_PERM_DIFF_PANEL=0` 关 |
| **写后可折叠 cell** | ✅ U3 | 默认折叠 · `BOLO_DIFF_CELL=expand` 展开 · Desktop `<details>` |
| **行号 / 主题 / 轻量语法** | ✅ U4 | `diffRender.ts` · `BOLO_DIFF_GUTTER` · `BOLO_DIFF_SYNTAX` · `BOLO_DIFF_THEME` |
| 真·React Ink 依赖 | 📋 U5 可选 | 非默认 |

---

## 6. U 轨挂载点

```text
packages/core/src/diffViewModel.ts   ← U0 VM · approve 键
packages/core/src/fileChangeCell.ts  ← U3 写后 history cell
packages/cli/src/tui/
  diffPane.ts           ← U1 browse · U2 approve
  askPermissionTty.ts   ← U2：files preview → 审批面板
  formatSessionEvent.ts ← U3：折叠/展开 cell
apps/desktop/renderer   ← U3：`<details>` cell · 权限 files 列表
```

**环境：**

| 变量 | 作用 |
|------|------|
| `BOLO_DIFF_PANEL=0` | `/diff` 强制纯文本 |
| `BOLO_PROVIDER_PANEL=0` | `/provider` 强制纯文本（不开箭头选） |
| `BOLO_EFFORT_PANEL=0` | `/effort` 强制纯文本（不开箭头选） |
| `BOLO_EFFORT_LOOSE=1` | `/effort` 允许 fold 别名（非 choosable 严格） |
| `BOLO_EFFORT_ALLOW_MAX=1` | 放开 Anthropic max 模型门控 |
| `BOLO_ARROW_PICKER=0` | 禁用全部箭头 picker |
| `BOLO_PERM_DIFF_PANEL=0` | 权限 ask 不用审批面板（仅文本 y/a/N） |
| `BOLO_DIFF_CELL=expand` | 写后 cell 默认展开（或 `BOLO_DIFF_VERBOSE=1`） |
| `BOLO_DIFF_CELL=fold` | 强制折叠（默认） |
| `BOLO_DIFF_GUTTER=0` | 关闭旧/新行号 gutter（默认开） |
| `BOLO_DIFF_SYNTAX=0` | 关闭轻量关键字/字符串高亮（默认开，plain 主题关） |
| `BOLO_DIFF_THEME` / `BOLO_THEME` | `default` · `dim` · `plain`（兼听 `NO_COLOR`） |
| `BOLO_TUI_INPUT=0` | 关闭动态输入、activity 与时间线，使用 readline fallback |
| `BOLO_TUI_LAYOUT=0` | 关闭 TUI layout/dynamic path |
| `BOLO_ASCII=1` | 欢迎页图形和分隔符使用 ASCII |

**约束：**

- 数据只来自 core/tools 已有契约（`fileDiffLog` / preview / git / meta）。  
- 非 TTY：禁止挂起面板，回落纯文本。  
- 不引入 ratatui / tree-sitter；真·Ink 仅 U5 评估。

**键位：**

| 模式 | 键 |
|------|-----|
| browse (`/diff`) | `j/k` 选文件 · `Enter` 展开 · `h` 返回 · `q` 退出 |
| approve (ask) | 同上浏览 · **`y` allow once · `a` always · `n`/`q` deny** |

**测试：**

```bash
npx tsx scripts/test-diff-view.ts
npx tsx scripts/test-diff-render.ts
npx tsx scripts/test-file-diff.ts
```

---

## 7. 与 Electron

- Desktop **不**实现第二套 diff 算法。  
- U3：renderer 消费与 CLI 相同的 `DiffViewModel` JSON（IPC）。  
- 当前：权限 `summaryText`（+ 可选 files 字段）+ tool_end 多行。

---

## 8. 测试

```bash
npm test
npm run test:cli-tui
npm run test:context-dashboard
npm run test:cli-terminal-surface
npm run test:cli-tui-vt
npm run test:cli-timeline-hierarchy
npm run test:cli-thinking-segments
npm run test:cli-permission-panel
npm run test:cli-local-panels
npm run test:cli-crystal-identity
npm run test:cli-events
npm run test:cli
npm run test:cli-first-run
npm run test:slash-completion
npm run test:runtime-cli-renderer
npm run test:runtime-cli-pager
npm run test:runtime-cli-automation
node --import tsx/esm scripts/test-full-track.ts
node --import tsx/esm scripts/test-product-track.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/test-diff-view.ts
```

既有专项分别覆盖持久 dock/历史追加、响应式逻辑 gutter/dock-width 用户块/status footer、
分段计时、权限详情与三态选择、局部 VT 重绘、水晶源稿/三档/ASCII/NO_COLOR 与
单文件 dist 嵌入。`test:cli-tui` 继续覆盖 grapheme/CJK/emoji、输入/slash reducer、
argument hint、bracketed paste 生命周期/跨 chunk/CRLF/单次重绘、菜单窗口与非 TTY
回落；`test:context-dashboard` 覆盖 view-model 的 24/38/80/160 列 TTY 投影；
`test:slash-completion` 覆盖内置/Plugin/Skill projection、动态 effort、重名、
hidden alias、exact/prefix 与空匹配。完整门禁当前包含 **134** 个串联
`scripts/*.ts`。

OI-14B 新增的 `test:cli-tui-view-state` 覆盖稳定 turn/segment/call-id、reasoning 与
assistant 多段顺序、tool/search 原位更新、citation 去重、error/abort、resume、
composer/overlay 与 per-segment elapsed；整段、逐字符和固定随机 chunk 的最终 state
深相等。编译期护栏还证明三条真实事件源可直接投影。

OI-14C 新增、并在 H 迁移后的 `test:cli-tui-retained` 覆盖稳定 root identity、
唯一 writer、同步 render epoch、scrollback 保留、24/38/56/80/120/160/220 列
物理宽度、resize、plain byte snapshot 与 new/resume lifecycle。Pi 只通过精确构建
子模块进入单文件，Editor、ProcessTerminal 与 native loader 均未进入产物。

OI-14D 新增的 `test:cli-tui-transcript` 覆盖稳定 block component identity、
User/Assistant/Thought/Tool/Search/Error/Warning/Summary 投影，whole/character/
fixed-random chunk、24/31/32/47/48/80/120/160/220 列、resize、resume、burst 合并，
以及 list/nested list/blockquote/code/table、URL、CJK/emoji、ANSI/OSC 8。Pi
Markdown 与 `marked@18.0.5` 已进入单文件；Editor、ProcessTerminal、terminal/native
modifier 路径继续由产物门禁禁止。

OI-14E 新增的 `test:cli-tui-composer` 覆盖同一 Composer 的 idle/running identity、
首 token 前可见与完成恢复、slash/argument hint/history/undo、silent/visible
Thought、动画、model/effort/usage footer、硬件光标、24–220 列、resize、跨 chunk
paste、输入 p95、500-char burst、预先 abort、raw-mode 异常回滚与单 writer。
`test:cli-tui-retained` 另用真实 new/resume REPL 证明 stdin/mode-2004 获取释放、
Composer 配置和 ordinary input 不经过 legacy writer。dist 门禁要求 Pi
`keys.js`/`stdin-buffer.js`，并禁止 Editor、ProcessTerminal、terminal/native loader。

OI-14F 新增的 `test:cli-tui-overlays` 用真实 xterm 覆盖 permission 的 command/cwd/
关键参数与 once/always/deny、AskUserQuestion 单选/多选/自由文本、provider/effort
picker、diff browse/approve、runtime pager、窄终端/resize、Esc/Ctrl+C/Ctrl+D/abort、
嵌套拒绝、Composer value/cursor/history/undo/focus 恢复和零 external/concurrent
writer。permission/local-panel/runtime CLI 邻接轨另证明 retained 生产路径不调用
compatibility suspend bridge；F 交付当时默认 legacy 与 plain/pipe/JSON/`--print`
行为不变。

OI-14G 新增并扩展的 `test:cli-tui-reliability`、`test:cli-tui-flush`、
`test:cli-tui-cleanup` 与 `test:cli-tui-budget` 覆盖 500 blocks/10,000 行、
scrollback、24–220 列反复 resize、paste/overlay 往返、render coalescing、turn
final flush、部分启动与 stdin/renderer/provider/tool failure、Abort/SIGINT/raw
Ctrl+C、进程退出 cleanup，以及 bundle/cold-start/CPU/render heap/cleanup retained
预算。完整串实测为 1,727,232 bytes / 200 modules、cold `+50.4ms`、CPU `422ms`、
render heap `+21.0MB`、cleanup retained `+1.5MB`。

OI-14H 新增并扩展 `test:cli-tui-ownership` 与 `test:cli-tui-vt`，物理锁定
compatibility bridge、legacy pager/picker/panel、surface/raw editor/layout/tiny
Markdown 与 engine selector 不存在，并禁止 production 重新取得第二 stdout/stdin
owner。完整门禁现为 134 scripts；单文件 1,691,077 bytes / 195 modules，cold
`+47.0–84.4ms`、CPU `375–672ms`、render heap `+21.0–21.1MB`、
cleanup retained `+1.5MB`，
7-file install、Desktop bundle 与 Electron launch 全绿。

OI-14A 当时的 `test:cli-tui-vt` 使用 `@xterm/headless` 执行真实 cell
auto-wrap/scrollback/resize，覆盖 ANSI、长 URL、CJK/emoji、整段/逐字符/固定随机
chunk、running composer 与 56 -> 38 resize，并稳定捕获四项 legacy 失败签名。
OI-14C 已让 retained welcome/root 的宽度、resize 与 scrollback 基座转绿；OI-14D
已让 Markdown list/code/table、OSC 8、transcript physical gutter/spacing 及
chunk/resize/resume 同值转绿；OI-14E 已让 Composer/activity/footer 与输入生命周期
转绿；OI-14F 已让 OverlayHost 与全部交互面板转绿；OI-14G 已关闭 default 与自动化
可靠性/性能矩阵；OI-14H 已把该 fixture 迁为 legacy 模块物理缺失门禁，并完成最终
静态 owner guard；见
[CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) §9 和
[CLI_TUI_RENDERER_DECISION.md](./CLI_TUI_RENDERER_DECISION.md)。

**仍需真人验收：** Windows Terminal 中的字体观感、实际光标位置、窗口 resize、
鼠标/剪贴板真实多行粘贴、Ctrl+J/历史/删除组合键、权限切换和长回答滚动。自动测试
与静态快照不能替代肉眼/真人按键，见 [OPEN_ISSUES.md](./OPEN_ISSUES.md) OI-H3。

---

## 9. 后置 / 非目标

| 项 | 说明 |
|----|------|
| 盲选 React Ink/OpenTUI/Pi coding-agent 整站 | 不搬重量级产品；只采用许可、Node/esbuild/Windows spike 通过的 renderer 基座与公共组件 |
| ratatui / Rust TUI | 不做 |
| IDE `useDiffInIDE` | 产品后置 |
| 遥测 | 永不 |
