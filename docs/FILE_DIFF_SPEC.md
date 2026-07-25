# 文件 Diff 规格 v0（规划 · 对照 HC）

> 对照 HelsincyCode：`FileEditTool` / `utils/diff.ts` / `FileEditToolDiff` / `/diff` / IDE。  
> Bolo：**无遥测**；先 **core 契约 + 文本 diff**，再 CLI/Desktop 预览。

## 0. 目标

缩小「agent 改文件 vs HC 的 diff 体验」差距：

| 阶段 | 交付 | 相对 HC 文件-diff |
|------|------|-------------------|
| **D0** | 纯函数：旧→新文本 → hunk + unified 字符串 + 行数 | 算法 ~40% |
| **D1** | `Edit` / `Write` 结果带 structured 摘要；tool_result 可读 diff | 原语+输出 ~55–65% |
| **D2** | 会话 turn 级改动列表 + 最小 `/diff`（slash） | 会话 ~70% |
| **D3** | 权限 ask 前预览 patch（CLI/Desktop） | 产品 ~80% |
| **后置** | IDE 推送 / 彩色组件 / gitDiff 远程 | HC 全家桶 |

**本开工默认：D0 + D1**；D2 同批若时间够则接最小 slash。

## 1. 借鉴 HC 什么

| HC | Bolo v0 |
|----|---------|
| `structuredPatch` hunk：`oldStart/oldLines/newStart/newLines/lines` | 同形，本地类型 `DiffHunk` |
| `countLinesChanged`（+ / −） | `countHunkLines`；**不**进遥测 counter |
| 工具结果带 patch | `ToolResult.meta` + `output` 内嵌 unified 摘要 |
| UI 彩色 diff | **不做**（D3） |
| `logEvent` / LOC counter | **永不** |

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

### 2.2 API

| 函数 | 作用 |
|------|------|
| `diffHunksFromEdit(before, oldStr, newStr, replaceAll?)` | Edit 语义 → hunks |
| `diffHunksFromFullReplace(before, after)` | Write 语义 → 简化 hunks |
| `formatUnifiedDiff(path, hunks, opts?)` | 人类/模型可读 unified |
| `countHunkLines(hunks)` | `{ added, removed }` |
| `formatEditToolOutput(...)` | 一行摘要 + 截断 unified（预算） |

### 2.3 `ToolResult` 扩展

```ts
type ToolResult = {
  ok: boolean
  output: string
  isError?: boolean
  errorCode?: string
  /** 可选结构化（权限 UI / /diff 消费） */
  meta?: {
    kind?: 'file_edit' | 'file_write' | 'apply_patch'
    path?: string
    added?: number
    removed?: number
    replacements?: number
    structuredPatch?: DiffHunk[]
    unified?: string
  }
}
```

`output` **必须**对模型仍可读；`meta` 可选，旧调用方忽略。

### 2.4 工具行为

| 工具 | 写盘后 |
|------|--------|
| **Edit** | `meta.kind=file_edit` + hunks + `edited path (+N/-M, k replacements)` + 短 unified |
| **Write** | `meta.kind=file_write`；新建全 +；覆盖用 full-replace hunks |
| **apply_patch** | 尽量汇总 per-file 行数；完整 structured 可后置 |

### 2.5 预算

- unified 写入 `output` 时默认 **max ~80 行 / 4k chars**，超长截断并注 `…(truncated)`  
- 完整 hunks 可放 `meta`（内存内；不强制落盘）

## 3. 刻意不做（v0）

- 依赖外部 `diff` npm（自实现 Edit 局部 + Write 简化即可）  
- IDE / VS Code  
- git remote structuredDiff  
- 遥测 / LOC counter  
- 权限弹窗彩色 UI（D3）

## 4. 测试

```bash
npx tsx scripts/test-file-diff.ts
```

- Edit 唯一替换 → +1/−1 量级正确  
- replace_all 多处  
- Write 新建 / 覆盖  
- unified 含 `---`/`+++`/`@@`  
- 失败路径无 meta

## 5. 文档地图

| 文档 | 角色 |
|------|------|
| 本文件 | 规格 |
| `docs/TOOL_CALLING.md` | 工具表（实现后补一行） |
| `docs/ROADMAP.md` | 水位（实现后更新） |