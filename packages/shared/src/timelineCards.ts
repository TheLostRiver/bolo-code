/**
 * AR3C · 内容卡片视图模型（纯函数）
 *
 * 把 `TimelineTurn[]` 摊成一串可渲染的卡片，并**在 packages 里就决定好**
 * 每张卡折叠还是展开、要不要截断、状态是什么。renderer 只负责把纯文本
 * 放进 DOM——薄壳纪律要求它不重算业务状态，折叠策略也是业务判断。
 *
 * ## 折叠策略来自反面教材
 *
 * Codex App 被专门开过 issue（#16415）：消息流里工具调用/步骤**默认全部折叠**，
 * 即使开到最详也要反复手点展开，导致「很难实时监督并 steer」。
 * 折叠省的是空间，杀掉的却是 agent 界面最该有的东西——看着它干活。
 *
 * 规则因此是三条，按用户实际需要盯什么排的：
 *
 * - **正在跑的展开**：这是唯一需要实时看的东西
 * - **跑完的折叠**：三十条已完成的历史铺满屏幕只会淹没上面那一条
 * - **出错的永远展开**：失败是用户必须看到的，折叠它等于把问题藏起来
 *
 * ## 截断必须可见
 *
 * 超长输出要截，但截了就得说。悄悄截断会让人以为工具真的只返回了那么多——
 * 与本项目一路在防的「显示出没发生过的事」同类。截断保头保尾：
 * 开头交代它在做什么，结尾往往才是结果或报错。
 */

import type { TimelineTurn, TimelineItem } from './turnTimeline.ts'

export type TimelineCardKind =
  | 'user'
  | 'assistant'
  | 'summary'
  | 'tool'
  | 'diff'

export type TimelineCardStatus = 'running' | 'ok' | 'error'

export type TimelineCard = {
  /** 稳定且唯一；重渲染靠它对位，否则列表会错行 */
  id: string
  kind: TimelineCardKind
  turnIndex: number
  /** 折叠时显示的一行；**必须自带足够信息**，否则折叠等于隐藏 */
  title: string
  /** 展开时显示；已按预算截断 */
  body?: string
  collapsed: boolean
  /** 截断了就要说 —— 悄悄截会被读成「它就返回了这么多」 */
  truncated: boolean
  status?: TimelineCardStatus
}

export type BuildTimelineCardsOptions = {
  turns: readonly TimelineTurn[]
  /** 单张卡正文的字符预算，默认 4000 */
  maxBodyChars?: number
}

const DEFAULT_MAX_BODY = 4000
const TRUNCATION_NOTE = '\n…[truncated]…\n'

/** 保头保尾地截断：开头交代在做什么，结尾往往才是结果或报错 */
function clampBody(
  text: string,
  max: number,
): { body: string; truncated: boolean } {
  if (text.length <= max) return { body: text, truncated: false }
  const keep = Math.max(1, Math.floor((max - TRUNCATION_NOTE.length) / 2))
  return {
    body: text.slice(0, keep) + TRUNCATION_NOTE + text.slice(-keep),
    truncated: true,
  }
}

/** 工具结果里的错误标记（与 core 的 formatToolUseError 同一字面量） */
function looksLikeToolError(output: string | undefined): boolean {
  return typeof output === 'string' && output.includes('<tool_use_error>')
}

function firstLine(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (!one) return ''
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

function cardFor(
  item: TimelineItem,
  turnIndex: number,
  seq: number,
  maxBody: number,
): TimelineCard {
  const base = { turnIndex, truncated: false as boolean }

  switch (item.kind) {
    case 'user': {
      const { body, truncated } = clampBody(item.text, maxBody)
      return {
        ...base,
        id: `t${turnIndex}-u${seq}`,
        kind: 'user',
        title: firstLine(item.text),
        body,
        truncated,
        // 用户自己写的东西不折叠：那是这一轮的起点
        collapsed: false,
      }
    }
    case 'assistant': {
      const { body, truncated } = clampBody(item.text, maxBody)
      return {
        ...base,
        id: `t${turnIndex}-a${seq}`,
        kind: 'assistant',
        title: firstLine(item.text),
        body,
        truncated,
        collapsed: false,
      }
    }
    case 'summary': {
      const { body, truncated } = clampBody(item.text, maxBody)
      return {
        ...base,
        id: `t${turnIndex}-s${seq}`,
        kind: 'summary',
        // 措辞刻意中性：它不是用户说的话，标题不能写成第二人称
        title: 'Earlier conversation summarized',
        body,
        truncated,
        collapsed: true,
      }
    }
    case 'tool': {
      const isError = looksLikeToolError(item.output)
      const status: TimelineCardStatus = !item.complete
        ? 'running'
        : isError
          ? 'error'
          : 'ok'
      const { body, truncated } = item.output
        ? clampBody(item.output, maxBody)
        : { body: undefined, truncated: false }
      return {
        ...base,
        id: `t${turnIndex}-tool-${item.callId}`,
        kind: 'tool',
        title: item.complete
          ? `${item.name}${isError ? ' — failed' : ''}`
          : `${item.name} — running`,
        ...(body !== undefined ? { body } : {}),
        truncated,
        // 跑着的要看，出错的更要看；只有安然跑完的才折叠
        collapsed: item.complete && !isError,
        status,
      }
    }
    case 'diff': {
      return {
        ...base,
        id: `t${turnIndex}-diff-${seq}-${item.path}`,
        kind: 'diff',
        // 折叠行必须自带规模，否则用户得逐个点开才知道改了多少
        title: `${item.path}  +${item.added}/-${item.removed}  (${item.tool})`,
        truncated: false,
        collapsed: true,
      }
    }
  }
}

export function buildTimelineCards(
  opts: BuildTimelineCardsOptions,
): TimelineCard[] {
  const maxBody = Math.max(64, opts.maxBodyChars ?? DEFAULT_MAX_BODY)
  const out: TimelineCard[] = []
  for (const turn of opts.turns) {
    turn.items.forEach((item, i) => {
      out.push(cardFor(item, turn.index, i, maxBody))
    })
  }
  return out
}
