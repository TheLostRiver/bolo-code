# 权限模式 — 对照参考实现语义

> 参考 PermissionMode 与 permissions 决策链。  
> **不抄**遥测、GrowthBook、`auto` 分类器。

## 1. 外部模式（产品四档 + default）

| Mode ID | 用户说法 | 行为摘要 |
|---------|----------|----------|
| `default` | 请求批准 | 危险操作 → ask（UI / hook） |
| `acceptEdits` | 自动审批（编辑） | 工作区内读/写/补丁 auto-allow；Bash/MCP 仍 ask |
| `plan` | Plan | 只读类 allow；写/壳/MCP **deny**（规划不改系统） |
| `bypassPermissions` | 完全访问 | 尽量 allow（仍可被硬 deny 规则挡住） |

可选后置（本切片不做）：

| Mode | 说明 |
|------|------|
| `dontAsk` | ask → deny |
| `auto` | 分类器自动批 |

## 2. 决策链（简化，无遥测）

```
PreToolUse (可 block)
  → PermissionGate(mode, tool, input, cwd, rules?)
       → allow | deny | ask
  → 若 ask：PermissionRequest hooks → 仍 ask 则 UI askPermission
  → execute / 或 tool_result 拒绝文案
  → PostToolUse
```

**Gate 顺序：**

1. `bypassPermissions` → allow  
2. `plan` → 读 allow；写/壳/MCP **deny**（**优先于** always-allow）  
3. 会话 always-allow 规则（见 §5）→ allow  
4. `acceptEdits` / `default` 矩阵  

## 3. 工具类别（Bolo）

| category | 工具 |
|----------|------|
| `read` | Read, Glob, Grep, Skill |
| `edit` | Write, Edit, apply_patch |
| `shell` | Bash |
| `mcp` | `mcp__*` |

## 4. 模式 × 类别矩阵

| | read | edit (cwd 内) | edit (cwd 外) | shell | mcp |
|--|------|---------------|---------------|-------|-----|
| default | allow* | ask | ask | ask | ask |
| acceptEdits | allow | **allow** | ask | ask | ask |
| plan | allow | **deny** | deny | **deny** | deny |
| bypassPermissions | allow | allow | allow | allow | allow |

\* default 下只读默认 allow。

## 5. 会话 Always-allow（`Session.permissionRules`）

可经 JSON / JSONL meta **本地持久化**；CLI 答 `a` 或 `/allow` 写入。

| 字段 | 含义 |
|------|------|
| `alwaysAllowToolNames` | 精确工具名（如 `Bash`、`Write`） |
| `alwaysAllowPrefixes` | 工具名前缀（如 `mcp__trusted`） |
| `alwaysAllowPathGlobs` | 相对 cwd 的路径 glob；命中 path/file_path 则 allow（Write/Edit/Read…） |
| `alwaysAllowBashPrefixes` | Bash `command` 前缀（trim 后 `startsWith`） |

**`/allow` 用法：**

```text
/allow                 # 列出
/allow Bash            # 工具名
/allow path:src/**     # 路径 glob
/allow bash:git        # Bash 前缀（如 git status）
```

**硬约束：**

- `plan` 下写/壳/MCP 仍 **deny**，always-allow **不能** 覆盖  
- `bypassPermissions` 仍全开  

## 6. 模块

```
packages/permissions/src/index.ts
  PermissionMode · classifyTool · decidePermission
  SessionPermissionRules · matchesAlwaysAllow · matchPathGlob
  addAlwaysAllowToolName / PathGlob / BashPrefix

runToolUse 调用 gate，再 hooks/UI
Session.permissionMode / permissionRules
```

系统提示词注入模式说明，见 `docs/PROMPT_CATALOG.md` / `docs/SYSTEM_PROMPT.md`。

## 7. 验收

- gate 单测：四模式 × Bash/Write/Edit/Read + tool/path/bash always-allow  
- plan 仍 deny 写；bypass 全开  
- 无遥测  

## 8. 明确不做

- 跨会话全局 allow 规则 DSL（仅会话 + 快照）  
- YOLO / auto 分类器  
- sandbox 网络策略  
- 完整 path allowlist 引擎（本刀：glob + cwd 内外）