/**
 * CLI 用 provider：无 key 时允许 resume 加载，callModel 时给出清晰错误。
 * 显式 BOLO_PROVIDER=mock 仍用 mock（测试）。
 */

import {
  createMockProvider,
  createProviderFromEnv,
  detectProviderKind,
  type LlmProvider,
  type ProviderStreamEvent,
} from '../../providers/src/index.ts'

const NO_KEY_MSG =
  'No LLM API key configured. Set BOLO_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY, or set BOLO_PROVIDER=mock for offline mock.'

function envExplicitMock(): boolean {
  const v = process.env.BOLO_PROVIDER?.toLowerCase().trim()
  return v === 'mock'
}

function createMissingKeyProvider(): LlmProvider {
  return {
    id: 'mock',
    async *completeStream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'error', message: NO_KEY_MSG }
    },
    async completeText(): Promise<string> {
      throw new Error(NO_KEY_MSG)
    },
  }
}

export type CliProviderInfo = {
  provider: LlmProvider
  kind: string
  model?: string
  /** true：无 key，resume 可用但 callModel 会失败 */
  missingKey: boolean
}

export function createCliProvider(options?: {
  forceMock?: boolean
}): CliProviderInfo {
  if (options?.forceMock || envExplicitMock()) {
    return {
      provider: createMockProvider(),
      kind: 'mock',
      missingKey: false,
    }
  }

  const kind = detectProviderKind()
  if (kind === 'mock') {
    // 无 key 且未显式 mock → 延迟失败 provider
    return {
      provider: createMissingKeyProvider(),
      kind: 'none',
      missingKey: true,
    }
  }

  const env = createProviderFromEnv()
  return {
    provider: env.provider,
    kind: env.kind,
    model: env.model,
    missingKey: false,
  }
}

export { NO_KEY_MSG }