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
import {
  resolveTuiTheme,
  type TuiAnsiPalette,
} from './theme.ts'
import {
  groupAdjacentReadTools,
  checkMarkdownFidelity,
  type MarkdownFidelityIssue,
} from '../../../shared/src/index.ts'

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

function createTranscriptStyles(
  env: NodeJS.ProcessEnv,
  palette?: TuiAnsiPalette,
): TranscriptStyles {
  const ansi = palette
    ? palette.accent !== ''
    : resolveTuiTheme({ env }).ansi
  const accent = createAnsiStyle(
    ansi,
    palette?.accent ?? '\x1b[38;5;81m',
  )
  const link = createAnsiStyle(
    ansi,
    palette?.link ?? '\x1b[38;5;81m',
  )
  const linkUrl = createAnsiStyle(
    ansi,
    palette?.muted ?? '\x1b[38;5;245m',
  )
  const code = createAnsiStyle(
    ansi,
    palette?.code ?? '\x1b[38;5;223m',
  )
  const codeBlock = createAnsiStyle(
    ansi,
    palette?.text ?? '\x1b[38;5;252m',
  )
  const border = createAnsiStyle(
    ansi,
    palette?.borderDim ?? '\x1b[38;5;240m',
  )
  const quote = createAnsiStyle(
    ansi,
    palette?.muted ?? '\x1b[38;5;245m',
  )
  const success = createAnsiStyle(
    ansi,
    palette?.success ?? '\x1b[38;5;114m',
  )
  const error = createAnsiStyle(
    ansi,
    palette?.error ?? '\x1b[38;5;203m',
  )
  const warning = createAnsiStyle(
    ansi,
    palette?.warning ?? '\x1b[38;5;221m',
  )
  const dim = createAnsiStyle(
    ansi,
    palette?.muted ?? '\x1b[2m',
  )
  const italic = createAnsiStyle(ansi, '\x1b[3m')
  const bold = createAnsiStyle(ansi, '\x1b[1m')
  const strikethrough = createAnsiStyle(ansi, '\x1b[9m')
  const underline = createAnsiStyle(ansi, '\x1b[4m')

  return {
    ansi,
    markdown: {
      heading: accent,
      link,
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
          userBackground: createAnsiStyle(
            true,
            palette
              ? `${palette.surface}${palette.text}`
              : '\x1b[48;5;236m',
          ),
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
  private readonly markdownKinds = new Set(['user', 'assistant', 'reasoning'])
  private fidelityIssues: MarkdownFidelityIssue[] = []
  private fidelitySource = ''
  private lastRenderedWidth?: number
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
    const safeWidth = Math.max(1, Math.floor(width))
    this.lastRenderedWidth = safeWidth
    const lines = this.content.render(safeWidth)
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

  /** REN-1：本块 markdown 源的稳定指纹（去重 key 用） */
  getSourceFingerprint(): string {
    const text = (this.block as { text?: string }).text ?? ''
    let hash = 5381
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
    }
    return (hash >>> 0).toString(36)
  }

  /** REN-1：本块最近一次渲染的 markdown fidelity 问题（源变化时重检） */
  getFidelityIssues(): MarkdownFidelityIssue[] {
    return this.fidelityIssues
  }

  /**
   * REN-1：渲染后按需检查 markdown fidelity（flush 时调用，不在流式渲染
   * 路径上；按 source 缓存，同一源只检一次；width 变化不重检——表格窄
   * 宽度回退仍保留原始语法，判定与 width 无关）。
   */
  checkFidelity(): void {
    const markdownText = (this.block as { text?: string }).text ?? ''
    if (this.markdown && markdownText && this.markdownKinds.has(this.block.kind)) {
      if (this.fidelitySource !== markdownText) {
        const width = this.lastRenderedWidth ?? 80
        // ANSI 会破坏行首锚定检测（列表符号/代码围栏带颜色前缀）——先剥离
        const rendered = this.markdown
          .render(Math.max(1, Math.floor(width)))
          .map((line) => stripTerminalAnsi(line))
        this.fidelityIssues = checkMarkdownFidelity(markdownText, rendered)
        this.fidelitySource = markdownText
      }
      return
    }
    if (this.fidelitySource !== '') {
      this.fidelityIssues = []
      this.fidelitySource = ''
    }
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

class RetainedReadGroup implements Component {
  private readonly header: Text
  private readonly memberTexts: Array<{
    blockId: string
    text: Text
  }> = []
  private readonly memberHits: Array<{
    blockId: string
    start: number
    end: number
  }> = []

  constructor(
    members: readonly RetainedTranscriptBlock[],
    styles: TranscriptStyles,
  ) {
    this.header = new Text(
      styles.mutedText(`⇅ ${members.length} read-only calls`),
      0,
      0,
    )
    for (const member of members) {
      const block = member.getBlock()
      if (block.kind !== 'tool') continue
      const summary =
        projectCliToolDisplay(block, { mode: 'summary' }).content ||
        block.name
      this.memberTexts.push({
        blockId: block.id,
        text: new Text(`  ${summary}`, 0, 0),
      })
    }
  }

  invalidate(): void {
    this.header.invalidate?.()
    for (const member of this.memberTexts) member.text.invalidate?.()
  }

  getMemberHits(): ReadonlyArray<{
    blockId: string
    start: number
    end: number
  }> {
    return this.memberHits
  }

  getMemberBlockIds(): readonly string[] {
    return this.memberTexts.map((member) => member.blockId)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const lines = [...this.header.render(safeWidth)]
    this.memberHits.length = 0
    let line = lines.length
    for (const member of this.memberTexts) {
      const memberLines = member.text.render(safeWidth)
      this.memberHits.push({
        blockId: member.blockId,
        start: line,
        end: line + memberLines.length,
      })
      lines.push(...memberLines)
      line += memberLines.length
    }
    return lines
  }
}

type RenderUnit =
  | { kind: 'block'; component: RetainedTranscriptBlock }
  | { kind: 'group'; group: RetainedReadGroup }

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
  private styles: TranscriptStyles
  private readonly blockCache = new Map<string, RetainedTranscriptBlock>()
  /**
   * Rendered unit lines are retained after a slice completes so unrelated
   * root renders cannot restart the transcript from its first slice.
   */
  private unitCache = new Map<RenderUnit, string[]>()
  /** REN-2：渲染进度（已渲染 unit 数）；分片续帧起点 */
  private renderProgress = 0
  /** REN-2：本帧渲染未完成（超出块预算）——controller 应安排下帧续渲 */
  private renderIncomplete = false
  /** REN-2：每帧渲染单元预算（默认 16；undefined = 不分片） */
  private renderBlockBudget: number | undefined = 16
  private readonly toolDisplayStates =
    new Map<string, RetainedToolDisplayEntry>()
  private renderUnits: RenderUnit[] = []
  private groupedBlockIds = new Set<string>()
  private globalToolDisplayMode?: CliToolDisplayMode
  // Native scrollback owns the full first render. After a large history has
  // been seeded, xterm reflows it and retained redraws only the live tail.
  private lastRenderedWidth?: number
  private seededFullHistory = false
  private tailWindow = false
  private blockHitLines = new Map<string, { start: number; end: number }>()
  private latestState?: CliTuiViewState
  private latestTurns?: CliTuiViewState['turns']

  constructor(
    private readonly options: {
      env: NodeJS.ProcessEnv
      getViewportRows?: () => number
      palette?: TuiAnsiPalette
    },
  ) {
    this.styles = createTranscriptStyles(options.env, options.palette)
  }

  setState(state: CliTuiViewState): void {
    this.latestState = state
    if (this.latestTurns === state.turns) return
    this.resetUnitRenderCache()
    const renderUnits: RenderUnit[] = []
    const groupedBlockIds = new Set<string>()
    const seen = new Set<string>()
    const ensureBlock = (
      block: CliTuiBlock,
      toolDisplayState?: CliToolDisplayState,
    ): RetainedTranscriptBlock => {
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
      return component
    }
    for (const turn of state.turns) {
      const projection = groupAdjacentReadTools(turn.blocks)
      for (const entry of projection) {
        if (entry.kind === 'read-group') {
          const members: RetainedTranscriptBlock[] = []
          for (const member of entry.members) {
            this.toolDisplayStates.delete(member.id)
            groupedBlockIds.add(member.id)
            members.push(
              ensureBlock(member, { mode: 'summary' }),
            )
          }
          renderUnits.push({
            kind: 'group',
            group: new RetainedReadGroup(members, this.styles),
          })
          continue
        }
        const block = entry
        const toolDisplayState =
          block.kind === 'tool'
            ? this.resolveToolDisplayState(block)
            : undefined
        renderUnits.push({
          kind: 'block',
          component: ensureBlock(block, toolDisplayState),
        })
      }
    }
    for (const id of this.blockCache.keys()) {
      if (!seen.has(id)) {
        this.blockCache.delete(id)
        this.toolDisplayStates.delete(id)
      }
    }
    this.renderUnits = renderUnits
    this.groupedBlockIds = groupedBlockIds
    this.latestTurns = state.turns
  }

  setPalette(palette: TuiAnsiPalette | undefined): void {
    this.styles = createTranscriptStyles(this.options.env, palette)
    this.blockCache.clear()
    this.renderUnits = []
    this.groupedBlockIds = new Set()
    this.latestTurns = undefined
    this.resetUnitRenderCache()
    this.blockHitLines = new Map()
    if (this.latestState) this.setState(this.latestState)
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
      if (this.groupedBlockIds.has(id)) continue
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
    this.resetUnitRenderCache()
    return mode
  }

  getToolCatalogItems(): RetainedToolCatalogItem[] {
    const items: RetainedToolCatalogItem[] = []
    const appendBlock = (block: CliTuiBlock): void => {
      if (block.kind !== 'tool') return
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
    for (let index = this.renderUnits.length - 1; index >= 0; index -= 1) {
      const unit = this.renderUnits[index]!
      if (unit.kind === 'block') {
        appendBlock(unit.component.getBlock())
        continue
      }
      const members = unit.group.getMemberBlockIds()
      for (let memberIndex = members.length - 1; memberIndex >= 0; memberIndex -= 1) {
        const component = this.blockCache.get(members[memberIndex]!)
        if (component) appendBlock(component.getBlock())
      }
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
   * 坐标含块间的 gutter 分隔行）。只注册 overflow 且可开 pager 的块。
   */
  getBlockHitLines(): ReadonlyMap<string, { start: number; end: number }> {
    return this.blockHitLines
  }

  /** REN-1：块 markdown 源指纹（warning 去重 key） */
  getBlockSourceFingerprint(blockId: string): string {
    return this.blockCache.get(blockId)?.getSourceFingerprint() ?? ''
  }

  /** REN-1：全部块的 markdown fidelity 问题汇总（flush 时先按需检查） */
  getFidelityIssues(): ReadonlyMap<string, readonly MarkdownFidelityIssue[]> {
    const result = new Map<string, readonly MarkdownFidelityIssue[]>()
    for (const [id, component] of this.blockCache) {
      component.checkFidelity()
      const issues = component.getFidelityIssues()
      if (issues.length > 0) result.set(id, issues)
    }
    return result
  }

  /**
   * REN-2：本帧渲染是否未完成（超块预算截断）——controller 据此安排
   * 下帧续渲。尾窗口模式恒 false（其自身有行预算）。
   */
  isRenderIncomplete(): boolean {
    return this.renderIncomplete
  }

  render(width: number): string[] {
    const normalizedWidth = Number.isFinite(width)
      ? Math.max(1, Math.floor(width))
      : 80
    const widthChanged =
      this.lastRenderedWidth !== undefined &&
      this.lastRenderedWidth !== normalizedWidth
    if (widthChanged) {
      // REN-2：宽度变化 → 行缓存失效 + 分片进度重置（全量重渲）
      this.resetUnitRenderCache()
    }
    if (
      widthChanged &&
      this.seededFullHistory &&
      this.blockCache.size > TAIL_WINDOW_BLOCK_THRESHOLD
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
      this.blockCache.size > TAIL_WINDOW_BLOCK_THRESHOLD &&
      lines.length > this.tailWindowLineBudget()
    ) {
      this.seededFullHistory = true
    }
    return lines
  }

  private renderAllBlocks(
    contentWidth: number,
    gutter: string,
  ): string[] {
    const lines: string[] = []
    this.blockHitLines = new Map()
    let line = 0
    let renderedUnits = 0
    this.renderIncomplete = false
    const budget = this.renderBlockBudget ?? Infinity
    for (const unit of this.renderUnits) {
      // 进度内（已渲染）的 unit：复用缓存行；缓存失效（内容变化/宽变化）
      // → 重置进度从头渲染
      if (renderedUnits < this.renderProgress) {
        const cached = this.unitCache.get(unit)
        if (cached === undefined) {
          this.renderProgress = 0
          this.unitCache.clear()
        } else {
          // REN-2 should-fix：缓存复用分支也记录 hit lines——完成帧的
          // blockHitLines 必须覆盖全部块（否则 overflow 块的 pager 点击丢失）
          line = this.appendBlock(lines, cached, gutter, line)
          if (unit.kind === 'block') {
            this.recordHitLines(unit.component, cached, line)
          } else {
            const groupStart = line - cached.length
            for (const hit of unit.group.getMemberHits()) {
              this.blockHitLines.set(hit.blockId, {
                start: groupStart + hit.start,
                end: groupStart + hit.end,
              })
            }
          }
          renderedUnits += 1
          continue
        }
      }
      // 新 unit：帧预算检查——超出 → 截断 + 尾注，下帧续渲
      if (renderedUnits - this.renderProgress >= budget) {
        this.renderIncomplete = true
        lines.push(gutter, `${gutter}… rendering…`)
        break
      }
      let unitLines: string[]
      if (unit.kind === 'block') {
        unitLines = unit.component.render(contentWidth)
        line = this.appendBlock(lines, unitLines, gutter, line)
        this.recordHitLines(unit.component, unitLines, line)
      } else {
        unitLines = unit.group.render(contentWidth)
        line = this.appendBlock(lines, unitLines, gutter, line)
        const groupStart = line - unitLines.length
        for (const hit of unit.group.getMemberHits()) {
          this.blockHitLines.set(hit.blockId, {
            start: groupStart + hit.start,
            end: groupStart + hit.end,
          })
        }
      }
      this.unitCache.set(unit, unitLines)
      renderedUnits += 1
    }
    if (this.renderIncomplete) {
      this.renderProgress = renderedUnits
    } else {
      // Keep the complete cache until transcript content or width changes.
      this.renderProgress = renderedUnits
    }
    return lines
  }

  private renderTailWindow(
    contentWidth: number,
    gutter: string,
  ): string[] {
    // REN-2 blocking：尾窗口模式自身有行预算（有界）——分片标记必须重置，
    // 否则分片中 resize 切到尾窗口后 renderIncomplete 残留 true →
    // flush 续帧循环永不退出（死循环）
    this.renderIncomplete = false
    this.unitCache.clear()
    this.renderProgress = 0
    const budget = this.tailWindowLineBudget()
    const sections: Array<{
      unit: RenderUnit
      lines: string[]
      truncated: boolean
    }> = []
    let remaining = budget
    for (
      let index = this.renderUnits.length - 1;
      index >= 0 && remaining > 0;
      index -= 1
    ) {
      const unit = this.renderUnits[index]!
      const unitLines =
        unit.kind === 'block'
          ? unit.component.render(contentWidth)
          : unit.group.render(contentWidth)
      if (unitLines.length === 0) continue
      const gap = sections.length > 0 ? 1 : 0
      const available = Math.max(0, remaining - gap)
      if (available === 0) break
      if (unitLines.length > available) {
        sections.unshift({
          unit,
          lines: unitLines.slice(-available),
          truncated: true,
        })
        remaining = 0
        break
      }
      sections.unshift({ unit, lines: unitLines, truncated: false })
      remaining -= unitLines.length + gap
    }

    const lines: string[] = []
    this.blockHitLines = new Map()
    let line = 0
    for (const section of sections) {
      line = this.appendBlock(lines, section.lines, gutter, line)
      if (section.truncated) continue
      const sectionStart = line - section.lines.length
      if (section.unit.kind === 'block') {
        this.recordHitLines(section.unit.component, section.lines, line)
        continue
      }
      for (const hit of section.unit.group.getMemberHits()) {
        this.blockHitLines.set(hit.blockId, {
          start: sectionStart + hit.start,
          end: sectionStart + hit.end,
        })
      }
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

  private resetUnitRenderCache(): void {
    this.unitCache.clear()
    this.renderProgress = 0
    this.renderIncomplete = false
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
