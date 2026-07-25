# Subagent 契约（已实现 · Spec v0 已接线）

对照 HelsincyCode `tools/AgentTool` + Codex agents 配置优点。完整目标方案见 [SUBAGENT_SPEC.md](./SUBAGENT_SPEC.md)。  
**无遥测**、不抄 GrowthBook / swarm。

> **Spec v0 已实现：** `config.agents` · frontmatter `model`/`effort`/`maxSpawnDepth`/`sandbox` · `spawnDepth` · 条件 Agent · model/effort 解析链 · `agents.enabled`。

**F-SA-WORKTREE：** `BOLO_SUBAGENT_WORKTREE=1` 时请求 `git worktree add --detach`；创建失败直接终止子任务，不回落父 cwd。
**F-SA-PAR2：** `BOLO_BACKGROUND_OVERFLOW=queue|reject`（默认 reject）。  
**F-S8-PLUS：** `filterToolsBySubagentAllowlist` 收紧子工具表。

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
| `disallowedTools?` | 从已解析集再剔除（frontmatter / 定义级） |
| `systemPrompt` | 子 agent 短 system |
| `permissionMode?` | 可选；未设则继承父会话 |
| `maxTurns?` | 定义级 max turns（Agent 工具 `max_turns` 可覆盖） |
| `background?` | 定义级默认后台跑 |
| `isolation?` | `none` \| `worktree` |
| `source?` | `builtin` / `user` / `project` |

## 内置类型

| `subagent_type` | 工具 | system 要点 |
|-----------------|------|-------------|
| `explore` | `Read` / `Glob` / `Grep`（禁 Write/Edit/Bash/Agent） | 只调研，不改文件；可写 thoroughness |
| `general` | 默认可写集，**排除 `Agent`** | 执行子任务并回报摘要 |
| `plan` | 同 explore 只读 + `permissionMode=plan` | 出实现计划 + Critical Files 列表 |
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
5. `disallowedTools` 二次剔除（与白名单叠加）。
6. 未知白名单名字忽略（不抛）。

fork 路径不走白名单表，直接 `parent.allTools` 去掉 `Agent`。

## Agent 工具（主会话 builtins）

- **name:** `Agent`
- **input:**
  - `prompt`（必填）— 完整任务说明
  - `description`（可选，3–5 词）— 仅 UI / trailer / 后台表标签
  - `subagent_type`（可选：省略/`fork`=继承父会话，其它=独立子 agent）
  - `fork`（可选布尔）
  - `run_in_background` / `async`（可选布尔；或定义 `background: true`）
  - `max_turns`（可选；覆盖定义级 maxTurns）
  - `isolation`（可选：`none` \| `worktree`）
- **`isConcurrencySafe`:** 恒 `false`（同轮多个 Agent 串行）
- **结果：** 同步成功为 `formatSubagentToolOutput`（header + task + summary + **stats**: duration · tools · tokens）；后台立即返回 `started agent <id>…`
- **失败：** `isError` + 错误说明

## finalize 统计（对照 HC finalizeAgentTool，无遥测）

| 字段 | 来源 |
|------|------|
| `totalDurationMs` | 墙钟 start→end |
| `totalToolUseCount` | `countToolUses(messages)`（assistant.tool_calls） |
| `usage` | 子 loop 本地 SessionUsage |
| SubagentStop hook | 可带 `total_duration_ms` / `total_tool_use_count` / `total_tokens` / `description` |

## Usage 回卷（成本）

```text
子 queryLoop → childUsage
  → mergeSessionUsage(parentUsage, childUsage)
  → 父 /cost 含 subagent tokens + cache
```

- `runSubagent({ parentUsage, model })`：结束时 merge；`model` 写入 `byModel`。
- Agent 工具经 `toolExecution` 注入 `parentUsage: session.usage`、`model: session.model`（同步 + 后台均生效）。
- 后台结果可带 `usage` 快照；`/agents status` 展示 tokens 行。
- 无遥测。

## Worktree

- `BOLO_SUBAGENT_WORKTREE=1` 或 `isolation: worktree` → `git worktree add --detach`。
- 结束后仅自动删除本次创建且 clean 的 worktree；modified/untracked/ignored、复用目录或清理失败均保留。
- worktree 路径从 Git repo root 计算；同路径若属于其它仓库会 fail-closed，不跨仓库复用。
- 保留时 `RunSubagentResult.worktreeCleanup` 与工具摘要返回绝对路径和原因，便于恢复成果。
- `cleanupWorktree: false` 可显式保留调试。
- 侧链 transcript 写在**父 cwd** 的 sessions，避免 worktree 清掉后丢文件。

## 刻意不做（P2+）

- swarm / teammate / 跨会话完整 prompt cache 共享
- 遥测 / GrowthBook

侧链 transcript（可选）：`runSubagent({ writeTranscript: true })` 写入 `{cwd}/.bolo/sessions/agent-{id}.jsonl`；`SubagentStop` 可带 `agent_transcript_path`。

**S12 最小 async：** Agent 工具 `run_in_background` 后台 `runSubagent`；会话 `backgroundAgents.pendingAgents` / `backgroundAgentResults`；可选 system 通知进 `session.messages`。

**S12 最小 fork：** 见上文；无完整 cache 共享。

**S8 最小权限：** `resolveSubagentPermissionMode(parent, def)` — 子 agent **不得**比父会话更宽（rank：`plan < default < acceptEdits < bypass`）。定义写 `bypass` 而父为 `default` 时实际仍用 `default`。

**SA-PAR：** `/agents status` · `/bg` 展示 `total/running/done/error` 计数 + `RUNNING|DONE|ERROR` 标签 + finished 时间 + 可选 usage。

**P-SA-CAP：** 后台并发上限默认 **3**（`BOLO_MAX_BACKGROUND_AGENTS` 或 `store.maxConcurrent`）；超额拒绝并提示 `/agents status`。

## 完成定义

`spawnSubagentStub`（只发 hook）**不算完成**。

- **S0–S6：** 文档 + `runSubagent` + Agent 工具 + 测试绿
- **S7：** `.bolo/agents` 发现、覆盖内置、resolve + `/agents` + `ensure*Layout` 的 `agents/`
- **S8 最小：** 子权限不升级（`resolveSubagentPermissionMode`）
- **S12 partial：** 可选后台 subagent + **fork 继承父 messages**
- **SA-PAR / P-SA-CAP：** 后台可见性 + 并发上限
- **Usage 回卷 / maxTurns / disallowedTools / worktree cleanup：** 已接线（相对 HC 仍简化）
