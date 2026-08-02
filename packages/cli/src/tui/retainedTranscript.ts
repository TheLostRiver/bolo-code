import {
  Box,
  Container,
  Markdown,
  Text,
  type Component,
  type MarkdownTheme,
} from './piCompat.ts'
import type {
  CliTuiBlock,
  CliTuiErrorBlock,
  CliTuiReasoningBlock,
  CliTuiSearchBlock,
  CliTuiToolBlock,
  CliTuiViewState,
  CliTuiWarningBlock,
  ToolResultReference,
} from '../../../shared/src/index.ts'
import {
  createCliToolDisplayState,
  projectCliToolDisplay,
  reduceCliToolDisplayState,
  type CliToolDisplayMode,
  type CliToolDisplayState,
} from '../../../shared/src/index.ts'
import { resolveTuiContentGutter } from './contentLayout.ts'
import { stripTerminalAnsi } from './terminalText.ts'
import { resolveTuiTheme } from './theme.ts'

const RESET = '\x1b[0m'
const TAIL_WINDOW_BLOCK_THRESHOLD = 100
const TAIL_WINDOW_MIN_LINES = 80
const TAIL_WINDOW_VIEWPORT_MULTIPLIER = 3
const TOOL_INPUT_MAX_CHARS = 240
const TOOL_INPUT_MAX_LINES = 3
const TOOL_BLOCK_MAX_VISUAL_LINES = 24
const RUNNING_TOOL_BLOCK_MAX_VISUAL_LINES = 12

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

function boundedToolInput(block: CliTuiToolBlock): string {
  const source = stripTerminalAnsi(stringifyToolInput(block))
    .replace(/\r\n|\r/gu, '\n')
    .trim()
  if (!source) return ''
  const lines = source.split('\n')
  const lineBounded =
    lines.length > TOOL_INPUT_MAX_LINES
      ? [...lines.slice(0, TOOL_INPUT_MAX_LINES - 1), '…'].join('\n')
      : source
  if (lineBounded.length <= TOOL_INPUT_MAX_CHARS) return lineBounded
  return `${lineBounded.slice(0, TOOL_INPUT_MAX_CHARS - 1)}…`
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

function formatToolBlock(
  block: CliTuiToolBlock,
  styles: TranscriptStyles,
  displayState: CliToolDisplayState,
): string {
  const running = block.status === 'running'
  const failed = block.status === 'error' || block.ok === false
  const interrupted = block.status === 'interrupted'
  const path = block.path?.trim() ? ` · ${block.path.trim()}` : ''
  const counts =
    block.added !== undefined || block.removed !== undefined
      ? ` · +${block.added ?? 0}/-${block.removed ?? 0}`
      : ''
  const title = running
    ? `→ ${block.name}`
    : `${failed ? '✗' : interrupted ? '■' : '✓'} ${block.name}${path}${counts}`
  const lines = [
    failed
      ? styles.errorText(title)
      : interrupted
        ? styles.mutedText(title)
        : styles.toolTitle(title),
  ]
  const input = boundedToolInput(block)
  if (input) {
    lines.push(styles.mutedText(`input ${input}`))
  }
  const result = projectCliToolDisplay(block, displayState)
  if (result.content) {
    lines.push(
      running
        ? styles.mutedText(result.content)
        : styles.ansi
          ? result.content
          : stripTerminalAnsi(result.content),
    )
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
    private toolDisplayState?: CliToolDisplayState,
  ) {
    this.id = block.id
    this.block = block
    this.build()
  }

  setBlock(
    block: CliTuiBlock,
    toolDisplayState?: CliToolDisplayState,
  ): void {
    if (block.id !== this.id || block.kind !== this.block.kind) {
      throw new Error(`retained transcript block identity changed: ${this.id}`)
    }
    this.block = block
    this.toolDisplayState = toolDisplayState
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
          formatToolBlock(
            block,
            this.styles,
            toolDisplayState ?? createCliToolDisplayState(block),
          ),
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
    const lines = this.content.render(Math.max(1, Math.floor(width)))
    if (this.block.kind !== 'tool') return lines
    const maxLines =
      this.block.status === 'running'
        ? RUNNING_TOOL_BLOCK_MAX_VISUAL_LINES
        : TOOL_BLOCK_MAX_VISUAL_LINES
    if (lines.length <= maxLines) return lines
    return [
      ...lines.slice(0, maxLines - 1),
      this.styles.mutedText('…'),
    ]
  }

  getBlock(): CliTuiBlock {
    return this.block
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
          formatToolBlock(
            this.block,
            this.styles,
            this.toolDisplayState ??
              createCliToolDisplayState(this.block),
          ),
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

type RetainedToolDisplayEntry = {
  state: CliToolDisplayState
  status: CliTuiToolBlock['status']
  overridden: boolean
}

export type RetainedToolCatalogItem = {
  id: string
  label: string
}

export type RetainedToolPagerContent = {
  key: string
  title: string
  content: string
  callId: string
  fullResult?: ToolResultReference
}

export class RetainedTranscript implements Component {
  private readonly styles: TranscriptStyles
  private readonly blockCache = new Map<string, RetainedTranscriptBlock>()
  private readonly toolDisplayStates =
    new Map<string, RetainedToolDisplayEntry>()
  private orderedBlocks: RetainedTranscriptBlock[] = []
  private globalToolDisplayMode?: CliToolDisplayMode
  // Native scrollback owns the full first render. After a large history has
  // been seeded, xterm reflows it and retained redraws only the live tail.
  private lastRenderedWidth?: number
  private seededFullHistory = false
  private tailWindow = false
  private blockHitLines = new Map<string, { start: number; end: number }>()

  constructor(
    private readonly options: {
      env: NodeJS.ProcessEnv
      getViewportRows?: () => number
    },
  ) {
    this.styles = createTranscriptStyles(options.env)
  }

  setState(state: CliTuiViewState): void {
    const nextBlocks: RetainedTranscriptBlock[] = []
    const seen = new Set<string>()
    for (const turn of state.turns) {
      for (const block of turn.blocks) {
        const toolDisplayState =
          block.kind === 'tool'
            ? this.resolveToolDisplayState(block)
            : undefined
        let component = this.blockCache.get(block.id)
        if (!component) {
          component = new RetainedTranscriptBlock(
            block,
            this.styles,
            toolDisplayState,
          )
          this.blockCache.set(block.id, component)
        } else {
          component.setBlock(block, toolDisplayState)
        }
        seen.add(block.id)
        nextBlocks.push(component)
      }
    }
    for (const id of this.blockCache.keys()) {
      if (!seen.has(id)) {
        this.blockCache.delete(id)
        this.toolDisplayStates.delete(id)
      }
    }
    this.orderedBlocks = nextBlocks
  }

  getBlockComponent(blockId: string): Component | undefined {
    return this.blockCache.get(blockId)
  }

  toggleToolDisplayMode(): CliToolDisplayMode | undefined {
    if (this.toolDisplayStates.size === 0) return undefined
    const mode =
      this.globalToolDisplayMode === 'preview' ? 'summary' : 'preview'
    this.globalToolDisplayMode = mode
    for (const [id, entry] of this.toolDisplayStates) {
      const state = reduceCliToolDisplayState(entry.state, {
        type: 'set_mode',
        mode,
      })
      this.toolDisplayStates.set(id, {
        ...entry,
        state,
        overridden: true,
      })
      const component = this.blockCache.get(id)
      const block = component?.getBlock()
      if (block?.kind === 'tool') component?.setBlock(block, state)
    }
    return mode
  }

  getToolCatalogItems(): RetainedToolCatalogItem[] {
    const items: RetainedToolCatalogItem[] = []
    for (let index = this.orderedBlocks.length - 1; index >= 0; index -= 1) {
      const block = this.orderedBlocks[index]!.getBlock()
      if (block.kind !== 'tool') continue
      const summary = projectCliToolDisplay(block, { mode: 'summary' })
        .content
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 180)
      const status =
        block.status === 'running'
          ? 'running'
          : block.status === 'error' || block.ok === false
            ? 'failed'
            : block.status
      items.push({
        id: block.id,
        label: `${summary || block.name} · ${status}`,
      })
    }
    return items
  }

  getToolPagerContent(
    blockId: string,
  ): RetainedToolPagerContent | undefined {
    const component = this.blockCache.get(blockId)
    const block = component?.getBlock()
    if (block?.kind !== 'tool') return undefined
    const preview = projectCliToolDisplay(block, { mode: 'preview' })
    const content =
      preview.content ||
      projectCliToolDisplay(block, { mode: 'summary' }).content
    if (!content) return undefined
    return {
      key: `tool:${block.id}`,
      title: `${block.name} · ${
        block.status === 'running'
          ? 'running'
          : block.status === 'error' || block.ok === false
            ? 'failed'
            : 'result'
      }`,
      content,
      callId: block.callId,
      ...(block.presentation?.fullResult
        ? {
            fullResult: {
              ...block.presentation.fullResult,
            },
          }
        : {}),
    }
  }

  invalidate(): void {
    // Child source updates invalidate themselves. Width is always passed into
    // render(), so parent invalidation must not discard every Markdown cache.
  }

  /**
   * 最近一次 render 产出的可点击 tool block 行区间（相对本组件布局行，
   * 不含 gutter 分隔行）。只注册 overflow 且可开 pager 的块。
   */
  getBlockHitLines(): ReadonlyMap<string, { start: number; end: number }> {
    return this.blockHitLines
  }

  render(width: number): string[] {
    const normalizedWidth = Number.isFinite(width)
      ? Math.max(1, Math.floor(width))
      : 80
    const widthChanged =
      this.lastRenderedWidth !== undefined &&
      this.lastRenderedWidth !== normalizedWidth
    if (
      widthChanged &&
      this.seededFullHistory &&
      this.orderedBlocks.length > TAIL_WINDOW_BLOCK_THRESHOLD
    ) {
      this.tailWindow = true
    }
    this.lastRenderedWidth = normalizedWidth

    const gutterWidth = resolveTuiContentGutter(normalizedWidth)
    const gutter = ' '.repeat(gutterWidth)
    const contentWidth = Math.max(1, normalizedWidth - gutterWidth)
    const lines = this.tailWindow
      ? this.renderTailWindow(contentWidth, gutter)
      : this.renderAllBlocks(contentWidth, gutter)
    if (
      !this.tailWindow &&
      this.orderedBlocks.length > TAIL_WINDOW_BLOCK_THRESHOLD &&
      lines.length > this.tailWindowLineBudget()
    ) {
      this.seededFullHistory = true
    }
    return lines
  }

  private renderAllBlocks(contentWidth: number, gutter: string): string[] {
    const lines: string[] = []
    this.blockHitLines = new Map()
    let line = 0
    for (const component of this.orderedBlocks) {
      const blockLines = component.render(contentWidth)
      line = this.appendBlock(lines, blockLines, gutter, line)
      this.recordHitLines(component, blockLines, line)
    }
    return lines
  }

  private renderTailWindow(
    contentWidth: number,
    gutter: string,
  ): string[] {
    const budget = this.tailWindowLineBudget()
    const sections: Array<{
      block: RetainedTranscriptBlock
      lines: string[]
    }> = []
    let remaining = budget
    for (
      let index = this.orderedBlocks.length - 1;
      index >= 0 && remaining > 0;
      index -= 1
    ) {
      const component = this.orderedBlocks[index]!
      const blockLines = component.render(contentWidth)
      if (blockLines.length === 0) continue
      const gap = sections.length > 0 ? 1 : 0
      const available = Math.max(0, remaining - gap)
      if (available === 0) break
      if (blockLines.length > available) {
        sections.unshift({
          block: component,
          lines: blockLines.slice(-available),
        })
        remaining = 0
        break
      }
      sections.unshift({ block: component, lines: blockLines })
      remaining -= blockLines.length + gap
    }

    const lines: string[] = []
    this.blockHitLines = new Map()
    let line = 0
    for (const section of sections) {
      line = this.appendBlock(lines, section.lines, gutter, line)
      this.recordHitLines(section.block, section.lines, line)
    }
    return lines
  }

  private appendBlock(
    lines: string[],
    blockLines: readonly string[],
    gutter: string,
    startLine: number,
  ): number {
    if (blockLines.length === 0) return startLine
    let line = startLine
    if (line > 0) {
      lines.push(gutter)
      line += 1
    }
    for (const blockLine of blockLines) {
      lines.push(`${gutter}${blockLine}`)
      line += 1
    }
    return line
  }

  private recordHitLines(
    component: RetainedTranscriptBlock,
    blockLines: readonly string[],
    endLine: number,
  ): void {
    if (blockLines.length === 0) return
    const block = component.getBlock()
    if (block.kind !== 'tool') return
    const projection = projectCliToolDisplay(
      block,
      this.resolveToolDisplayState(block),
    )
    if (!projection.canOpenPager || !projection.overflow) return
    this.blockHitLines.set(block.id, {
      start: endLine - blockLines.length,
      end: endLine,
    })
  }

  private tailWindowLineBudget(): number {
    const rows = this.options.getViewportRows?.() ?? 24
    return Math.max(
      TAIL_WINDOW_MIN_LINES,
      Math.floor(rows) * TAIL_WINDOW_VIEWPORT_MULTIPLIER,
    )
  }

  private resolveToolDisplayState(
    block: CliTuiToolBlock,
  ): CliToolDisplayState {
    const existing = this.toolDisplayStates.get(block.id)
    if (existing) {
      if (!existing.overridden && existing.status !== block.status) {
        const state = createCliToolDisplayState(block)
        this.toolDisplayStates.set(block.id, {
          state,
          status: block.status,
          overridden: false,
        })
        return state
      }
      existing.status = block.status
      return existing.state
    }

    const envOverride =
      block.cellExpanded?.trim() &&
      shouldExpandToolCell(this.options.env)
        ? 'preview'
        : undefined
    const override = this.globalToolDisplayMode ?? envOverride
    const state = createCliToolDisplayState(block, override)
    this.toolDisplayStates.set(block.id, {
      state,
      status: block.status,
      overridden: override !== undefined,
    })
    return state
  }
}
