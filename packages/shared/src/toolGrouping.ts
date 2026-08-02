/**
 * OUT-5: 相邻只读工具调用聚合纯契约。
 *
 * 职责边界：
 * - 把单个 turn 内相邻的只读 tool block（presentation 分类为 read/search，
 *   如 Read/ReadFile/Grep/Glob 及含 search/find 命名的工具）聚合成组。
 * - 纯函数、无副作用：不持有 renderer/terminal 状态，不改变模型消息、
 *   transcript 或 snapshot。组是展示层投影，成员身份（block id/callId）不变。
 * - 切断条件（块序列层面）：非只读 tool 块（写/Bash/mcp/generic 等）、
 *   running/interrupted/失败工具、user/assistant/有文本的 reasoning/error/
 *   warning/summary 块都会关闭当前组。空文本 reasoning 块（工具循环内的思考
 *   耗时占位）不切断：成员 ≥2 成组时被组整体吸收（含组首尾占位），成员不足
 *   时原样保留。
 * - 权限请求不是 transcript 块（走 overlay），在块层面无法表达，由
 *   「非只读块切断」近似覆盖。
 * - MCP 工具（`mcp__*`）无法从名字判定只读性，按设计取舍不聚合。
 */
import type { CliTuiBlock, CliTuiToolBlock } from './cliTuiViewState.ts'
import { classifyToolPresentation } from './toolPresentation.ts'

/** 至少两个成员才成组；单个只读调用保持普通块展示。 */
export const READ_ONLY_GROUP_MIN_MEMBERS = 2

export type ReadToolGroup = {
  kind: 'read-group'
  members: readonly CliTuiToolBlock[]
}

export type CliTuiBlockProjection = CliTuiBlock | ReadToolGroup

/** 该 tool block 是否可参与只读聚合（终态成功且分类为 read/search）。 */
export function isReadOnlyGroupableToolBlock(
  block: CliTuiToolBlock,
): boolean {
  if (block.status === 'running' || block.status === 'interrupted') {
    return false
  }
  if (block.status === 'error' || block.ok === false) return false
  const kind = classifyToolPresentation(block.name, false)
  return kind === 'read' || kind === 'search'
}

/** 空文本 reasoning 块是工具循环内的思考耗时占位：不切断组、成组时被吸收。 */
export function isAbsorbableThinkingBlock(block: CliTuiBlock): boolean {
  return (
    block.kind === 'reasoning' &&
    typeof block.text === 'string' &&
    block.text.trim().length === 0
  )
}

type PendingEntry =
  | { kind: 'member'; block: CliTuiToolBlock }
  | { kind: 'gap'; block: CliTuiBlock }

/**
 * 对单个 turn 的块列表投影：相邻只读工具合成组，其余保持原样。
 * 输出顺序与输入一致；组内成员保持原顺序；成组时成员间的空思考占位被吸收。
 */
export function groupAdjacentReadTools(
  blocks: readonly CliTuiBlock[],
): CliTuiBlockProjection[] {
  const result: CliTuiBlockProjection[] = []
  let pending: PendingEntry[] = []
  const flush = (): void => {
    const members = pending.filter(
      (entry): entry is { kind: 'member'; block: CliTuiToolBlock } =>
        entry.kind === 'member',
    )
    if (members.length >= READ_ONLY_GROUP_MIN_MEMBERS) {
      result.push({
        kind: 'read-group',
        members: members.map((entry) => entry.block),
      })
    } else {
      for (const entry of pending) result.push(entry.block)
    }
    pending = []
  }
  for (const block of blocks) {
    if (block.kind === 'tool' && isReadOnlyGroupableToolBlock(block)) {
      pending.push({ kind: 'member', block })
      continue
    }
    if (isAbsorbableThinkingBlock(block)) {
      pending.push({ kind: 'gap', block })
      continue
    }
    flush()
    result.push(block)
  }
  flush()
  return result
}
