/**
 * 配置 schema（JSON 可序列化）
 */

import type { HooksConfig } from '../../shared/src/index.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'

export type ProviderConfigJson = {
  /** mock | openai-compatible | openai-responses | anthropic */
  kind?: 'mock' | 'openai-compatible' | 'openai-responses' | 'anthropic'
  /** 显示名；缺省用 providers map 的 key */
  label?: string
  /**
   * 明文 key（不推荐写入仓库）。
   * 优先 `apiKeyEnv` 或进程环境变量。
   */
  apiKey?: string
  /**
   * 从该环境变量名读 key（如 `DEEPSEEK_API_KEY`）。
   * 有值时优先于全局 OPENAI_/ANTHROPIC_/BOLO_ 回落。
   */
  apiKeyEnv?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  /** Anthropic max_tokens */
  maxTokens?: number
  /**
   * Effort 方言（E 轨）：内置 id 或内联表。
   * 例：`"deepseek-chat"` · `"openai-responses"` · `"max-tokens"`
   * 或 `{ dialect: "deepseek-chat" }` / 完整 EffortDialect 对象。
   * 见 docs/EFFORT.md
   */
  effort?:
    | string
    | {
        dialect?: string | Record<string, unknown>
      }
    | Record<string, unknown>
}

export type BoloConfigJson = {
  /** schema 版本 */
  version?: number
  /**
   * 旧：单后端。无 `providers` 时合成 id=`default`。
   * 与 `providers` 共存时：`providers` 为主；可选把本字段填进缺省 `default`。
   */
  provider?: ProviderConfigJson
  /**
   * 命名后端表（P 轨）。运行时 `/provider use <id>` 热切。
   * 见 docs/ROADMAP.md §9 · docs/PROVIDERS.md。
   */
  providers?: Record<string, ProviderConfigJson>
  /** 启动默认 provider id；缺省 `default` 或 map 第一项 */
  defaultProvider?: string
  /** 默认权限模式 */
  permissionMode?: PermissionMode
  /**
   * 是否启用 auto compact（挂 prepareMessages 时用）。
   * 默认 true（对照参考全局 config）；可用 config / 会话 / 环境变量关掉。
   */
  autoCompactEnabled?: boolean
  /** 模型上下文窗口估计（auto compact） */
  contextWindowTokens?: number
  /**
   * Microcompact（清旧 tool_result，无 LLM）。
   * 默认 true；false 关闭。细项见 createSession({ microcompact })。
   */
  microcompactEnabled?: boolean
  /**
   * callModel / compact summarizer 命中 PTL（上下文过长）时截断重试次数。
   * 默认 3；0 = 关闭。
   */
  maxPtlRetries?: number
  /**
   * S-PORT-2：可选旁路 skill 根目录列表（每根：`<id>/SKILL.md`）。
   * **默认省略/空 = 不扫描**（不静默吃 `~/.agents/skills` 等）。
   * user + project 数组合并去重；相对路径相对**项目 cwd**。
   * 合并位次：bundled → extra → user → project → plugin。
   */
  extraSkillRoots?: string[]
  /**
   * IMPORT-P1：外来插件根目录列表（只读映射 skills）。
   * 识别 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 等；
   * **不**加载 hooks/commands；**不**接官方市场。默认 off。
   */
  foreignPluginRoots?: string[]
  /**
   * Subagent 全局策略（见 docs/SUBAGENT_SPEC.md v0）。
   * 缺省：enabled、maxConcurrent=3、defaultModel=inherit、maxSpawnDepth=0。
   */
  agents?: AgentsConfigJson
}

/** config.json → agents 段（可序列化） */
export type AgentsConfigJson = {
  enabled?: boolean
  maxConcurrent?: number
  defaultModel?: string
  defaultEffort?: string
  /** 子 agent 默认能否再 spawn；0=主可 spawn、子不可（默认） */
  maxSpawnDepth?: number
  overflow?: 'reject' | 'queue'
}

export const DEFAULT_AGENTS_CONFIG: Required<
  Pick<
    AgentsConfigJson,
    'enabled' | 'maxConcurrent' | 'defaultModel' | 'maxSpawnDepth' | 'overflow'
  >
> &
  AgentsConfigJson = {
  enabled: true,
  maxConcurrent: 3,
  defaultModel: 'inherit',
  maxSpawnDepth: 0,
  overflow: 'reject',
}

export type McpFileJson = {
  mcpServers?: Record<
    string,
    {
      /** 缺省：有 command→stdio，有 url→http */
      type?: 'stdio' | 'http' | 'sse'
      command?: string
      args?: string[]
      env?: Record<string, string>
      /** http / sse endpoint */
      url?: string
      headers?: Record<string, string>
      /** sse 自动重连次数（0–10） */
      reconnectAttempts?: number
      reconnectDelayMs?: number
      tools?: { name: string; description?: string }[]
    }
  >
  servers?: Array<{
    name: string
    type?: 'stdio' | 'http' | 'sse'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    reconnectAttempts?: number
    reconnectDelayMs?: number
    tools?: { name: string; description?: string }[]
  }>
}

export type HooksFileJson = HooksConfig

export const DEFAULT_CONFIG: BoloConfigJson = {
  version: 1,
  provider: {
    kind: 'openai-compatible',
    model: 'gpt-4o-mini',
  },
  permissionMode: 'default',
  autoCompactEnabled: true,
  contextWindowTokens: 128_000,
  microcompactEnabled: true,
  maxPtlRetries: 3,
  agents: {
    enabled: true,
    maxConcurrent: 3,
    defaultModel: 'inherit',
    defaultEffort: 'medium',
    maxSpawnDepth: 0,
    overflow: 'reject',
  },
}

/**
 * 初始化写入的 config.json 文本（JSONC：允许 // 注释）。
 * 加载端 stripJsonc；见 packages/config/src/io.ts。
 */
export const DEFAULT_CONFIG_JSONC = `{
  // Bolo config.json（JSONC：可用 // 与 /* */ 注释；勿提交 API Key）
  // 合并：defaults < ~/.bolo/config.json < .bolo/config.json < 环境变量
  // 详见 docs/CONFIG.md · docs/PROVIDERS.md · docs/SUBAGENT_SPEC.md

  "version": 1,

  // ── 单后端（旧字段，仍支持）──
  "provider": {
    // kind: mock | openai-compatible | openai-responses | anthropic
    "kind": "openai-compatible",
    // "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
    // apiKey 优先用环境变量；不要写进仓库
  },

  // ── 多后端（P 轨，可选）──
  // "defaultProvider": "work",
  // "providers": {
  //   "work": {
  //     "kind": "openai-compatible",
  //     "baseUrl": "https://api.openai.com/v1",
  //     "model": "gpt-4o-mini",
  //     "apiKeyEnv": "OPENAI_API_KEY"
  //   },
  //   "deepseek": {
  //     "kind": "openai-compatible",
  //     "baseUrl": "https://api.deepseek.com",
  //     "model": "deepseek-chat",
  //     "apiKeyEnv": "DEEPSEEK_API_KEY"
  //   }
  // },
  // 运行中 /provider use <id> 热切，无需重启

  // default | acceptEdits | plan | auto | bypassPermissions
  "permissionMode": "default",

  "autoCompactEnabled": true,
  "contextWindowTokens": 128000,
  "microcompactEnabled": true,
  "maxPtlRetries": 3,

  // ── Subagent 全局策略（docs/SUBAGENT_SPEC.md）──
  "agents": {
    // false = 主会话不挂 Agent 工具
    "enabled": true,

    // 后台 subagent 并发上限（也可用环境变量 BOLO_MAX_BACKGROUND_AGENTS）
    "maxConcurrent": 3,

    // 子 agent 默认 model：inherit = 跟父会话；或具体 model id
    // 解析优先级：BOLO_SUBAGENT_MODEL > Agent 工具 model 参数 > agents/*.md >
    //   本字段 > 父会话 model
    "defaultModel": "inherit",

    // 子默认 effort：low | medium | high | max | inherit
    // 环境变量 BOLO_SUBAGENT_EFFORT 可强制覆盖
    "defaultEffort": "medium",

    // 嵌套深度：主会话 spawnDepth=0 始终可 spawn（若 enabled）
    // 0 = 默认「只有主能分发」；子 depth≥1 不能再挂 Agent
    // 1 = 子还可再 spawn 一层孙；上限 clamp 到 3
    // 单类型可用 agents/*.md frontmatter maxSpawnDepth 覆盖
    // 环境变量：BOLO_SUBAGENT_MAX_SPAWN_DEPTH
    "maxSpawnDepth": 0,

    // 后台满时：reject | queue
    "overflow": "reject"
  }

  // "extraSkillRoots": [],
  // "foreignPluginRoots": []
}
`

/** 写入 agents/ 目录的说明（Markdown，非 frontmatter 定义） */
export const DEFAULT_AGENTS_README = `# Bolo agents/ — 自定义 subagent 类型

每个 \`*.md\` 一个类型。合并顺序（后者覆盖同名）：

\`\`\`text
builtin (explore / general / plan / fork)
  ← ~/.bolo/agents/*.md
  ← .bolo/agents/*.md
\`\`\`

## Frontmatter 字段

\`\`\`markdown
---
# 类型 id（也可用 name / agentType / id；缺省=文件名）
name: reviewer

# 何时选用（给主模型 / /agents 列表）
description: PR risk review — correctness, security, tests

# 可选：inherit 或具体 model
model: inherit

# 可选：low | medium | high | max | inherit（也认 Codex 的 model_reasoning_effort）
effort: high

# 可选：本类型作为「父」时允许的最大 spawnDepth（0=不能再 spawn）
maxSpawnDepth: 0

# 可选：最大 agentic turns
maxTurns: 12

# 可选：default | acceptEdits | plan | auto | bypassPermissions（不得比父更宽）
# permissionMode: default

# 可选：工具白名单 * 或列表；disallowedTools 二次剔除
# tools: Read, Glob, Grep
# disallowedTools: Write, Edit, Bash, Agent

# 可选：none | worktree；background: true 默认后台
# isolation: none
# background: false

# 可选语法糖：read-only → 只读工具集
# sandbox: read-only
---

这里是 system 正文（developer_instructions）。
\`\`\`

## 嵌套示例（允许再开一层 explore）

\`\`\`markdown
---
name: lead_research
description: Coordinates read-only explores
tools: "*"
maxSpawnDepth: 1
model: inherit
effort: medium
---

You may spawn explore subagents. Wait for summaries; do not edit files.
\`\`\`

全局默认见上级 \`config.json\` 的 \`"agents"\` 段。契约：\`docs/SUBAGENT_SPEC.md\`。
`

export const DEFAULT_MCP_FILE: McpFileJson = {
  mcpServers: {},
}

export const DEFAULT_HOOKS_FILE: HooksFileJson = {}