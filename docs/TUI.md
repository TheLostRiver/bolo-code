# CLI TUI

> 无遥测。品牌见 `docs/BRAND.md`。  
> **现状：** OI-09 零运行时依赖 TTY controller：真实输入框 · turn 活动态 ·
> 结构化时间线 · 箭头 picker · Diff/权限面板。
> **框架选择：** 没有依赖 React Ink；完成标准是交互和输出契约，不是框架名称。
> Diff 轨见 [ROADMAP.md](./ROADMAP.md) §3 ·
> [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) 轨 B。

---

## 1. 模式（已有）

| 条件 | 行为 |
|------|------|
| stdin/stdout 双 TTY + stdin 支持 raw mode | 紧凑欢迎区 + 真实输入框 + 动态 Thinking/Running 时间线 |
| TTY 但 raw mode 不可用 | 回落 readline `bolo>`；不发送动态光标控制 |
| 非 TTY / pipe / `-p` / `--print` | 追加式纯文本；不回显伪输入框、不挂起等按键 |
| `NO_COLOR` | 关闭 SGR 颜色；真实输入能力仍可用 |
| `BOLO_PLAIN=1` / `BOLO_THEME=plain` | 关闭颜色并简化欢迎区；真实输入能力仍可用 |
| `BOLO_TUI_INPUT=0` | 关闭动态输入/时间线，回落 readline |
| `BOLO_TUI_LAYOUT=0` / `TERM=dumb` | 关闭 layout 与动态路径，回落 readline |
| 窄终端 | 欢迎区降级为三行文本；输入、用户消息与 activity 按 cell 宽度裁切/折行 |
| `BOLO_MASCOT=0` | 仅影响显式启用的旧 banner；OI-09 默认欢迎区本来就没有 mascot |
| `--resume` 无 id | **箭头键 picker**（↑↓ Enter；`BOLO_ARROW_PICKER=0` 用编号） |
| 非 TTY resume | 表格式列表 + 要求 `--resume <id>` |
| `runtime list\|inspect` + stdin/stdout 双 TTY + 多页 | 进入轻量 runtime pager |
| runtime pipe / `--json` / 空结果或单页 | 一次性完整输出；不启 pager、不读 stdin |

---

## 2. 模块（已有）

| 文件 | 角色 |
|------|------|
| `tui/inkLayout.ts` | 一次性紧凑身份/workspace 欢迎区；绝不伪装成输入框 |
| `tui/inputBox.ts` | 输入 reducer、CJK-safe renderer、短生命周期 raw-mode driver |
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
| `runtimeCli.ts` | AR1：顶层 runtime query/action consumer 与 automation 输出 |
| `newSessionCli.ts` · `resumeCli.ts` · `main.ts` | 入口 |

---

## 3. 会话交互（OI-09）

### 3.1 输入

| 键 | 动作 |
|----|------|
| `Enter` | 发送当前输入 |
| `Ctrl+J` | 插入换行 |
| `←/→` · `Home/End` | 按 grapheme 移动光标 |
| `↑/↓` | 浏览本进程最近 100 条输入 |
| `Backspace/Delete` | 删除前/后一个 grapheme |
| `Ctrl+A/E` | 整个输入 buffer 首/尾 |
| `Ctrl+U/K/W` | 删除光标前/后/前一个词 |
| `Ctrl+L` | 清屏后重绘输入框 |
| `Ctrl+D` | 空输入退出；非空时删除光标后的字符 |
| `Ctrl+C` | 空闲输入时退出 REPL；turn 运行时请求 interrupt |

Tab 规范为两个空格；其它不可见 C0/C1 控制符不会进入输入框。输入框最多显示四行并
围绕光标滚动，长文本仍完整保留在 state 中。每次 turn 开始前 raw editor 都会释放
stdin，权限/picker/`Ctrl+C` 不与空闲输入 listener 竞争。

### 3.2 Turn 时间线

| 时点 / 事件 | 人类可见结果 |
|-------------|--------------|
| 提交普通消息 | 立即以 `❯` 回显用户消息；不等 provider 首 token |
| provider 尚未输出 | `Thinking · elapsed · Ctrl+C interrupt` 原位刷新 |
| reasoning | `◇ Thinking` 段；`/thinking off` 可关闭 |
| `tool_start/end` | 进入永久工具时间线；结束后回到 Thinking |
| `tool_progress` | 只在 activity 原位更新“工具名 · 进度”，不把每个 tick 刷成永久消息 |
| assistant text | `● Bolo` 角色头；inline `**bold**` / `` `code` `` 不再原样泄露 |
| turn 完成 | 清掉活动行并显示 `Done · elapsed`；随后重新出现输入框 |
| slash command | 回显用户命令但不启动虚假的模型 Thinking |

activity 每帧读取当前终端列宽，完整文案放不下时依次退化为紧凑/最小文案，保证动态
单行不会因自动换行留下残影。`NO_COLOR` 只移除 SGR，不移除必要的 cursor-control。

### 3.3 输出边界

- 动态时间线只在 `shouldUseDynamicTui()` 为真时启用。
- pipe、JSON、`-p`/`--print` 与 raw-mode 不可用的 fallback 不输出 spinner、清行、
  cursor move 或用户回显，旧自动化无需清洗 TUI。
- `formatSessionEventChunks()` 等旧追加式 formatter 继续保留；新时间线复用事件语义，
  不在 CLI 重建 core 状态机。
- 当前没有 shell completion、鼠标输入或跨进程持久命令历史；它们不是 OI-09 的完成
  条件。

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

`test:cli-tui` 覆盖 grapheme/CJK/emoji cell 宽度、输入 reducer、raw-mode 清理、宽窄
输入框、首 token gate、Thinking/Running、NO_COLOR、warning 恢复和非 TTY
追加式输出。完整门禁当前包含 113 个 `scripts/*.ts`。

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
