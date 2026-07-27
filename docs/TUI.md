# CLI TUI

> 无遥测。品牌见 `docs/BRAND.md`。  
> **现状：** OI-09/OI-10 零运行时依赖 TTY controller：响应式 Bolot 欢迎页 ·
> 共享 frame 的真实输入框 · slash 菜单/补全 · 原子多帧 turn 活动态 · 结构化时间线 ·
> 箭头 picker · Diff/权限面板。
> **框架选择：** 没有依赖 React Ink；完成标准是交互和输出契约，不是框架名称。
> Diff 轨见 [ROADMAP.md](./ROADMAP.md) §3 ·
> [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) 轨 B。

---

## 1. 模式（已有）

| 条件 | 行为 |
|------|------|
| stdin/stdout 双 TTY + stdin 支持 raw mode | 响应式品牌欢迎页 + 真实输入框 + 动态 Thinking/Running 时间线 |
| TTY 但 raw mode 不可用 | 回落 readline `bolo>`；不发送动态光标控制 |
| 非 TTY / pipe / `-p` / `--print` | 追加式纯文本；不回显伪输入框、不挂起等按键 |
| `NO_COLOR` | 关闭 SGR 颜色，保留欢迎页结构与真实输入能力 |
| `BOLO_PLAIN=1` / `BOLO_THEME=plain` | 关闭颜色并简化欢迎区；真实输入能力仍可用 |
| `BOLO_TUI_INPUT=0` | 关闭动态输入/时间线，回落 readline |
| `BOLO_TUI_LAYOUT=0` / `TERM=dumb` | 关闭 layout 与动态路径，回落 readline |
| `>=96` 列 | 欢迎页使用 Bolot/环境与行动/会话双栏 |
| `56–95` 列 | 欢迎页使用完整 Bolot 单栏 |
| `38–55` 列 | 欢迎页使用一行 Bolot 紧凑框；输入、消息和 activity 继续按 cell 宽度裁切/折行 |
| `<38` 列 | 欢迎页回落无边框纯文本，避免最小终端破框 |
| `BOLO_MASCOT=0` | 隐藏欢迎页 Bolot，保留品牌字标和环境/行动信息 |
| `--resume` 无 id | **箭头键 picker**（↑↓ Enter；`BOLO_ARROW_PICKER=0` 用编号） |
| 非 TTY resume | 表格式列表 + 要求 `--resume <id>` |
| `runtime list\|inspect` + stdin/stdout 双 TTY + 多页 | 进入轻量 runtime pager |
| runtime pipe / `--json` / 空结果或单页 | 一次性完整输出；不启 pager、不读 stdin |

---

## 2. 模块（已有）

| 文件 | 角色 |
|------|------|
| `tui/inkLayout.ts` | 一次性响应式品牌/workspace 欢迎页；绝不伪装成输入框 |
| `tui/frame.ts` | 欢迎页、输入框与用户消息共用的终端 frame width 契约 |
| `tui/inputBox.ts` | 输入/slash reducer、CJK-safe 菜单 renderer、短生命周期 raw-mode driver |
| `tui/terminalText.ts` | ANSI/CJK/emoji grapheme cell 宽度、裁切、补齐与折行 |
| `tui/turnActivity.ts` | 首 token 前与工具间隙的 Thinking/Running/elapsed 单行状态 |
| `tui/terminalMarkdown.ts` | 流式 inline emphasis/code renderer |
| `tui/arrowPicker.ts` | F-T8：↑↓ 选择 |
| `tui/theme.ts` | F-T9：主题 |
| `tui/banner.ts` · `statusLine.ts` | 启动/状态 |
| `tui/formatSessionEvent.ts` | user/reasoning/tool/assistant 时间线 · tool_end 摘要 |
| `tui/diffPane.ts` | U1 browse · U2 approve 面板 |
| `tui/askPermissionTty.ts` | 权限 y/a/N；有 files 时进审批面板 |
| `packages/core/src/runtimeTextView.ts` | AR1C：纯 runtime text page renderer；CLI 与 slash 共用 |
| `tui/runtimePager.ts` | AR1C：页状态 reducer · raw key reader · TTY pager driver |
| `slashCandidates.ts` | core 候选与 CLI-local `/exit`/`/quit` 的无副作用合并层 |
| `runtimeCli.ts` | AR1：顶层 runtime query/action consumer 与 automation 输出 |
| `newSessionCli.ts` · `resumeCli.ts` · `main.ts` | 入口 |

---

## 3. 会话交互（OI-09/OI-10）

### 3.1 欢迎首页

默认欢迎页使用 Bolo Code 青色强调、灰色边框和原创河豚 **Bolot**。宽屏左栏负责
欢迎语、吉祥物、model/workspace，右栏负责 Start here、当前会话和常用命令；
中宽度改为完整单栏，紧凑宽度改为一行 Bolot。所有动态文本都先移除外来 ANSI，
再按 grapheme cell 宽度裁切/补齐，所以 CJK、emoji、长模型名和长路径不会破框。
欢迎页、输入框与用户消息统一通过 `resolveTuiFrameWidth()` 计算外框；超宽终端共同
封顶 160 列并保留两列 gutter，不再出现上框 160、输入框 120 的右缘错位。

`NO_COLOR` 只移除颜色，不删除结构；`BOLO_THEME=plain` / `BOLO_PLAIN=1` 才显式
简化为纯文本。`BOLO_MASCOT=0` 只隐藏 Bolot，不影响环境与会话信息。

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
submit/dispatch，reducer 不执行命令副作用。其它不可见 C0/C1 控制符不会进入输入框。
输入框最多显示四行，菜单默认最多显示六项并随选中项滚动；完整文本与候选仍保留在
state 中。每次 turn 开始前 raw editor 都会释放 stdin，权限/picker/`Ctrl+C` 不与
空闲输入 listener 竞争。

### 3.3 Turn 时间线

| 时点 / 事件 | 人类可见结果 |
|-------------|--------------|
| 提交普通消息 | 立即以 `❯` 回显用户消息；不等 provider 首 token |
| provider 尚未输出 | `✦/✧/✶/✧ Thinking · elapsed · Ctrl+C interrupt` 原位刷新 |
| reasoning | `◇ Thinking` 段；`/thinking off` 可关闭 |
| `tool_start/end` | 进入永久工具时间线；结束后回到 Thinking |
| `tool_progress` | 只在 activity 原位更新“工具名 · 进度”，不把每个 tick 刷成永久消息 |
| assistant text | `● Bolo` 角色头；inline `**bold**` / `` `code` `` 不再原样泄露 |
| turn 完成 | 清掉活动行并显示 `Done · elapsed`；随后重新出现输入框 |
| slash command | 回显用户命令但不启动虚假的模型 Thinking |

activity 使用确定性 `✦ → ✧ → ✶ → ✧` 状态帧，每 250ms 更新 glyph 与耗时；每帧把
`\r + 完整状态行 + erase-to-end` 合成一次 writer 调用，不再先清空整行再绘制，
因此不会周期性出现空白帧。每帧仍读取当前终端列宽，完整文案放不下时依次退化为
紧凑/最小文案，避免自动换行残影。`NO_COLOR` 只移除 SGR，不移除必要的
cursor-control。

### 3.4 输出边界

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

**约束：**

- 数据只来自 core/tools 已有契约（`fileDiffLog` / preview / git / meta）。  
- 非 TTY：禁止挂起面板，回落纯文本。  
- 不引入 ratatui / tree-sitter；真·Ink 仅 U5 评估。

**键位：**

| 模式 | 键 |
|------|-----|
| browse (`/diff`) | `j/k` 选文件 · `Enter` 展开 · `h` 返回 · `q` 退出 |
| approve (ask) | 同上浏览 · **`y` allow · `a` always · `n`/`q` deny** |

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
npm run test:cli-events
npm run test:cli
npm run test:cli-first-run
npm run test:runtime-cli-renderer
npm run test:runtime-cli-pager
npm run test:runtime-cli-automation
node --import tsx/esm scripts/test-full-track.ts
node --import tsx/esm scripts/test-product-track.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/test-diff-view.ts
```

`test:cli-tui` 覆盖 grapheme/CJK/emoji cell 宽度、输入/slash reducer、菜单可视窗口、
raw-mode 清理、共享 frame、宽/中/紧凑欢迎页、Bolot/NO_COLOR、24 列输入菜单、
首 token gate、多帧活动符号与原子 writer、Thinking/Running、warning 恢复和非 TTY
追加式输出。`test:slash-completion` 覆盖内置/Plugin/Skill projection、重名、
hidden alias、exact/prefix 与空匹配。完整门禁当前包含 114 个 `scripts/*.ts`。

**仍需真人验收：** Windows Terminal 中的字体观感、实际光标位置、窗口 resize、
Ctrl+J/历史/删除组合键和长回答滚动。自动测试与静态快照不能替代肉眼/真人按键，
见 [OPEN_ISSUES.md](./OPEN_ISSUES.md) OI-H3。

---

## 9. 后置 / 非目标

| 项 | 说明 |
|----|------|
| React Ink 整站 REPL | 当前零依赖 controller 已满足 OI-09；只有出现可复现能力缺口才按 AR4 重开 |
| ratatui / Rust TUI | 不做 |
| IDE `useDiffInIDE` | 产品后置 |
| 遥测 | 永不 |
