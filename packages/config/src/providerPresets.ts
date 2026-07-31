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
  {
    id: 'openrouter',
    label: 'OpenRouter (聚合)',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'deepseek/deepseek-chat-v3-0324',
    ],
    notes: '兼容口；聚合各家模型，模型 id 带厂商前缀',
  },
  {
    id: 'groq',
    label: 'Groq (LPU)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    apiKeyEnv: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    notes: '兼容口；推理强度走 reasoning_effort / detect',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    apiKeyEnv: 'TOGETHER_API_KEY',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct',
    ],
    notes: '兼容口',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    notes: '兼容口',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
    apiKeyEnv: 'XAI_API_KEY',
    models: ['grok-4', 'grok-3-mini'],
    notes: '兼容口；reasoning 档位见 effort detect',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    apiKeyEnv: 'NVIDIA_API_KEY',
    models: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1'],
    notes: '兼容口',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    models: [
      'accounts/fireworks/models/llama-v3p1-70b-instruct',
      'accounts/fireworks/models/deepseek-r1',
    ],
    notes: '兼容口；模型 id 长，可用 /model 精确设置',
  },
  {
    id: 'cerebras',
    label: 'Cerebras (Wafer)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    models: ['llama-3.3-70b', 'llama-3.1-8b'],
    notes: '兼容口',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face (Router)',
    kind: 'openai-compatible',
    baseUrl: 'https://router.huggingface.co/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    apiKeyEnv: 'HF_TOKEN',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'deepseek-ai/DeepSeek-R1',
    ],
    notes: '兼容口；HF_TOKEN 为 read token',
  },
  {
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    kind: 'openai-compatible',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    model: 'anthropic/claude-sonnet-4',
    apiKeyEnv: 'VERCEL_AI_GATEWAY_TOKEN',
    notes: '兼容口；模型 id 带厂商前缀，网关侧配置密钥',
  },
  {
    id: 'cloudflare-ai-gateway',
    label: 'Cloudflare AI Gateway',
    kind: 'openai-compatible',
    baseUrl: 'https://gateway.ai.cloudflare.com/v1',
    model: 'anthropic/claude-sonnet-4',
    apiKeyEnv: 'CLOUDFLARE_AI_GATEWAY_TOKEN',
    notes: '兼容口；模型 id 带厂商前缀，网关侧配置密钥',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-turbo-preview',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    models: ['kimi-k2-turbo-preview', 'kimi-k2-0711-preview', 'moonshot-v1-32k'],
    notes: '兼容口',
  },
  {
    id: 'zhipu',
    label: '智谱 (GLM)',
    kind: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5',
    apiKeyEnv: 'ZHIPU_API_KEY',
    models: ['glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
    notes: '兼容口',
  },
  {
    id: 'zai',
    label: 'Z.ai (GLM 国际)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/v1',
    model: 'glm-4.5',
    apiKeyEnv: 'ZAI_API_KEY',
    models: ['glm-4.5', 'glm-4.5-air'],
    notes: '兼容口；国际端点',
  },
  {
    id: 'qwen',
    label: '阿里云百炼 (Qwen)',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    notes: '兼容口；DASHSCOPE_API_KEY 即百炼 API-KEY',
  },
  {
    id: 'doubao',
    label: '火山方舟 (豆包)',
    kind: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-250615',
    apiKeyEnv: 'ARK_API_KEY',
    models: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-250615-256k'],
    notes: '兼容口；可用推理接入点 ID（ep-xxx）作 model',
  },
  {
    id: 'minimax',
    label: 'MiniMax (国际)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-Text-01',
    apiKeyEnv: 'MINIMAX_API_KEY',
    models: ['MiniMax-Text-01'],
    notes: '兼容口',
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax (国内)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-Text-01',
    apiKeyEnv: 'MINIMAX_CN_API_KEY',
    models: ['MiniMax-Text-01'],
    notes: '兼容口',
  },
  {
    id: 'baidu',
    label: '百度千帆 (ERNIE)',
    kind: 'openai-compatible',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-4.5-8k-preview',
    apiKeyEnv: 'QIANFAN_API_KEY',
    models: ['ernie-4.5-8k-preview', 'ernie-4.0-turbo-8k'],
    notes: '兼容口',
  },
  {
    id: 'baichuan',
    label: '百川智能',
    kind: 'openai-compatible',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    model: 'Baichuan4-Turbo',
    apiKeyEnv: 'BAICHUAN_API_KEY',
    models: ['Baichuan4-Turbo'],
    notes: '兼容口',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 (StepFun)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-2-16k',
    apiKeyEnv: 'STEPFUN_API_KEY',
    models: ['step-2-16k', 'step-1-32k'],
    notes: '兼容口',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    kind: 'openai-compatible',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbos-latest',
    apiKeyEnv: 'HUNYUAN_API_KEY',
    models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest'],
    notes: '兼容口',
  },
  {
    id: 'lingyi',
    label: '零一万物 (Yi)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    model: 'yi-lightning',
    apiKeyEnv: 'LINGYI_API_KEY',
    models: ['yi-lightning', 'yi-large'],
    notes: '兼容口',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra (聚合)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'deepseek-ai/DeepSeek-R1',
    ],
    notes: '兼容口；模型 id 带厂商前缀',
  },
  {
    id: 'perplexity',
    label: 'Perplexity (sonar)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.perplexity.ai',
    model: 'sonar-pro',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    models: ['sonar-pro', 'sonar'],
    notes: '兼容口；/chat/completions',
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
    or: 'openrouter',
    grok: 'xai',
    mistral: 'mistral',
    hf: 'huggingface',
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