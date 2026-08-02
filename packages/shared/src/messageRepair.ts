/**
 * ROB-2: 工具消息配对修复纯契约。
 *
 * 目标：崩溃/中断/写入截断遗留的残缺消息表在恢复时自动修复，避免 resume 后
 * 模型看到悬空的 tool_call、孤儿 tool result 或重复结果。
 *
 * 规则（全部 fail-closed）：
 * - 悬空声明：assistant 消息声明了 tool_calls 但没有对应 tool result →
 *   从该消息移除该调用；若消息只剩调用（正文/思考为空）则整条删除，
 *   否则降级为纯文本消息。
 * - 孤儿结果：tool 消息的 tool_call_id 没有任何 assistant 声明 → 丢弃。
 * - 重复声明：同一 tool_call_id 被多次声明 → 只保留第一次声明。
 * - 重复结果：同一 tool_call_id 有多条 tool 消息 → 只保留第一条。
 * - 幂等：修复后的消息表再次修复结果不变。
 *
 * 不改变合法消息；不触碰 user/纯 assistant/系统消息。
 */
import type { ChatMessage } from './index.ts'

export function repairToolMessagePairs(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  // 第一遍：声明与结果集合
  const declaredIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) declaredIds.add(call.id)
    } else if (message.role === 'tool' && message.tool_call_id) {
      resultIds.add(message.tool_call_id)
    }
  }
  const validIds = new Set<string>()
  for (const id of resultIds) {
    if (declaredIds.has(id)) validIds.add(id)
  }

  // 第二遍：重建
  const seenDeclaration = new Set<string>()
  const seenResult = new Set<string>()
  const repaired: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const kept = message.tool_calls.filter((call) => {
        if (seenDeclaration.has(call.id)) return false
        seenDeclaration.add(call.id)
        return validIds.has(call.id)
      })
      if (kept.length === 0) {
        if (!message.content?.trim() && !message.reasoning_content?.trim()) {
          continue
        }
        const { tool_calls: _dropped, ...textOnly } = message
        repaired.push(textOnly)
        continue
      }
      repaired.push(
        kept.length === message.tool_calls.length
          ? message
          : { ...message, tool_calls: kept },
      )
      continue
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id
      if (!id || !validIds.has(id) || seenResult.has(id)) continue
      seenResult.add(id)
      repaired.push(message)
      continue
    }
    repaired.push(message)
  }
  return repaired
}
