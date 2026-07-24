# Subagent 契约（S0–S7 · S12 最小）

对照 HelsincyCode `tools/AgentTool`（`runAgent` / `resolveAgentTools` / `loadAgentsDir` / `Agent` 工具），**无遥测**、不抄 GrowthBook / swarm / worktree。

## 流程

```text
主 queryLoop
  → 模型调用工具 Agent（prompt + 可选 subagent_type / fork / run_in_background）
  → SubagentStart hook（agent_id / agent_type）
  → 子 loop：
      · 普通：独立 messages + 裁剪 tools + 子 system
      · fork：父 messages 浅拷贝 + 新 user 任务；tools=父集去掉 Agent
  → queryLoop（默认 maxTurns=8）
  → 汇总最后 assistant 文本 → 父 tool_result
  → SubagentStop hook
  → 父继续
```

## 类型（`AgentDefinition`）

| 字段 | 说明 |
|------|------|
| `agentType` | 如 `explore` / `general` / `fork` / 项目自定义 |
| `description` | 给主模型选类型用 |
| `tools` | 白名单工具名，或 `'*'` |
| `systemPrompt` | 子 agent 短 system |
| `permissionMode?` | 可选；未设则继承父会话 |
| `source?` | `builtin` / `user` / `project` |

## 内置类型

| `subagent_type` | 工具 | system 要点 |
|-----------------|------|-------------|
| `explore` | `Read` / `Glob` / `Grep` | 只调研，不改文件 |
| `general` | 与主会话默认可写集相同，**排除 `Agent`** | 执行子任务并回报摘要 |
| `fork` | 与父相同工具，**排除 `Agent`** | 短提示「你是 fork 工作者」；或父 `systemPromptSections` |

## Fork（S12 最小 · HC forkSubagent 语义极简）

触发（任一）：

1. **`subagent_type` 省略**（空 / 未传）
2. **`subagent_type: "fork"`**
3. **`fork: true`**（显式；优先于其它 type）

行为：

| 项 | 说明 |
|----|------|
| messages | 父会话 messages **浅拷贝** + 新 user 任务（directive = `prompt`） |
| tools | 父 `allTools` 去掉 `Agent`（禁递归 fork） |
| system | 有父 `systemPromptSections` 则用；否则用 `FORK_AGENT.systemPrompt` |
| 串行 | 仍 `isConcurrencySafe=false`；可与 `run_in_background` 组合 |
| 不做 | Electron、worktree、完整 prompt cache 共享、遥测 |

`runSubagent({ fork: true, parentMessages, parentSystemPromptSections })` 与 Agent 工具路径一致。

## 项目 / 用户定义（S7 · `loadAgentsDir`）

发现顺序与合并（**后者覆盖同名**）：

1. 内置 `explore` / `general` / `fork`
2. 可选 `~/.bolo/agents/*.md`（或 `$BOLO_CONFIG_DIR/agents/`）
3. `{cwd}/.bolo/agents/*.md` — **项目覆盖同名内置 / 用户**

`ensureProjectLayout` / `ensureUserLayout` 会创建空的 `agents/` 目录。

### Markdown 约定

```markdown
---
name: explore
description: Project-overridden explore agent
tools: Read, Glob, Grep
permissionMode: default
---

Optional system append / replacement body for the subagent.
```

| frontmatter | 说明 |
|-------------|------|
| `name` / `agentType` / `id` | 类型 id；缺省用文件名（去 `.md`） |
| `description` | 列表与选类型用 |
| `tools` | `*`，或逗号列表，或 YAML 列表项 `- Read` |
| `permissionMode` | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| body | **system 正文**（整段作为子 agent system；覆盖内置时替换内置 system） |

解析 API：`loadAgentsDir({ cwd })` → `{ agents, active, errors }`；会话在 `createSession` 时装入 `session.agentDefinitions`，`createAgentTool` / `runSubagent` / `spawnSubagent` 按 active 表 resolve。

斜杠：`/agents` 列出活跃类型与来源。

## 工具策略 `resolveAgentTools`

1. 从父侧「全部工具」出发。
2. `tools === '*'` → 保留全部（再扣黑名单）。
3. 否则只保留白名单中的名字。
4. **始终排除 `Agent`**，防止子 agent 再 spawn（无限递归）。
5. 未知白名单名字忽略（不抛）。

fork 路径不走白名单表，直接 `parent.allTools` 去掉 `Agent`。

## Agent 工具（主会话 builtins）

- **name:** `Agent`
- **input:** `prompt`（必填）；`subagent_type`（可选：省略/`fork`=继承父会话，其它=独立子 agent）；`fork`（可选布尔）；`run_in_background` / `async`（可选布尔）
- **`isConcurrencySafe`:** 恒 `false`（同轮多个 Agent 串行）
- **结果：** 同步成功为摘要文本；`run_in_background=true` 时立即返回 `started agent <id>…`，结果写入 `session.backgroundAgents`，用 `/agents status` 或 `/bg` 轮询
- **失败：** `isError` + 错误说明

## 刻意不做（P2+）

- 完整 worktree / swarm / 跨会话 cache 共享
- 遥测 / GrowthBook / teammate

侧链 transcript（可选）：`runSubagent({ writeTranscript: true })` 写入 `{cwd}/.bolo/sessions/agent-{id}.jsonl`；`SubagentStop` 可带 `agent_transcript_path`。

**S12 最小 async：** Agent 工具 `run_in_background` 后台 `runSubagent`；会话 `backgroundAgents.pendingAgents` / `backgroundAgentResults`；可选 system 通知进 `session.messages`。

**S12 最小 fork：** 见上文；无 worktree / 无完整 cache 共享。

**S8 最小权限：** `resolveSubagentPermissionMode(parent, def)` — 子 agent **不得**比父会话更宽（rank：`plan < default < acceptEdits < bypass`）。定义写 `bypass` 而父为 `default` 时实际仍用 `default`。

**SA-PAR：** `/agents status` · `/bg` 展示 `total/running/done/error` 计数 + `RUNNING|DONE|ERROR` 标签 + finished 时间。

## 完成定义

`spawnSubagentStub`（只发 hook）**不算完成**。

- **S0–S6：** 文档 + `runSubagent` + Agent 工具 + 测试绿
- **S7：** `.bolo/agents` 发现、覆盖内置、resolve + `/agents` + `ensure*Layout` 的 `agents/`
- **S8 最小：** 子权限不升级（`resolveSubagentPermissionMode`）
- **S12 partial：** 可选后台 subagent + **fork 继承父 messages**（无 worktree）
- **SA-PAR：** 后台队列可见性（计数 + 状态标签）