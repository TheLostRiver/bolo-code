/**
 * CX1：内置 provider preset（纯数据，不发网）。
 * 见 docs/PROVIDER_UX.md
 */

import type { ProviderConfigJson } from './types.ts'
import type { ProviderKindName } from './providerRegistry.ts'

export type ProviderPreset = {
  id: string
  label: string
  kind: ProviderKindName
  baseUrl?: string
  model?: string
  /** 建议 env 名；写入 config 的 apiKeyEnv，永不写明文 key */
  apiKeyEnv?: string
  /** effort.dialect 内置 id；缺省由 detect */
  effortDialect?: string
  /** /model 建议列表（可选） */
  models?: string[]
  notes?: string
}

/** 日用 5 个 preset（稳健优先，少而准） */
export const BUILTIN_PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI Chat Completions',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'],
    notes: 'Chat Completions；effort 默认 max-tokens / detect',
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses API',
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiKeyEnv: 'OPENAI_API_KEY',
    effortDialect: 'openai-responses',
    models: ['gpt-4o', 'o3', 'o4-mini'],
    notes: '原生 /responses；reasoning.effort',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Messages',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    effortDialect: 'anthropic-output',
    models: [
      'claude-sonnet-4-20250514',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
    ],
    notes: 'output_config.effort + beta；max 有模型门控',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Chat',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    effortDialect: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    notes: '兼容口 + reasoning_effort high|max',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow (中转)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    effortDialect: 'deepseek-chat',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-72B-Instruct',
    ],
    notes: '兼容口；默认 deepseek-chat 方言，可改',
  },
] as const

export function listProviderPresets(): ProviderPreset[] {
  return BUILTIN_PROVIDER_PRESETS.map((p) => ({ ...p, models: p.models ? [...p.models] : undefined }))
}

export function getProviderPreset(idOrAlias: string): ProviderPreset | undefined {
  const t = idOrAlias.trim().toLowerCase()
  if (!t) return undefined
  const aliases: Record<string, string> = {
    oai: 'openai',
    'openai-chat': 'openai',
    completions: 'openai',
    responses: 'openai-responses',
    claude: 'anthropic',
    ds: 'deepseek',
    sf: 'siliconflow',
    silicon: 'siliconflow',
  }
  const id = aliases[t] ?? t
  const found = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === id)
  if (!found) return undefined
  return {
    ...found,
    models: found.models ? [...found.models] : undefined,
  }
}

/** preset → 可写入 config.providers 的 JSON（无明文 key） */
export function providerConfigFromPreset(
  preset: ProviderPreset,
  overrides?: {
    model?: string
    baseUrl?: string
    apiKeyEnv?: string
    label?: string
  },
): ProviderConfigJson {
  const model = overrides?.model?.trim() || preset.model
  const baseUrl = overrides?.baseUrl?.trim() || preset.baseUrl
  const apiKeyEnv = overrides?.apiKeyEnv?.trim() || preset.apiKeyEnv
  const label = overrides?.label?.trim() || preset.label
  return {
    kind: preset.kind,
    ...(label ? { label } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(preset.effortDialect
      ? { effort: { dialect: preset.effortDialect } }
      : {}),
  }
}

export function formatProviderPresetLine(p: ProviderPreset): string {
  const dialect = p.effortDialect ? `  effort=${p.effortDialect}` : ''
  const env = p.apiKeyEnv ? `  env=${p.apiKeyEnv}` : ''
  return `  ${p.id.padEnd(18)} ${p.kind}${env}${dialect}  · ${p.label}`
}

export function formatProviderPresetsHelp(): string {
  const lines = [
    'builtin presets (no API key written — only apiKeyEnv):',
    ...listProviderPresets().map(formatProviderPresetLine),
    'usage: /provider add <preset> [as <id>]',
    '       /provider add list',
    'then:  set env key · /provider use <id>',
  ]
  return lines.join('\n')
}