# Bolo Subagent Spec v0（开工契约）

> **状态：设计冻结 v0 · 待实现**  
> 整合：**HelsincyCode（HC）AgentTool** + **Codex custom agents / `[agents]`**，落在 Bolo 现有 `packages/core` 契约上。  
> **永不：** 遥测 · GrowthBook · swarm/teammate 全家桶 · Claude/Codex 官方市场。

与 `docs/SUBAGENT.md` 关系：

| 文档 | 角色 |
|------|------|
| **本文件** | 目标方案（配置、解析链、嵌套、分阶段实现） |
| `SUBAGENT.md` | 当前已实现行为 + 历史里程碑 |

---

## 0. 设计原则

1. **主线程编排，子线程干活**  
   默认只有主会话（spawnDepth=0）能稳定分发子 agent；子再分发是**可配置例外**，不是默认能力。

2. **两层配置，不做成「整 session 克隆」**  
   - Codex 优点：全局 default model/effort + 文件级覆盖 + 清晰优先级。  
   - HC 优点：tools/disallowedTools、permission 不升级、fork/async、worktree、finalize 统计。  
   - Bolo：**轻量 agent 定义**（md frontmatter + body），**不**把完整 `config.toml` 会话层塞进每个 agent（避免 Codex 文档里「过重、会变」的问题）。

3. **解析永远可本地、可测试**  
   优先级写死；无远程门控；env 仅覆盖「默认」，不偷偷改权限。

4. **子结果回主：摘要 + stats + usage 回卷**  
   已有 finalize / merge usage；本 spec 只补 **model / effort / depth** 旋钮。

---

## 1. 术语

| 词 | 含义 |
|----|------|
| **主会话 / primary** | 用户 REPL / Electron 会话；`spawnDepth = 0` |
| **子 agent / subagent** | `Agent` 工具或 `runSubagent` 启动的独立 queryLoop |
| **agent 类型** | `explore` / `general` / `plan` / `fork` / 用户自定义 id |
| **spawnDepth** | 当前 loop 相对主会话的嵌套深度；主=0，每 spawn 一次 +1 |
| **maxSpawnDepth** | **本 agent 是否还能再 spawn**：运行时比较 `spawnDepth` 与有效上限（见 §4） |

---

## 2. 配置落点

### 2.1 全局策略 — `config.json` → `agents` 段

路径：

- 用户：`~/.bolo/config.json`（或 `$BOLO_CONFIG_DIR/config.json`）
- 项目：`.bolo/config.json`（字段覆盖用户）

```jsonc
{
  "version": 1,
  "agents": {
    "enabled": true,
    "maxConcurrent": 3,
    "defaultModel": "inherit",
    "defaultEffort": "medium",
    "maxSpawnDepth": 0,
    "overflow": "reject"
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | bool | `true` | `false` 时主会话 **不注册 Agent 工具**（Codex `agents.enabled`） |
| `maxConcurrent` | number | `3` | 后台并发上限；对齐现 `BOLO_MAX_BACKGROUND_AGENTS` / store.maxConcurrent |
| `defaultModel` | string | `"inherit"` | 子默认模型；`inherit` = 父会话 model |
| `defaultEffort` | string | 继承父 / 或 `"medium"` | 子默认 effort；档位与主会话 `/effort` 一致 |
| `maxSpawnDepth` | number | **`0`** | **全局默认：子不能再 spawn**（见 §4） |
| `overflow` | `"reject"` \| `"queue"` | `"reject"` | 对齐 `BOLO_BACKGROUND_OVERFLOW` |

**环境变量覆盖（可选，实现时统一）：**

| Env | 映射 |
|-----|------|
| `BOLO_AGENTS_ENABLED=0` | `enabled=false` |
| `BOLO_MAX_BACKGROUND_AGENTS` | `maxConcurrent` |
| `BOLO_SUBAGENT_MODEL` | 强制所有子 model（最高，对齐 HC `CLAUDE_CODE_SUBAGENT_MODEL`） |
| `BOLO_SUBAGENT_EFFORT` | 强制所有子 effort |
| `BOLO_SUBAGENT_MAX_SPAWN_DEPTH` | 覆盖全局 `maxSpawnDepth` |
| `BOLO_BACKGROUND_OVERFLOW` | `overflow` |
| `BOLO_SUBAGENT_WORKTREE=1` | 默认尝试 worktree（已有） |

### 2.2 类型定义 — `agents/*.md`（保持 Markdown，不强制 TOML）

路径（合并顺序 **后者覆盖同名**）：

```text
builtin
  ← ~/.bolo/agents/*.md
  ← .bolo/agents/*.md
```

**Frontmatter 字段（v0）：**

| 字段 | 必填 | 来源灵感 | 说明 |
|------|:----:|----------|------|
| `name` / `agentType` / `id` | 是* | Codex `name` · HC `agentType` | 类型 id；缺省用文件名 |
| `description` | 是* | 两者 | 何时选用；进 Agent 工具描述 / `/agents` |
| body → `systemPrompt` | 是* | Codex `developer_instructions` · HC system | md body |
| `whenToUse` | 否 | HC | 可选；展示用，可与 description 同 |
| `model` | 否 | Codex + HC | `inherit` 或具体 model 字符串 |
| `effort` | 否 | HC `effort` · Codex `model_reasoning_effort` | 与 Bolo effort 档对齐：`low`\|`medium`\|`high`\|`max`（实现可接受 alias） |
| `tools` | 否 | HC | `*` 或列表；默认 `*` |
| `disallowedTools` | 否 | HC | 二次剔除；**嵌套常靠这里禁 `Agent`** |
| `permissionMode` | 否 | HC | 仍受「不得比父更宽」约束 |
| `maxTurns` | 否 | HC | 默认 run 侧 8；工具 `max_turns` 可覆盖 |
| `background` | 否 | HC | 定义级默认后台 |
| `isolation` | 否 | HC | `none` \| `worktree` |
| **`maxSpawnDepth`** | 否 | **Bolo 自研**（Codex 无、HC 用抠工具近似） | 本类型作为「父」时，允许的子相对深度策略，见 §4 |
| `sandbox` | 否 | Codex `sandbox_mode` 映射 | **v0 语法糖**：`read-only` ⇒ 工具收紧为只读集 + 禁写；不引入完整 sandbox runtime |

\* 内置类型写死；用户文件：无 name 用文件名；无 description 给默认句；无 body 给短默认 system。

**刻意不进 v0 agent 文件（后置）：**

- 整份 `mcp_servers` / `skills.config` 会话层（Codex 重）→ 继续继承父 MCP/skills，P1 再做 per-agent 裁剪  
- `memory` / teammate / remote isolation  
- 1h TTL prompt cache 共享

### 2.3 示例

`~/.bolo/config.json`：

```json
{
  "agents": {
    "maxConcurrent": 4,
    "defaultModel": "inherit",
    "defaultEffort": "medium",
    "maxSpawnDepth": 0
  }
}
```

`.bolo/agents/reviewer.md`：

```markdown
---
name: reviewer
description: PR risk review — correctness, security, tests
model: inherit
effort: high
sandbox: read-only
maxTurns: 12
maxSpawnDepth: 0
---

Review like an owner. Concrete findings with paths. No style-only noise.
```

允许「研究员再开 explore」的自定义类型：

```markdown
---
name: lead_research
description: Coordinates read-only explores
tools: Read, Glob, Grep, Agent
maxSpawnDepth: 1
---

You may spawn explore subagents only. Wait for summaries; do not edit files.
```

（仍受全局与运行时 depth 规则约束，见 §4。）

---

## 3. 解析优先级（模型 / effort / maxTurns）

对齐 Codex 文案，Bolo 固定为：

```text
1. 环境强制（BOLO_SUBAGENT_MODEL / BOLO_SUBAGENT_EFFORT）
2. Agent 工具调用参数（model / effort / max_turns）— 若实现暴露
3. AgentDefinition 文件字段
4. config.agents.defaultModel / defaultEffort
5. 父会话 model / effortLevel
6. 产品默认（model 未设 → inherit 语义；effort → medium 或父）
```

**Fork 特例（HC）：**

- messages / tools 继承父；**model 建议强制 inherit**（避免无意义的 cache 叙事；Bolo 无完整 cacheSafeParams，仍保持「fork 不换模型」简单规则）。  
- effort：默认 inherit 父；定义/工具显式可覆盖。

**Permission：**

- 继续 `resolveSubagentPermissionMode(parent, def)`：**子不得比父更宽**。  
- `sandbox: read-only` 在 resolve 工具之后再砍写工具，不抬权限。

---

## 4. 嵌套与 maxSpawnDepth（Bolo 核心差异）

### 4.1 语义

| 概念 | 定义 |
|------|------|
| 主会话 | `spawnDepth = 0`，**始终可**挂 Agent 工具（若 `agents.enabled`） |
| 子 loop | `spawnDepth = parentSpawnDepth + 1` |
| 某次 spawn 后子能否再带 Agent | 见下式 |

**有效「还能再 spawn」判定（v0）：**

```text
childSpawnDepth = parent.spawnDepth + 1

# 子工具表是否包含 Agent：
allowAgentTool =
  agents.enabled
  AND "Agent" not in effective disallowedTools
  AND (tools 白名单含 Agent 或 tools === '*')
  AND childSpawnDepth <= effectiveMaxSpawnDepth(parentDef, global)

# effectiveMaxSpawnDepth:
#   parent 是主会话（无 def）→ 视为 +∞（只受全局策略约束时：主永远能 spawn）
#   parent 是子 → def.maxSpawnDepth ?? global.maxSpawnDepth ?? 0
```

**默认：`maxSpawnDepth = 0`**

- 含义：任意 **子 agent**（depth≥1）的 `childSpawnDepth≥1` 时，`1 <= 0` 为假 → **子工具表去掉 Agent**。  
- 与当前 Bolo「始终 exclude Agent」行为 **兼容**。  
- 用户把某类型或全局设为 `1`，则 depth=1 的子可以再 spawn depth=2 的孙，孙默认仍不能继续（除非更高）。

> 注：这是 **Bolo 显式 depth**，比 HC「靠 tools 列表偶然打开」更清晰，也补上 Codex 文档缺失的嵌套旋钮。

### 4.2 与 tools 的关系

| 来源 | 行为 |
|------|------|
| `disallowedTools` 含 `Agent` | 永不给 Agent |
| `tools` 白名单不含 `Agent` 且非 `*` | 无 Agent |
| depth 规则失败 | 即使 `*` 也 **强制剔除 Agent** |
| fork | 工具表为「父集 − 按 depth/规则处理后的 Agent」；fork 子默认 depth 规则仍适用 |

### 4.3 不做（v0）

- 无限递归保护仅靠 depth + 硬 cap（建议实现：`maxSpawnDepth` 上限 clamp 到 3）。  
- 不实现 HC teammate / SendMessage 续聊。

---

## 5. Agent 工具输入（主 → 子）

在现有字段上扩展（实现分阶段）：

| 输入 | 状态 | 说明 |
|------|------|------|
| `prompt` | 已有 | 完整任务 brief |
| `description` | 已有 | 3–5 词 UI 标签 |
| `subagent_type` / `fork` | 已有 | 类型 / 继承会话 |
| `run_in_background` / `async` | 已有 | 后台 |
| `max_turns` | 已有 | 覆盖 def |
| `isolation` | 已有 | worktree |
| **`model`** | **待做** | 覆盖 def / default |
| **`effort`** | **待做** | 覆盖 def / default |

工具描述：继续 `buildAgentToolDescription`（列类型 + whenToUse）。

---

## 6. 运行时数据流

```text
createSession
  → load config.agents + loadAgentsDir
  → agents.enabled ? tools 含 Agent : 不含
  → session.agentPolicy / agentDefinitions

queryLoop (spawnDepth)
  → toolExecution.subagentParent {
        spawnDepth, parentUsage, model, effort,
        agentPolicy, agentDefinitions, ...
     }
  → Agent.call
       resolve def
       resolve model/effort/maxTurns（§3）
       resolve tools（§4 + resolveAgentTools）
       runSubagent({ spawnDepth: parent+1, model, effort, ... })
  → finalize stats + merge usage → parent
  → tool_result 摘要
```

**子 queryLoop 必须带：**

- `model`（provider 用）  
- `effortLevel`（已有 queryLoop 字段，接上即可）  
- `spawnDepth`（新，进 context / 再 spawn）

---

## 7. 内置类型（v0 目标态）

| type | 角色 | model 默认 | effort 默认 | maxSpawnDepth | 工具要点 |
|------|------|------------|-------------|---------------|----------|
| `explore` | 只读探索 | inherit 或轻量* | medium | 0 | Read/Glob/Grep；disallow 写/Bash/Agent |
| `plan` | 只读规划 | inherit | high | 0 | 同 explore；permissionMode=plan |
| `general` | 可写执行 | inherit | inherit/medium | 0 | `*` − Agent |
| `fork` | 继承父上下文 | **inherit 强制** | inherit | 0 | 父工具 − Agent（depth） |

\* 轻量 model 仅当用户配置 `defaultModel` 或类型 `model`；不绑死厂商 id。

---

## 8. 与现状差距（实现清单）

| # | 项 | 现状 | v0 目标 |
|---|-----|------|---------|
| S-A0 | `config.agents` schema + 合并 | ✅ | types + load + `resolveAgentPolicy` |
| S-A1 | frontmatter `model` / `effort` / `maxSpawnDepth` / `sandbox` | ✅ | 解析进 AgentDefinition |
| S-A2 | model 解析链 + 传入 callModel | ✅ | provider `options.model` 覆盖 |
| S-A3 | effort 传入子 queryLoop | ✅ | `effortLevel` |
| S-A4 | spawnDepth 贯穿 + 条件保留 Agent | ✅ | §4 规则 |
| S-A5 | Agent 工具 `model`/`effort` 参数 | ✅ | schema + call |
| S-A6 | `agents.enabled` 控制是否挂工具 | ✅ | createDefaultTools / session |
| S-A7 | 文档 + 测试 | ✅ | test-subagent Spec v0 |
| S-A3 | effort 传入子 queryLoop | 未接 | 接 effortLevel |
| S-A4 | spawnDepth 贯穿 + 条件保留 Agent | 恒删 Agent | §4 规则 |
| S-A5 | Agent 工具 `model`/`effort` 参数 | 无 | schema + call |
| S-A6 | `agents.enabled` 控制是否挂工具 | 无 | createDefaultTools / session |
| S-A7 | 文档 + 测试 | 部分 | test-subagent 扩 |

**已有、本 spec 不重做：** loadAgentsDir、disallowedTools、background cap、usage 回卷、finalize stats、worktree cleanup、permission 不升级、fork 消息继承。

---

## 9. 测试验收（开工后）

```bash
npx tsx scripts/test-subagent.ts
# 新增断言建议：
# - 默认 depth：子 tools 无 Agent
# - def.maxSpawnDepth=1 + tools=*：子有 Agent，孙无 Agent
# - model 链：工具参数 > 文件 > config.default > 父
# - effort 传入子 loop（mock 可读 options）
# - agents.enabled=false：default tools 无 Agent
# - sandbox: read-only 无 Write
```

---

## 10. 非目标（明确砍掉）

| 不做 | 原因 |
|------|------|
| Codex 式「agent 文件 = 全量 config.toml」 | 过重；Bolo 用 frontmatter 子集 |
| HC swarm / teammate / SendMessage 续聊 | 产品与复杂度 |
| 全局 prompt cache 字节共享 | 后置；fork 仅消息继承 |
| 遥测 / 官方市场 | 红线 |
| 数字 depth 无限 | clamp ≤ 3 |

---

## 11. 开工顺序建议

1. **S-A0 + S-A1** — schema 与 frontmatter（纯数据，可测）  
2. **S-A4** — spawnDepth + 条件 Agent（行为核心）  
3. **S-A2 + S-A3 + S-A5** — model/effort 接线  
4. **S-A6** — enabled 开关  
5. **S-A7** — 测例 + `SUBAGENT.md` 同步「已实现」

---

## 12. 一句话

**Bolo Subagent = HC 的工具/权限/fork/async 骨架 + Codex 的全局 default 与 model/effort 优先级 + 自研 `maxSpawnDepth` 嵌套旋钮；配置落在 `config.agents` + `~/.bolo/agents` / `.bolo/agents` Markdown，默认子不能再分发。**