# CLI TUI

> 无遥测。品牌见 `docs/BRAND.md`。  
> **现状：** Ink **等价**布局 · 箭头 picker · 主题/吉祥物（**未**依赖 React Ink）。  
> **规划：** Diff **交互面板**见 [ROADMAP.md](./ROADMAP.md) §3 · [FILE_DIFF_SPEC.md](./FILE_DIFF_SPEC.md) 轨 B。

---

## 1. 模式（已有）

| 条件 | 行为 |
|------|------|
| 默认 TTY | `renderInkLayout` 框式欢迎/状态/输入提示（`BOLO_TUI_LAYOUT=0` 关） |
| plain / `NO_COLOR` / `BOLO_PLAIN` / 窄终端 / `BOLO_THEME=plain` | 单行 banner |
| `BOLO_MASCOT=0` | 去掉 Bolot 行 |
| `--resume` 无 id | **箭头键 picker**（↑↓ Enter；`BOLO_ARROW_PICKER=0` 用编号） |
| 非 TTY resume | 表格式列表 + 要求 `--resume <id>` |

---

## 2. 模块（已有）

| 文件 | 角色 |
|------|------|
| `tui/inkLayout.ts` | F-T8：文本框布局（非 React Ink） |
| `tui/arrowPicker.ts` | F-T8：↑↓ 选择 |
| `tui/theme.ts` | F-T9：主题 |
| `tui/banner.ts` · `statusLine.ts` | 启动/状态 |
| `tui/formatSessionEvent.ts` | 流式事件 · tool_end 摘要 |
| `tui/diffPane.ts` | U1 browse · U2 approve 面板 |
| `tui/askPermissionTty.ts` | 权限 y/a/N；有 files 时进审批面板 |
| `newSessionCli.ts` · `resumeCli.ts` · `main.ts` | 入口 |

---

## 3. Diff 展示水位

| 层 | 状态 | 说明 |
|----|------|------|
| 文本 dump `/diff` · tool_end ANSI | ✅ D7 | 轨 A |
| 权限 preview 多行着色 | ✅ D7 | 回落文本路径 |
| **可滚 Diff 面板** | ✅ U1 | TTY `/diff` · `BOLO_DIFF_PANEL=0` 关 |
| **Provider 箭头选择** | ✅ P4.1 | TTY `/provider` · `BOLO_PROVIDER_PANEL=0` 关 |
| **ask 内嵌可滚 preview** | ✅ U2 | `y/a/N` · `BOLO_PERM_DIFF_PANEL=0` 关 |
| **写后可折叠 cell** | ✅ U3 | 默认折叠 · `BOLO_DIFF_CELL=expand` 展开 · Desktop `<details>` |
| **行号 / 主题 / 轻量语法** | ✅ U4 | `diffRender.ts` · `BOLO_DIFF_GUTTER` · `BOLO_DIFF_SYNTAX` · `BOLO_DIFF_THEME` |
| 真·React Ink 依赖 | 📋 U5 可选 | 非默认 |

---

## 4. U 轨挂载点

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
| `BOLO_ARROW_PICKER=0` | 禁用全部箭头 picker |
| `BOLO_PERM_DIFF_PANEL=0` | 权限 ask 不用审批面板（仅文本 y/a/N） |
| `BOLO_DIFF_CELL=expand` | 写后 cell 默认展开（或 `BOLO_DIFF_VERBOSE=1`） |
| `BOLO_DIFF_CELL=fold` | 强制折叠（默认） |
| `BOLO_DIFF_GUTTER=0` | 关闭旧/新行号 gutter（默认开） |
| `BOLO_DIFF_SYNTAX=0` | 关闭轻量关键字/字符串高亮（默认开，plain 主题关） |
| `BOLO_DIFF_THEME` / `BOLO_THEME` | `default` · `dim` · `plain`（兼听 `NO_COLOR`） |

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

## 5. 与 Electron

- Desktop **不**实现第二套 diff 算法。  
- U3：renderer 消费与 CLI 相同的 `DiffViewModel` JSON（IPC）。  
- 当前：权限 `summaryText`（+ 可选 files 字段）+ tool_end 多行。

---

## 6. 测试

```bash
node --import tsx/esm scripts/test-full-track.ts
node --import tsx/esm scripts/test-product-track.ts
npx tsx scripts/test-file-diff.ts
npx tsx scripts/test-diff-view.ts
```

---

## 7. 后置 / 非目标

| 项 | 说明 |
|----|------|
| 真·React Ink 整站 REPL | U5 可选；成本高 |
| ratatui / Rust TUI | 不做 |
| IDE `useDiffInIDE` | 产品后置 |
| 遥测 | 永不 |