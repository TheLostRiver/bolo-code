/**
 * F-T8-INK：Ink 等价布局骨架（无 ink 依赖，纯文本框 + 区域）。
 * plain 回退仍走 banner/status 旧路径。
 */

import {
  getTerminalColumns,
  isNarrowTerminal,
  renderWelcomeBanner,
  type BannerOptions,
} from './banner.ts'
import {
  formatSessionStatusLine,
  type StatusLineSession,
} from './statusLine.ts'
import {
  resolveTuiTheme,
  type TuiThemeId,
  type ResolveTuiThemeOptions,
} from './theme.ts'

export type InkLayoutOptions = BannerOptions &
  ResolveTuiThemeOptions & {
    session?: StatusLineSession
    /** 强制 plain 单列 */
    plain?: boolean
    /** 最近消息预览行（可选） */
    messagePreview?: string[]
    hint?: string
  }

function hline(width: number, ch = '─'): string {
  return ch.repeat(Math.max(8, width))
}

function row(content: string, width: number): string {
  const inner = width - 2
  const plain = content.replace(/\x1b\[[0-9;]*m/g, '')
  let body = content
  if (plain.length > inner) {
    body = plain.slice(0, Math.max(0, inner - 1)) + '…'
  } else {
    body = content + ' '.repeat(Math.max(0, inner - plain.length))
  }
  return `│${body}│`
}

/**
 * 渲染「欢迎区 / 状态 / 消息预览 / 输入提示」四段框。
 * 窄终端或 plain → 退回 renderWelcomeBanner + status 行。
 */
export function renderInkLayout(opts: InkLayoutOptions = {}): string {
  const theme = resolveTuiTheme(opts)
  const plain =
    opts.plain === true ||
    isNarrowTerminal({ columns: opts.columns, env: opts.env }) ||
    theme.id === 'plain'

  if (plain) {
    const ban = renderWelcomeBanner({
      ...opts,
      plain: true,
    })
    const lines = [ban]
    if (opts.session) {
      lines.push(
        formatSessionStatusLine(opts.session, {
          columns: opts.columns,
          env: opts.env,
        }),
      )
    }
    if (opts.hint) lines.push(opts.hint)
    return lines.join('\n')
  }

  const cols = Math.min(100, Math.max(40, getTerminalColumns(opts)))
  const w = cols
  const top = `┌${hline(w - 2)}┐`
  const mid = `├${hline(w - 2)}┤`
  const bot = `└${hline(w - 2)}┘`

  const ban = renderWelcomeBanner({
    ...opts,
    plain: false,
    columns: 120, // 框内再裁
  })
  const banLines = ban.split(/\r?\n/)
  const out: string[] = [top]
  out.push(row(' BOLO · session layout (ink-equiv)', w))
  out.push(mid)
  for (const line of banLines) {
    out.push(row(' ' + line, w))
  }
  if (opts.session) {
    out.push(mid)
    out.push(
      row(
        ' ' +
          formatSessionStatusLine(opts.session, {
            columns: 120,
            env: opts.env,
          }),
        w,
      ),
    )
  }
  const preview = opts.messagePreview?.filter(Boolean).slice(-5) ?? []
  if (preview.length) {
    out.push(mid)
    out.push(row(' messages', w))
    for (const p of preview) {
      out.push(row('  ' + p.replace(/\s+/g, ' ').slice(0, w - 6), w))
    }
  }
  out.push(mid)
  out.push(row(' ' + (opts.hint ?? 'bolo> (type /help)'), w))
  out.push(bot)
  if (theme.ansi) {
    // 轻量：整块 dim 边框观感由调用方可选；此处不强制染色以免测不稳定
  }
  return out.join('\n')
}

export type { TuiThemeId }