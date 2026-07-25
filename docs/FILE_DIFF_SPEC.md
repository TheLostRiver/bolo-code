# 文件 Diff 规格（对照 HC + Codex）

> 对照 HelsincyCode：`FileEditTool` / `diff.ts` / `useTurnDiffs` / `FileEditToolDiff` / `DiffDialog` / `gitDiff`。  
> 对照 Codex：`create_diff_summary` / `diff_render` / patch history / apply_patch 审批。  
> Bolo：**无遥测**。分 **轨 A 日用契约** 与 **轨 B 交互 UI**。

---

## 0. 双轨水位

| 轨 | 含义 | 水位 | 状态 |
|----|------|------|------|
| **A · 日用** | 写前可见 / 写后可读 / 会话可查 / git / resume | **~95%+** | D0–D7 ✅ |
| **B · 交互 UI** | 可滚面板 / 权限内嵌 / history cell / 行渲染 | **~90–95%** → 目标 **~90%+** | U0–U4 ✅ · U5 可选 |
| 全家桶尾 | 真 Ink · IDE · PR merge-base | 不设 100% | 后置 |

---

## 1. 轨 A · 日用（已完成）

| 阶段 | 交付 | 状态 |
|------|------|------|
| **D0** | 纯函数 hunk + unified + 行数 | ✅ |
| **D1** | Edit / Write `meta.structuredPatch` | ✅ |
| **D2** | apply_patch meta · `fileDiffLog` · `/diff` | ✅ |
| **D3** | 写前 `previewFileToolChange` · ask | ✅ |
| **D4** | ANSI tool_end 摘要 | ✅ |
| **D5** | 本地 `gitDiff` · `/diff git` | ✅ |
| **D6** | transcript `file_diff` · resume | ✅ |
| **D7** | `createDiffSummary` · 默认短 unified · 更密 ask | ✅ |

### 1.1 数据流（A）

```
preview(ask) ──► permission_request.preview
tool success ──► meta ──► fileDiffLog ──► transcript file_diff
                    └──► tool_end summaryLine + 短 ansiUnified
/diff 文本 · createDiffSummary · git
```

模型链只吃 plain `output`。

### 1.2 关键模块（A）

| 模块 | 职责 |
|------|------|
| `textDiff.ts` | hunk / unified |
| `fileChangePreview.ts` | 写前 preview |
| `ansiDiff.ts` | 色 · `createDiffSummary` |
| `gitDiff.ts` | 本地 git |
| `fileDiffLog.ts` | 会话聚合 + 文本 `/diff` |
| `toolExecution.ts` | preview / log / tool_end |
| `sessionTranscript.ts` | `file_diff` |
| CLI / Desktop | 最小展示 |

### 1.3 `/diff`（A · 非 TTY / 默认 dump）

| 调用 | 行为 |
|------|------|
| `/diff` | 着色多文件摘要 + 最近 snippet |
| `/diff last` | 最近 turn |
| `/diff <path>` | structured |
| `/diff git` | porcelain |
| `/diff git <path>` | vs HEAD |

### 1.4 环境

| 变量 | 作用 |
|------|------|
| `BOLO_DIFF_VERBOSE=1` | unified 最多 40 行 |
| `BOLO_DIFF_COMPACT=1` | 仅一行 summary |
| 默认 | tool_end ≤16 行着色 unified |

---

## 2. 轨 B · 交互 UI（规划 · 对齐 Ink/ratatui **语义**）

> **不强制** `ink` / `ratatui` 依赖。默认：自研 TTY pane（扩 `arrowPicker` 模式）+ Desktop 共用 ViewModel。  
> 总规划见 [ROADMAP.md](./ROADMAP.md) §3。

### 2.1 阶段

| 阶段 | 交付 | 验收要点 |
|------|------|----------|
| **U0** | `DiffViewModel`：由 `fileDiffLog` / preview 生成可渲染行 | ✅ `diffViewModel.ts` |
| **U1** | 终端 **Diff 面板**：TTY 下 `/diff` 进入可滚 UI | ✅ `tui/diffPane.ts` · `runOnePrompt` |
| **U2** | **权限预览面板**：ask 内嵌可滚 preview + y/a/N | ✅ `runDiffApprovePane` · `createTtyAskPermission` |
| **U3** | **写后 cell** + Desktop `<details>` | ✅ `fileChangeCell.ts` · tool_end · renderer |
| **U4** | 行号 · 主题 · 可选语法色 | 📋 |
| **U5** | 可选真·Ink / IDE / merge-base | 📋 |

### 2.2 ViewModel 草图（U0）

```ts
// 伪代码 · 拟 packages/core 或 cli/tui
type DiffViewModel = {
  title: string
  totals: { files: number; added: number; removed: number }
  files: Array<{
    path: string
    op?: string
    added: number
    removed: number
    hunks?: DiffHunk[]   // 可能空（resume 仅摘要）
    source: 'session' | 'preview' | 'git'
  }>
  selectedIndex: number
}

function buildDiffViewModel(input: {
  log?: FileChangeRecord[]
  preview?: FileChangePreview
  git?: GitStatusEntry[] | GitFileDiff
  turn?: number
}): DiffViewModel
```

UI **只渲染 VM**，不解析 patch 文本。

### 2.3 键位（U1 草案）

| 键 | 行为 |
|----|------|
| `j` / `↓` | 下一文件 |
| `k` / `↑` | 上一文件 |
| `Enter` / `l` | 展开/聚焦 hunk |
| `g` | 尝试补 git diff（当前文件） |
| `q` / `Esc` | 退出面板 |
| `/` | 过滤 path（可 U1.1） |

### 2.4 与现有 TUI 关系

- 今日：`inkLayout.ts` = **文本框等价 Ink**，无 React。  
- U1：同包新增 `tui/diffPane.ts`（raw mode），**不**重写整站 REPL。  
- 真·`ink` 依赖仅 U5 评估（见 `docs/TUI.md`）。

---

## 3. 刻意不做

| 项 | 原因 |
|----|------|
| 遥测 / LOC | 产品红线 |
| structuredPatch 进模型 message | 污染上下文 |
| 必抄 native color-diff / ratatui | 成本与栈不符 |
| U 轨阻塞日用发布 | A 已独立完成 |

---

## 4. 测试

```bash
# 轨 A
npx tsx scripts/test-file-diff.ts

# 轨 B（U0+ 落地后）
# npx tsx scripts/test-diff-view.ts
```

---

## 5. 文档地图

| 文档 | 角色 |
|------|------|
| 本文件 | Diff 双轨规格 |
| [ROADMAP.md](./ROADMAP.md) | 总路线 · U 轨规划 |
| [TUI.md](./TUI.md) | CLI 壳 · U 挂载 |
| [TOOL_CALLING.md](./TOOL_CALLING.md) | 工具表 |