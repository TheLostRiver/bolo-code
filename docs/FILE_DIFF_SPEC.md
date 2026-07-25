# 文件 Diff 规格（对照 HC + Codex · 日用 95%+）

> 对照 HelsincyCode：`FileEditTool` / `utils/diff.ts` / `useTurnDiffs` / `FileEditToolDiff` / `gitDiff`。  
> 对照 Codex：`diff_render` / patch history 摘要（语义）。  
> Bolo：**无遥测**；不追求 Ink/IDE 全家桶 100%。

## 0. 目标与阶段

| 阶段 | 交付 | 状态 |
|------|------|------|
| **D0** | 纯函数 hunk + unified + 行数 | ✅ |
| **D1** | Edit / Write `meta.structuredPatch` | ✅ |
| **D2** | apply_patch meta · `fileDiffLog` · `/diff` | ✅ |
| **D3** | 写前 `previewFileToolChange` · ask 展示 | ✅ |
| **D4** | ANSI tool_end 摘要（模型 output 仍 plain） | ✅ |
| **D5** | 本地 `gitDiff` · `/diff git` | ✅ |
| **D6** | transcript `file_diff` 摘要 · resume | ✅ |
| **后置** | IDE · 完整 DiffDialog · PR merge-base | 否 |

**日用 agent 文件-diff 体验：~95%+**（写前可见 / 写后可读 / 会话可查 / git 可对 / resume 可列）。  
HC Ink 全家桶 + IDE：**后置**。

## 1. 数据流

```
preview(ask) ──► permission_request.preview / askPermission.preview
tool success ──► meta ──► fileDiffLog ──► transcript file_diff
                    └──► tool_end summaryLine / ansiUnified (UI)
/diff · /diff last · /diff <path> · /diff git [path]
```

模型链只吃 plain `output`；色与完整 preview 走 side-channel。

## 2. 关键模块

| 模块 | 职责 |
|------|------|
| `packages/tools/src/textDiff.ts` | hunk / unified / 行数 |
| `packages/tools/src/fileChangePreview.ts` | 写前 preview（不写盘） |
| `packages/tools/src/ansiDiff.ts` | 终端色 |
| `packages/tools/src/gitDiff.ts` | 本地 git status / 单文件 diff |
| `packages/core/src/fileDiffLog.ts` | 会话聚合 + `/diff` 文本 |
| `packages/core/src/toolExecution.ts` | ask 挂 preview；log；tool_end 摘要 |
| `packages/core/src/sessionTranscript.ts` | `file_diff` entry |
| `packages/cli` · `apps/desktop` | 展示 preview / summary |

## 3. `/diff`

| 调用 | 行为 |
|------|------|
| `/diff` | 会话累计 |
| `/diff last` | 最近用户 turn |
| `/diff <path>` | 该路径最近 structured（内存有则） |
| `/diff git` | `git status --porcelain` |
| `/diff git <path>` | 相对 HEAD（untracked 合成 full-add） |

## 4. 刻意不做

- 外部 `diff` npm / 完整 Myers  
- IDE 推送 / GitHub repository 字段  
- 遥测 / LOC  
- structuredPatch 灌进模型 message  

## 5. 测试

```bash
npx tsx scripts/test-file-diff.ts
```

## 6. 环境

- `BOLO_DIFF_VERBOSE=1`：tool_end 附加 ANSI unified 片段