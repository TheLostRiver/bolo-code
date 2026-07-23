# 权限模式 — 对照 HelsincyCode

> 参考：`types/permissions.ts`（EXTERNAL_PERMISSION_MODES）、`PermissionMode.ts`、`permissions.ts` 决策链。  
> **不抄**遥测、GrowthBook、`auto` 分类器。

## 1. 外部模式（产品四档 + default）

| Mode ID | 用户说法 | 行为摘要 |
|---------|----------|----------|
| `default` | 请求批准 | 危险操作 → ask（UI / hook） |
| `acceptEdits` | 自动审批（编辑） | 工作区内读/写/补丁 auto-allow；Bash/MCP 仍 ask |
| `plan` | Plan | 只读类 allow；写/壳/MCP **deny**（规划不改系统） |
| `bypassPermissions` | 完全访问 | 尽量 allow（仍可被硬 deny 规则挡住，v1 无规则表） |

可选后置（本切片不做）：

| Mode | 说明 |
|------|------|
| `dontAsk` | ask → deny |
| `auto` | 分类器自动批 |

## 2. 决策链（简化自 HC，无遥测）

```
PreToolUse (可 block)
  → PermissionGate(mode, tool, input, cwd)
       → allow | deny | ask
  → 若 ask：PermissionRequest hooks → 仍 ask 则 UI askPermission
  → execute / 或 tool_result 拒绝文案
  → PostToolUse
```

## 3. 工具类别（Bolo v1）

| category | 工具 |
|----------|------|
| `read` | Read, Glob, Grep |
| `edit` | Write, apply_patch |
| `shell` | Bash |
| `mcp` | `mcp__*` |

## 4. 模式 × 类别矩阵（v1）

| | read | edit (cwd 内) | edit (cwd 外) | shell | mcp |
|--|------|---------------|---------------|-------|-----|
| default | allow* | ask | ask | ask | ask |
| acceptEdits | allow | **allow** | ask | ask | ask |
| plan | allow | **deny** | deny | **deny** | deny |
| bypassPermissions | allow | allow | allow | allow | allow |

\* default 下只读默认 allow，与 HC「读常自动过」一致。

## 5. 模块

```
packages/permissions/
  modes.ts      # PermissionMode 类型与标题
  classify.ts   # tool → category
  gate.ts       # decidePermission(...)
  index.ts

runToolUse 调用 gate，再 hooks/UI
Session.permissionMode 可切换
```

## 6. 验收

- gate 单测：四模式 × Bash/Write/Read  
- smoke：default 或 bypass 下仍可跑 Bash  
- 无遥测  

## 7. 明确不做

- 持久 allow 规则 DSL  
- YOLO 分类器  
- sandbox 网络策略  
- 完整 path allowlist 引擎（仅 cwd 内外判断）