/**
 * REN-1: markdown render-fidelity 自检纯契约。
 *
 * 目标：检测「源文本意图做了结构（表格/列表/代码块）但渲染产物里结构线索
 * 完全缺失」的 fidelity 失败，作为 warning 信号（不静默吞掉），供 CLI 展示
 * 或后续模型反馈。
 *
 * 判定原则（保守，正常渲染零误报）：
 * - intent：从源文本严格识别结构意图——表格要求表头行 + `|---` 分隔行；
 *   列表要求行首 `- ` / `* ` / `+ ` / `\d+. `；代码块要求成对围栏（```/~~~）。
 * - rendered：从渲染产物行识别结构线索——表格边框（│/─）或回退语法（|）；
 *   列表符号（•/-/数字.）；代码块围栏（```/~~~）。
 * - 仅当 intent > 0 且 rendered === 0 时报 issue（完全丢失）；部分保留不报
 *   （保守，避免误报）。回退渲染（原始 markdown 文本）视为已渲染。
 */
export type MarkdownStructureKind = 'table' | 'list' | 'code-block'

export type MarkdownStructureCounts = Record<MarkdownStructureKind, number>

export type MarkdownFidelityIssue = {
  kind: MarkdownStructureKind
  /** 源文本中意图的结构数 */
  intent: number
  /** 渲染产物中检测到的结构线索数（0 = 完全丢失） */
  rendered: number
}

const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]+\|?\s*$/u
const TABLE_HEADER_RE = /^\s*\|.*\|\s*$/u
const UNORDERED_LIST_RE = /^\s*[-*+]\s+\S/u
const ORDERED_LIST_RE = /^\s*\d+\.\s+\S/u
const FENCE_RE = /^\s*(`{3,}|~{3,})/u

function countTableIntents(source: string): number {
  const lines = source.split('\n')
  let tables = 0
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const header = lines[index]!
    const separator = lines[index + 1]!
    if (
      TABLE_HEADER_RE.test(header) &&
      TABLE_SEPARATOR_RE.test(separator) &&
      separator.includes('-')
    ) {
      tables += 1
      index += 1
    }
  }
  return tables
}

function countListIntents(source: string): number {
  let lists = 0
  for (const line of source.split('\n')) {
    if (UNORDERED_LIST_RE.test(line) || ORDERED_LIST_RE.test(line)) {
      lists += 1
    }
  }
  return lists
}

function countCodeBlockIntents(source: string): number {
  let fences = 0
  for (const line of source.split('\n')) {
    if (FENCE_RE.test(line)) fences += 1
  }
  // 成对围栏才算一个代码块；奇数围栏按不完整处理（不算意图）
  return Math.floor(fences / 2)
}

/** 源文本结构意图计数（表格=表头+分隔行；列表=行首符号；代码块=成对围栏） */
export function detectMarkdownIntent(source: string): MarkdownStructureCounts {
  return {
    table: countTableIntents(source),
    list: countListIntents(source),
    'code-block': countCodeBlockIntents(source),
  }
}

function countTableRendered(lines: readonly string[]): number {
  // 表格线索：≥2 个垂直框线（│/|）或角/交叉框线（┌┐└┘├┤）。
  // 收紧匹配避免 box 边框、blockquote 前缀（单 │）与 HR（─）误当表格。
  const boxCorner = /[┌┐└┘├┤]/u
  let regions = 0
  let inTable = false
  for (const line of lines) {
    const pipes = (line.match(/[│|]/gu) ?? []).length
    if (pipes >= 2 || boxCorner.test(line)) {
      if (!inTable) {
        regions += 1
        inTable = true
      }
    } else if (inTable && line.trim() !== '') {
      inTable = false
    }
  }
  return regions
}

function countListRendered(lines: readonly string[]): number {
  let lists = 0
  for (const line of lines) {
    if (/^\s*[•\-*]\s+\S/u.test(line) || /^\s*\d+\.\s+\S/u.test(line)) {
      lists += 1
    }
  }
  return lists
}

function countCodeBlockRendered(lines: readonly string[]): number {
  let regions = 0
  let inCode = false
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      regions += 1
      inCode = !inCode
    } else if (inCode && line.trim() === '') {
      // 代码块内空行不断开（围栏闭合判定）
    }
  }
  return Math.floor(regions / 2)
}

/** 渲染产物结构线索计数（表格边框/回退语法、列表符号、代码块围栏） */
export function detectMarkdownRenderedStructures(
  lines: readonly string[],
): MarkdownStructureCounts {
  return {
    table: countTableRendered(lines),
    list: countListRendered(lines),
    'code-block': countCodeBlockRendered(lines),
  }
}

/** 意图 vs 产物对比：仅当意图 > 0 且产物完全缺失时产出 issue。 */
export function checkMarkdownFidelity(
  source: string,
  renderedLines: readonly string[],
): MarkdownFidelityIssue[] {
  const intent = detectMarkdownIntent(source)
  const rendered = detectMarkdownRenderedStructures(renderedLines)
  const issues: MarkdownFidelityIssue[] = []
  for (const kind of ['table', 'list', 'code-block'] as const) {
    if (intent[kind] > 0 && rendered[kind] === 0) {
      issues.push({ kind, intent: intent[kind], rendered: rendered[kind] })
    }
  }
  return issues
}
