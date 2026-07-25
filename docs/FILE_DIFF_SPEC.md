# 文件 Diff 规格 v0（对照 HC · 实现水位）

> 对照 HelsincyCode：`FileEditTool` / `utils/diff.ts` / `useTurnDiffs` / `FileEditToolDiff`。  
> Bolo：**无遥测**；core 契约 + 文本 diff + 会话 log + `/diff`；彩色 UI / 权限预览后置。

## 0. 目标与阶段

| 阶段 | 交付 | 状态 |
|------|------|------|
| **D0** | 纯函数：旧→新 → hunk + unified + 行数 | ✅ |
| **D1** | `Edit` / `Write` 结果 `meta.structuredPatch` + 可读摘要 | ✅ |
| **D2** | `apply_patch` meta · 会话 `fileDiffLog` · `/diff` | ✅ 本批 |
| **D3** | 权限 ask 前预览 · CLI/Desktop 彩色 | 后置 |
| **后置** | IDE / gitDiff 远程 | HC 全家桶 |

相对 HC 文件-diff 体验粗估：**~70–80%**（有契约与会话列表，无彩色组件）。

## 1. 借鉴 HC 什么

| HC | Bolo |
|----|------|
| `structuredPatch` hunk | `DiffHunk`（同形） |
| `countLinesChanged` | `countHunkLines`；**不**进遥测 |
| 工具结果带 patch | `ToolResult.meta`；模型吃 `output` |
| `useTurnDiffs` | `fileDiffLog` + turn 号 + `/diff` |
| UI 彩色 / 权限预览 | **D3** |
| `logEvent` / LOC | **永不** |

## 2. 契约

### 2.1 `DiffHunk`（`packages/tools/src/textDiff.ts`）

```ts
type DiffHunk = {
  oldStart: number  // 1-based
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]   // 前缀 ' ' | '+' | '-'
}
```

### 2.2 工具 API

| 函数 | 作用 |
|------|------|
| `diffHunksFromEdit` | Edit 语义 |
| `diffHunksFromFullReplace` | Write / apply_patch 前后全文 |
| `formatUnifiedDiff` | 可读 unified（预算截断） |
| `countHunkLines` | `{ added, removed }` |

### 2.3 `ToolResult.meta`

```ts
meta?: {
  kind?: 'file_edit' | 'file_write' | 'apply_patch'
  path?: string
  paths?: string[]
  op?: 'add' | 'update' | 'delete' | 'move'
  added?: number
  removed?: number
  replacements?: number
  structuredPatch?: DiffHunk[]
  files?: Array<{ path; op?; added?; removed?; structuredPatch? }>
  unified?: string
}
```

### 2.4 会话 `fileDiffLog`（`packages/core/src/fileDiffLog.ts`）

- **side-channel**：不进 `ChatMessage.content` / 不强制 jsonl
- `submitPrompt` 递增 `diffTurn`；`runToolUse` 成功且 meta 为文件类时 append
- **resume 默认空**（内存 only；文档诚实说明）

### 2.5 `/diff`

| 调用 | 行为 |
|------|------|
| `/diff` | 会话累计文件 + 总 +N/−M |
| `/diff last` | 最近用户 turn |
| `/diff <path>` | 该路径最近一次 structured 行（若有） |

## 3. 刻意不做

- 外部 `diff` npm / 完整 Myers  
- 权限弹窗彩色预览（D3）  
- structuredPatch 强持久化进 message 行  
- 遥测 / LOC counter  

## 4. 测试

```bash
npx tsx scripts/test-file-diff.ts
```

## 5. 文档地图

| 文档 | 角色 |
|------|------|
| 本文件 | 规格 |
| `docs/TOOL_CALLING.md` | 工具表 |
| `docs/ROADMAP.md` | 水位 |