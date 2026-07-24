/**
 * 配置 schema（JSON 可序列化）
 */

import type { HooksConfig } from '../../shared/src/index.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'

export type ProviderConfigJson = {
  /** mock | openai-compatible | openai-responses | anthropic */
  kind?: 'mock' | 'openai-compatible' | 'openai-responses' | 'anthropic'
  apiKey?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  /** Anthropic max_tokens */
  maxTokens?: number
}

export type BoloConfigJson = {
  /** schema 版本 */
  version?: number
  provider?: ProviderConfigJson
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
}

export const DEFAULT_MCP_FILE: McpFileJson = {
  mcpServers: {},
}

export const DEFAULT_HOOKS_FILE: HooksFileJson = {}