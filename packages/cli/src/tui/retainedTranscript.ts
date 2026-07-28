import { Box } from '@earendil-works/pi-tui/dist/components/box.js'
import {
  Markdown,
  type MarkdownTheme,
} from '@earendil-works/pi-tui/dist/components/markdown.js'
import { Text } from '@earendil-works/pi-tui/dist/components/text.js'
import {
  Container,
  type Component,
} from '@earendil-works/pi-tui/dist/tui.js'
import type {
  CliTuiBlock,
  CliTuiErrorBlock,
  CliTuiReasoningBlock,
  CliTuiSearchBlock,
  CliTuiToolBlock,
  CliTuiViewState,
  CliTuiWarningBlock,
} from '../../../shared/src/index.ts'
import { resolveTuiContentGutter } from './contentLayout.ts'
import { stripTerminalAnsi } from './terminalText.ts'
import { resolveTuiTheme } from './theme.ts'

const RESET = '\x1b[0m'

type TranscriptStyles = {
  markdown: MarkdownTheme
  assistantLabel: (text: string) => string
  reasoningLabel: (text: string) => string
  reasoningText: (text: string) => string
  summaryLabel: (text: string) => string
  toolTitle: (text: string) => string
  searchText: (text: string) => string
  errorText: (text: string) => string
  warningText: (text: string) => string
  mutedText: (text: string) => string
  userBackground?: (text: string) => string
  ansi: boolean
}

function createAnsiStyle(
  enabled: boolean,
  open: string,
): (text: string) => string {
  if (!enabled) return (text) => text
  return (text) => `${open}${text}${RESET}`
}

function createTranscriptStyles(env: NodeJS.ProcessEnv): TranscriptStyles {
  const ansi = resolveTuiTheme({ env }).ansi
  const accent = createAnsiStyle(ansi, '\x1b[38;5;81m')
  const linkUrl = createAnsiStyle(ansi, '\x1b[38;5;245m')
  const code = createAnsiStyle(ansi, '\x1b[38;5;223m')
  const codeBlock = createAnsiStyle(ansi, '\x1b[38;5;252m')
  const border = createAnsiStyle(ansi, '\x1b[38;5;240m')
  const quote = createAnsiStyle(ansi, '\x1b[38;5;245m')
  const success = createAnsiStyle(ansi, '\x1b[38;5;114m')
  const error = createAnsiStyle(ansi, '\x1b[38;5;203m')
  const warning = createAnsiStyle(ansi, '\x1b[38;5;221m')
  const dim = createAnsiStyle(ansi, '\x1b[2m')
  const italic = createAnsiStyle(ansi, '\x1b[3m')
  const bold = createAnsiStyle(ansi, '\x1b[1m')
  const strikethrough = createAnsiStyle(ansi, '\x1b[9m')
  const underline = createAnsiStyle(ansi, '\x1b[4m')

  return {
    ansi,
    markdown: {
      heading: accent,
      link: accent,
      linkUrl,
      code,
      codeBlock,
      codeBlockBorder: border,
      quote,
      quoteBorder: border,
      hr: border,
      listBullet: accent,
      bold,
      italic,
      strikethrough,
      underline,
    },
    assistantLabel: (text) => accent(bold(text)),
    reasoningLabel: dim,
    reasoningText: (text) => dim(italic(text)),
    summaryLabel: dim,
    toolTitle: success,
    searchText: dim,
    errorText: error,
    warningText: warning,
    mutedText: dim,
    ...(ansi
      ? {
          userBackground: createAnsiStyle(true, '\x1b[48;5;236m'),
        }
      : {}),
  }
}

function formatThoughtDuration(elapsedMs: number): string {
  return elapsedMs < 10_000
    ? `${(Math.max(0, elapsedMs) / 1_000).toFixed(1)}s`
    : `${Math.round(Math.max(0, elapsedMs) / 1_000)}s`
}

function stringifyToolInput(block: CliTuiToolBlock): string {
  if (block.argumentsJson?.trim()) return block.argumentsJson.trim()
  if (block.input === undefined) return ''
  if (typeof block.input === 'string') return block.input.trim()
  try {
    return JSON.stringify(block.input, null, 2)
  } catch {
    return String(block.input)
  }
}

function shouldExpandToolCell(env: NodeJS.ProcessEnv): boolean {
  const value = (env.BOLO_DIFF_CELL ?? '').trim().toLowerCase()
  if (value === '0' || value === 'fold' || value === 'collapsed') return false
  if (
    value === '1' ||
    value === 'full' ||
    value === 'expand' ||
    value === 'expanded'
  ) {
    return true
  }
  const verbose = (env.BOLO_DIFF_VERBOSE ?? '').trim().toLowerCase()
  return verbose === '1' || verbose === 'true' || verbose === 'yes'
}

function preferredToolResult(
  block: CliTuiToolBlock,
  env: NodeJS.ProcessEnv,
): string {
  const expand = shouldExpandToolCell(env)
  if (expand && block.cellExpanded?.trim()) return block.cellExpanded.trim()
  if (!expand && block.cellCollapsed?.trim()) return block.cellCollapsed.trim()
  if (block.summaryLine?.trim()) {
    if (expand && block.ansiUnified?.trim()) {
      return `${block.summaryLine.trim()}\n${block.ansiUnified.trim()}`
    }
    return block.summaryLine.trim()
  }
  if (block.output?.trim()) return block.output.trim()
  return ''
}

function formatToolBlock(
  block: CliTuiToolBlock,
  styles: TranscriptStyles,
  env: NodeJS.ProcessEnv,
): string {
  const running = block.status === 'running'
  const failed = block.status === 'error' || block.ok === false
  const path = block.path?.trim() ? ` · ${block.path.trim()}` : ''
  const counts =
    block.added !== undefined || block.removed !== undefined
      ? ` · +${block.added ?? 0}/-${block.removed ?? 0}`
      : ''
  const title = running
    ? `→ ${block.name}`
    : `${failed ? '✗' : '✓'} ${block.name}${path}${counts}`
  const lines = [
    failed ? styles.errorText(title) : styles.toolTitle(title),
  ]
  const input = stringifyToolInput(block)
  if (input) {
    lines.push(styles.mutedText(`input ${input}`))
  }
  if (running && block.progress?.trim()) {
    lines.push(styles.mutedText(`… ${block.progress.trim()}`))
  }
  if (!running) {
    const result = preferredToolResult(block, env)
    if (result) {
      lines.push(styles.ansi ? result : stripTerminalAnsi(result))
    }
  }
  return lines.join('\n')
}

function formatSearchBlock(
  block: CliTuiSearchBlock,
  styles: TranscriptStyles,
): string {
  const query = block.query?.trim()
    ? ` "${block.query.trim()}"`
    : ''
  const lines = [styles.searchText(`⌕ web search${query}`)]
  if (block.resultCount !== undefined) {
    lines.push(
      styles.searchText(`⌕ ${block.resultCount} result(s)`),
    )
  }
  for (const citation of block.citations) {
    const title = citation.title?.trim()
      ? `${citation.title.trim()} — `
      : ''
    lines.push(
      styles.searchText(`  ↳ ${title}${citation.url}`),
    )
  }
  return lines.join('\n')
}

class RetainedTranscriptBlock implements Component {
  readonly id: string
  private block: CliTuiBlock
  private content!: Component
  private markdown?: Markdown
  private auxiliaryText?: Text

  constructor(
    block: CliTuiBlock,
    private readonly styles: TranscriptStyles,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.id = block.id
    this.block = block
    this.build()
  }

  setBlock(block: CliTuiBlock): void {
    if (block.id !== this.id || block.kind !== this.block.kind) {
      throw new Error(`retained transcript block identity changed: ${this.id}`)
    }
    this.block = block
    switch (block.kind) {
      case 'user':
      case 'assistant':
      case 'summary':
        this.markdown?.setText(block.text)
        break
      case 'reasoning':
        this.markdown?.setText(block.text)
        this.auxiliaryText?.setText(this.reasoningDuration(block))
        break
      case 'tool':
        this.auxiliaryText?.setText(
          formatToolBlock(block, this.styles, this.env),
        )
        break
      case 'search':
        this.auxiliaryText?.setText(formatSearchBlock(block, this.styles))
        break
      case 'error':
        this.auxiliaryText?.setText(this.formatError(block))
        break
      case 'warning':
        this.auxiliaryText?.setText(this.formatWarning(block))
        break
    }
  }

  invalidate(): void {
    this.content.invalidate?.()
  }

  render(width: number): string[] {
    return this.content.render(Math.max(1, Math.floor(width)))
  }

  private build(): void {
    switch (this.block.kind) {
      case 'user': {
        this.markdown = this.createMarkdown(this.block.text)
        const box = new Box(1, 0, this.styles.userBackground)
        box.addChild(this.markdown)
        this.content = box
        return
      }
      case 'assistant': {
        this.markdown = this.createMarkdown(this.block.text)
        const container = new Container()
        container.addChild(
          new Text(this.styles.assistantLabel('● Bolo'), 0, 0),
        )
        container.addChild(this.markdown)
        this.content = container
        return
      }
      case 'reasoning': {
        this.markdown = this.createMarkdown(this.block.text, {
          color: this.styles.reasoningText,
          italic: true,
        })
        this.auxiliaryText = new Text(
          this.reasoningDuration(this.block),
          0,
          0,
        )
        const container = new Container()
        container.addChild(
          new Text(this.styles.reasoningLabel('◇ Thinking'), 0, 0),
        )
        container.addChild(this.markdown)
        container.addChild(this.auxiliaryText)
        this.content = container
        return
      }
      case 'tool':
        this.auxiliaryText = new Text(
          formatToolBlock(this.block, this.styles, this.env),
          0,
          0,
        )
        this.content = this.auxiliaryText
        return
      case 'search':
        this.auxiliaryText = new Text(
          formatSearchBlock(this.block, this.styles),
          0,
          0,
        )
        this.content = this.auxiliaryText
        return
      case 'error':
        this.auxiliaryText = new Text(
          this.formatError(this.block),
          0,
          0,
        )
        this.content = this.auxiliaryText
        return
      case 'warning':
        this.auxiliaryText = new Text(
          this.formatWarning(this.block),
          0,
          0,
        )
        this.content = this.auxiliaryText
        return
      case 'summary': {
        this.markdown = this.createMarkdown(this.block.text)
        const container = new Container()
        container.addChild(
          new Text(this.styles.summaryLabel('◇ Summary'), 0, 0),
        )
        container.addChild(this.markdown)
        this.content = container
      }
    }
  }

  private createMarkdown(
    text: string,
    defaultTextStyle?: {
      color?: (text: string) => string
      italic?: boolean
    },
  ): Markdown {
    return new Markdown(
      text,
      0,
      0,
      this.styles.markdown,
      defaultTextStyle,
      {
        preserveOrderedListMarkers: true,
        preserveBackslashEscapes: true,
      },
    )
  }

  private reasoningDuration(block: CliTuiReasoningBlock): string {
    if (
      block.status === 'streaming' ||
      block.elapsedMs === undefined
    ) {
      return ''
    }
    return this.styles.mutedText(
      `Thought for ${formatThoughtDuration(block.elapsedMs)}`,
    )
  }

  private formatError(block: CliTuiErrorBlock): string {
    return this.styles.errorText(`Error: ${block.message}`)
  }

  private formatWarning(block: CliTuiWarningBlock): string {
    return this.styles.warningText(`Warning: ${block.message}`)
  }
}

export class RetainedTranscript implements Component {
  private readonly styles: TranscriptStyles
  private readonly blockCache = new Map<string, RetainedTranscriptBlock>()
  private orderedBlocks: RetainedTranscriptBlock[] = []

  constructor(
    private readonly options: { env: NodeJS.ProcessEnv },
  ) {
    this.styles = createTranscriptStyles(options.env)
  }

  setState(state: CliTuiViewState): void {
    const nextBlocks: RetainedTranscriptBlock[] = []
    const seen = new Set<string>()
    for (const turn of state.turns) {
      for (const block of turn.blocks) {
        let component = this.blockCache.get(block.id)
        if (!component) {
          component = new RetainedTranscriptBlock(
            block,
            this.styles,
            this.options.env,
          )
          this.blockCache.set(block.id, component)
        } else {
          component.setBlock(block)
        }
        seen.add(block.id)
        nextBlocks.push(component)
      }
    }
    for (const id of this.blockCache.keys()) {
      if (!seen.has(id)) this.blockCache.delete(id)
    }
    this.orderedBlocks = nextBlocks
  }

  getBlockComponent(blockId: string): Component | undefined {
    return this.blockCache.get(blockId)
  }

  invalidate(): void {
    // Child source updates invalidate themselves. Width is always passed into
    // render(), so parent invalidation must not discard every Markdown cache.
  }

  render(width: number): string[] {
    const normalizedWidth = Number.isFinite(width)
      ? Math.max(1, Math.floor(width))
      : 80
    const gutterWidth = resolveTuiContentGutter(normalizedWidth)
    const gutter = ' '.repeat(gutterWidth)
    const contentWidth = Math.max(1, normalizedWidth - gutterWidth)
    const lines: string[] = []

    for (const component of this.orderedBlocks) {
      const blockLines = component.render(contentWidth)
      if (blockLines.length === 0) continue
      if (lines.length > 0) lines.push(gutter)
      for (const line of blockLines) {
        lines.push(`${gutter}${line}`)
      }
    }
    return lines
  }
}
