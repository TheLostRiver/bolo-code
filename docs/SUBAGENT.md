# Subagent 契约（S0–S6 最小完成线）

对照 HelsincyCode `tools/AgentTool`（`runAgent` / `resolveAgentTools` / `Agent` 工具），**无遥测**、不抄 GrowthBook / fork / swarm。

## 流程

```text
主 queryLoop
  → 模型调用工具 Agent（prompt + 可选 subagent_type）
  → SubagentStart hook（agent_id / agent_type）
  → 子 loop：独立 messages + 裁剪 tools + 子 system
  → queryLoop（默认 maxTurns=8）
  → 汇总最后 assistant 文本 → 父 tool_result
  → SubagentStop hook
  → 父继续
```

## 类型（`AgentDefinition`）

| 字段 | 说明 |
|------|------|
| `agentType` | 如 `explore` / `general` |
| `description` | 给主模型选类型用 |
| `tools` | 白名单工具名，或 `'*'` |
| `systemPrompt` | 子 agent 短 system |
| `permissionMode?` | 可选；未设则继承父会话 |

## 内置类型

| `subagent_type` | 工具 | system 要点 |
|-----------------|------|-------------|
| `explore` | `Read` / `Glob` / `Grep` | 只调研，不改文件 |
| `general`（默认） | 与主会话默认可写集相同，**排除 `Agent`** | 执行子任务并回报摘要 |

## 工具策略 `resolveAgentTools`

1. 从父侧「全部工具」出发。
2. `tools === '*'` → 保留全部（再扣黑名单）。
3. 否则只保留白名单中的名字。
4. **始终排除 `Agent`**，防止子 agent 再 spawn（无限递归）。
5. 未知白名单名字忽略（不抛）。

## Agent 工具（主会话 builtins）

- **name:** `Agent`
- **input:** `prompt`（必填）、`subagent_type`（可选，默认 `general`）
- **`isConcurrencySafe`:** 恒 `false`（同轮多个 Agent 串行）
- **结果：** 成功为摘要文本；失败 `isError` + 错误说明

## 刻意不做（P2+）

- 侧链 `agent-*.jsonl`、`.bolo/agents` 目录定义
- Fork 继承父 messages、异步后台、worktree
- 遥测 / GrowthBook / teammate

## 完成定义

`spawnSubagentStub`（只发 hook）**不算完成**。S0–S6：文档 + `runSubagent` + Agent 工具 + 测试绿。