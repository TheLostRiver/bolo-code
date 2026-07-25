# 文件 Diff 规格（对照 HC + Codex · 日用 95%+）

> 对照 HelsincyCode：`FileEditTool` / `utils/diff.ts` / `useTurnDiffs` / `FileEditToolDiff` / `gitDiff`。  
> 对照 Codex：`create_diff_summary` / `diff_render` / patch history（语义）。  
> Bolo：**无遥测**；不追求 Ink/IDE 全家桶 100%。

## 0. 目标与阶段

| 阶段 | 交付 | 状态 |
|------|------|------|
| **D0** | 纯函数 hunk + unified + 行数 | ✅ |
| **D1** | Edit / Write `meta.structuredPatch` | ✅ |
| **D2** | apply_patch meta · `fileDiffLog` · `/diff` | ✅ |
| **D3** | 写前 `previewFileToolChange` · ask 展示 | ✅ |
| **D4** | ANSI tool_end 摘要 | ✅ |
| **D5** | 本地 `gitDiff` · `/diff git` | ✅ |
| **D6** | transcript `file_diff` · resume | ✅ |
| **D7** | Codex 风格 `createDiffSummary` · 默认短 unified · 更密 ask/Desktop | ✅ |
| **后置** | 完整 DiffDialog / IDE / PR merge-base | 否 |

**日用 agent 文件-diff（相对 HC/Codex 工作流）：~95%+**  
**产品 UI 密度（Ink/ratatui 全家桶）：~45–55%**（后置）

## 1. 数据流

```
preview(ask) ──► permission_request.preview / askPermission.preview (着色)
tool success ──► meta ──► fileDiffLog ──► transcript file_diff
                    └──► tool_end summaryLine + 默认短 ansiUnified
/diff · /diff last · /diff <path> · /diff git [path]
         └── createDiffSummary 多文件块 + 最近 snippet
```

## 2. 关键模块

| 模块 | 职责 |
|------|------|
| `textDiff.ts` | hunk / unified |
| `fileChangePreview.ts` | 写前 preview |
| `ansiDiff.ts` | 色 · `createDiffSummary` · 默认 inline 行数 |
| `gitDiff.ts` | 本地 git |
| `fileDiffLog.ts` | 会话聚合 + `/diff` |
| `toolExecution.ts` | preview / log / tool_end |
| `sessionTranscript.ts` | `file_diff` |
| CLI / Desktop | 展示 |

## 3. `/diff`

| 调用 | 行为 |
|------|------|
| `/diff` | 着色多文件摘要 + 最近 snippet |
| `/diff last` | 最近用户 turn |
| `/diff <path>` | structured（着色） |
| `/diff git` | porcelain |
| `/diff git <path>` | vs HEAD |

## 4. 环境

| 变量 | 作用 |
|------|------|
| `BOLO_DIFF_VERBOSE=1` | tool_end unified 最多 40 行 |
| `BOLO_DIFF_COMPACT=1` | 仅一行 summary，不附 unified |
| （默认） | tool_end 附最多 16 行着色 unified |

## 5. 刻意不做

- IDE · DiffDialog 全交互 · GitHub repository  
- 遥测 / 完整 Myers npm  
- structuredPatch 灌模型 message  

## 6. 测试

```bash
npx tsx scripts/test-file-diff.ts
```