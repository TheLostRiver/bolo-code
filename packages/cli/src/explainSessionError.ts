/**
 * 把 provider 原始错误接到 CX3 的解释层。
 *
 * `explainProviderError` 早就存在，但产品代码一次都没调过——用户看到的一直是
 * `error: fetch failed` 这种没法行动的原文。这里把它绑到**活跃 session** 上，
 * 好让提示能带上真实的 provider / model / baseUrl / apiKeyEnv。
 *
 * 晚绑定：printer 在 session 建好之前就要造出来，所以取的是一个可变引用，
 * 与 showThinking 用的是同一手法。
 */

import { explainProviderError } from '../../providers/src/index.ts'
import type { BoloSession } from '../../core/src/index.ts'

export type SessionRef = { session: BoloSession | null }

/**
 * 造一个绑定到 sessionRef 的解释函数。
 * session 还没就位时退回原文——宁可少给提示，也不要编造上下文。
 */
export function createSessionErrorExplainer(
  ref: SessionRef,
): (message: string) => string {
  return (message: string): string => {
    const session = ref.session
    if (!session) return message
    try {
      const profile = session.providerProfile
      return explainProviderError(message, {
        ...(session.providerId ? { providerId: session.providerId } : {}),
        ...(profile?.kind ? { kind: profile.kind } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.effortLevel ? { effortLevel: session.effortLevel } : {}),
        ...(profile?.baseUrl ? { baseUrl: profile.baseUrl } : {}),
        ...(profile?.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {}),
        // 只透传 dialect id；内联 dialect 对象与解释层的入参类型不同，
        // 而 dialect 那一行本来就是可选的锦上添花
        ...(typeof session.effortDialect === 'string'
          ? { dialect: session.effortDialect }
          : {}),
      })
    } catch {
      // 解释失败绝不能吃掉原始错误
      return message
    }
  }
}
