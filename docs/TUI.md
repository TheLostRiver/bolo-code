# CLI TUI

> 无遥测。品牌见 `docs/BRAND.md`。  
> **现状：** OI-09–OI-13 已建立 Bolo 水晶、slash 菜单/参数提示、`/context`、paste
> 事务、分段 Thinking/Thought、权限详情与非 TTY fallback 等业务能力；但后续真实
> Windows Terminal 截图已确认当前 direct-write surface 会出现正文碎片、巨大空洞、
> 物理续行贴左和 cursor/layout 漂移。系统性修复已重开为 **OI-14**。
> **框架选择：** 采用成熟 retained-mode renderer，不再继续扩展自研
> `TerminalSurface + contentPrefixer + tiny Markdown`。Pi TUI 为首选基座，最终
> direct/fork 形态由 Node/esbuild/Windows/许可证 spike 决定；见
> [CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md)。
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
| `tui/crystalLogo.ts` | 水晶常量、源稿归一化、整块 cell-width 居中与 ASCII 降级 |
| `tui/inkLayout.ts` | 一次性水晶工作台；宽屏 split、中/紧凑单列，不伪装成输入框 |
| `tui/frame.ts` | 100-cell welcome、160-cell content 与全宽 dock 三套明确宽度契约 |
| `tui/contentLayout.ts` | **legacy**：只识别逻辑换行的 gutter prefixer；OI-14 将由 block layout 替代 |
| `tui/contextDashboard.ts` | core `ContextUsageViewModel` 的响应式 TTY 仪表盘 |
| `tui/inputBox.ts` | 输入/slash reducer、argument hint、CJK-safe renderer、bracketed-paste raw driver、running dock |
| `tui/composerSpacing.ts` | **legacy**：idle/running top-gap 补丁；OI-14 将由父级 layout gap 替代 |
| `tui/terminalSurface.ts` | **legacy**：按逻辑行记账的 append/dock surface；不拥有 terminal auto-wrap |
| `tui/localPanel.ts` | **legacy**：局部 erase/repaint；OI-14 将迁入 OverlayHost |
| `tui/terminalText.ts` | 当前字段级 ANSI/CJK/emoji helper；通用 wrap 将迁入成熟 renderer |
| `tui/turnActivity.ts` | reasoning/tool/search/retry 分段生命周期、动画与独立计时 |
| `tui/terminalMarkdown.ts` | **legacy**：只处理 inline emphasis/code；OI-14 将由 block Markdown 替代 |
| `tui/arrowPicker.ts` | F-T8：↑↓ 选择 |
| `tui/theme.ts` | F-T9：主题 |
| `tui/banner.ts` · `statusLine.ts` | 启动/状态 |
| `tui/formatSessionEvent.ts` | user/reasoning/tool/assistant 时间线 · tool_end 摘要 |
| `tui/diffPane.ts` | U1 browse · U2 approve 面板；局部重绘 |
| `tui/permissionPanel.ts` · `askPermissionTty.ts` | command/cwd/关键参数摘要与 once/always/deny 选择 |
| `packages/core/src/runtimeTextView.ts` | AR1C：纯 runtime text page renderer；CLI 与 slash 共用 |
| `tui/runtimePager.ts` | AR1C：页状态 reducer · raw key reader · TTY pager driver |
| `slashCandidates.ts` | core 候选与 CLI-local `/exit`/`/quit` 的无副作用合并层 |
| `runtimeCli.ts` | AR1：顶层 runtime query/action consumer 与 automation 输出 |
| `newSessionCli.ts` · `resumeCli.ts` · `main.ts` | 入口 |

### 2.1 已知架构限制

当前 TTY 路径仍是 event formatter 直接写 stdout。`contentLayout.ts` 只在字符串中的
逻辑行首加 gutter，`TerminalSurface` 只记录 renderer 提供的逻辑行数；超长 URL、
ANSI 或 Markdown 由终端自动折出的额外物理行不进 erase/restore 账本。idle editor、
running dock 和临时面板又分别拥有 cursor 生命周期，因此 provider streaming、dock
重绘或 resize 后可能出现续行贴左、文本碎片和巨大纵向空洞。

现有简化 `TestTerminalScreen` 没有 terminal width/auto-wrap/双宽 cell/resize，过去
的 123 项门禁只证明局部字符串、reducer 和显式 cursor 序列，不能证明物理终端布局。
OI-14A 将先用 `@xterm/headless` 固化真实红灯，再迁移 retained component tree。

---

## 3. 会话交互（OI-09–OI-13 业务契约；OI-14 重建渲染）

以下交互是需要保留的产品契约，不表示当前 legacy renderer 已满足全部物理布局要求。
OI-14 迁移时不得回退 slash、context、paste、Thought、权限与非 TTY 行为。

### 3.1 欢迎首页

默认欢迎页使用 `bolo-logo-tui.txt` 的 **Bolo Crystal**，产品名/version 嵌入顶边框。
96 列以上使用完整源稿，并把水晶与 Ready/workspace/model/session/runtime state
组成 Bolo 自有双列工作台；56–95 列与 38–55 列分别使用中型/紧凑水晶和单列状态，
不是复制 Claude 的文案、配色、图标或 action card。图形先去公共缩进，再按整块
最大 cell 宽居中；动态值使用 grapheme cell 宽度裁切，所以 CJK、emoji、长模型名
和长路径不会越界。`BOLO_MASCOT=0` 在宽屏也回落单列，不留下空水晶栏。

欢迎内容由 `resolveTuiWelcomeWidth()` 在超宽终端封顶 100 cells；普通内容页继续由
`resolveTuiFrameWidth()` 封顶 160 cells；用户历史块、composer/status dock 使用
`resolveTuiDockWidth()` 跟随终端可用宽度。Agent 与 TTY slash 正文在各自 renderer
内再使用响应式 gutter：24–31 列为 0、32–47 列为 2、48 列以上为 4；流式 chunk
当前只在**逻辑**行首添加一次，终端 auto-wrap 的物理续行仍可能绕过 gutter；OI-14
目标是所有 block 在给定 width 内先生成完整物理行，welcome、transcript、用户块与
composer 由同一个 viewport/layout tree 计算。
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
state 中。每次 turn 开始前负责编辑的 raw key listener 会释放 stdin，但
`TerminalSurface` 会把同宽 composer 以 running 状态留在底部；历史输出先临时擦除
dock、追加内容后再恢复，因此输入区不会凭空消失。权限/picker 接管 stdin 时暂时挂起
dock，结束后恢复，不与空闲 listener 竞争。composer 上方一行 spacer 由共享
`composerSpacing` 契约生成：turn 内由 `TerminalSurface` 拥有，turn 结束后的 idle
首帧与输入重绘由 `readTuiInput` 拥有。该行始终与 composer 一起参与 cursor offset、
局部 erase 和 repaint，因此 running → clearDock → idle 交接也不会让最终回答贴框。

上段是 OI-11/OI-13 建立的局部契约；真实截图已经证明它在超长物理行和 streaming
重绘下不能保证整个屏幕。OI-14 将把 Composer 改为同一 retained tree 中的常驻节点，
idle/running/permission 只切 mode，不再销毁 editor 或转移 cursor owner。

raw driver 进入时启用 terminal mode 2004，退出、提交和 abort 时恢复。收到
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
`\r + 完整状态行 + erase-to-end` 合成一次 writer 调用，不再先清空整行再绘制，
因此不会周期性出现空白帧。每帧仍读取当前终端列宽，完整文案放不下时依次退化为
紧凑/最小文案，避免自动换行残影。`NO_COLOR` 只移除 SGR，不移除必要的
cursor-control。永久 Thought 的资格由 activity 是否交回已结束 thinking segment
elapsed 决定，不再依赖是否展示过 reasoning 文本；消费后清空段状态，所以正文的
后续 chunk 或 `endTurn` 不会重复打印。

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
- arrow/diff/question/permission 都通过 `localPanel` 只擦除自己拥有的行；不会发送
  `ESC[2J` 或全局 Home。独立 runtime pager 和用户主动 `Ctrl+L` 仍保留整屏语义。
- 非 TTY、abort 或面板不可用时保持 fail-closed，并保留兼容文本路径。

### 3.6 输出边界

- 动态时间线只在 `shouldUseDynamicTui()` 为真时启用。
- pipe、JSON、`-p`/`--print` 与 raw-mode 不可用的 fallback 不输出动态 activity、清行、
  cursor move 或用户回显，旧自动化无需清洗 TUI。
- `formatSessionEventChunks()` 等旧追加式 formatter 继续保留；新时间线复用事件语义，
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

0/1 页直接输出，不等待键盘。pager 在 data、end、error、abort/Ctrl-C 的全部终态移除 listener，并把 stdin raw mode 恢复到进入前状态。

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
hidden alias、exact/prefix 与空匹配。完整门禁当前包含 **123** 个串联
`scripts/*.ts`。

这些测试不覆盖 terminal auto-wrap、resize reflow 或真实 cell buffer。OI-14 新增的
`test:cli-tui-vt` 必须使用 `@xterm/headless`，覆盖 24/38/56/80/120/160/220 列、
随机 chunk、长 URL/token、Markdown list/code/table、CJK/emoji、ANSI/OSC 8、
running/idle Composer、overlay、scrollback 与 resize。测试矩阵和性能预算见
[CLI_TUI_REFACTOR_PLAN.md](./CLI_TUI_REFACTOR_PLAN.md) §9。

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
