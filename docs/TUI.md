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
| `tui/askPermissionTty.ts` | 权限 y/a/N + preview 文本 |
| `newSessionCli.ts` · `resumeCli.ts` · `main.ts` | 入口 |

---

## 3. Diff 展示水位

| 层 | 状态 | 说明 |
|----|------|------|
| 文本 dump `/diff` · tool_end ANSI | ✅ D7 | 轨 A |
| 权限 preview 多行着色 | ✅ D7 | 仍一次性打印 |
| **可滚 Diff 面板** | ✅ U1 | TTY `/diff` · `BOLO_DIFF_PANEL=0` 关 |
| **ask 内嵌可滚 preview** | 📋 U2 | 轨 B |
| **写后可折叠 cell** | 📋 U3 | 轨 B |
| 真·React Ink 依赖 | 📋 U5 可选 | 非默认 |

---

## 4. U 轨挂载点（规划）

```text
packages/cli/src/tui/
  diffViewModel.ts   ← 可放 core 导出的 VM 适配
  diffPane.ts        ← U1：raw mode 列表+展开（模式类似 arrowPicker）
  diffKeys.ts        ← 键位
  askPermissionTty.ts ← U2：复用 diffPane 子集
formatSessionEvent.ts ← U3：可折叠 cell 标记（或事件字段）
```

**约束：**

- 数据只来自 core/tools 已有契约（`fileDiffLog` / preview / git）。  
- 非 TTY：禁止挂起面板，回落纯文本。  
- 不引入 ratatui；真·Ink 仅 U5 评估。

**键位草案：** 见 FILE_DIFF_SPEC §2.3。

---

## 5. 与 Electron

- Desktop **不**实现第二套 diff 算法。  
- U3：renderer 消费与 CLI 相同的 `DiffViewModel` JSON（IPC）。  
- 当前：权限 `summaryText` + tool_end 多行（D7）。

---

## 6. 测试

```bash
node --import tsx/esm scripts/test-full-track.ts
node --import tsx/esm scripts/test-product-track.ts
npx tsx scripts/test-file-diff.ts
# U0+：scripts/test-diff-view.ts（待加）
```

---

## 7. 后置 / 非目标

| 项 | 说明 |
|----|------|
| 真·React Ink 整站 REPL | U5 可选；成本高 |
| ratatui / Rust TUI | 不做 |
| IDE `useDiffInIDE` | 产品后置 |
| 遥测 | 永不 |