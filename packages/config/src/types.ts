/**
 * 配置 schema（JSON 可序列化）
 */

import type { HooksConfig } from '../../shared/src/index.ts'
import type { PermissionMode } from '../../permissions/src/index.ts'

export type ProviderConfigJson = {
  /** mock | openai-compatible | anthropic */
  kind?: 'mock' | 'openai-compatible' | 'anthropic'
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
  /** 是否启用 auto compact（挂 prepareMessages 时用） */
  autoCompactEnabled?: boolean
  /** 模型上下文窗口估计（auto compact） */
  contextWindowTokens?: number
}

export type McpFileJson = {
  mcpServers?: Record<
    string,
    {
      command: string
      args?: string[]
      env?: Record<string, string>
      tools?: { name: string; description?: string }[]
    }
  >
  servers?: Array<{
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
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
  autoCompactEnabled: false,
  contextWindowTokens: 128_000,
}

export const DEFAULT_MCP_FILE: McpFileJson = {
  mcpServers: {},
}

export const DEFAULT_HOOKS_FILE: HooksFileJson = {}