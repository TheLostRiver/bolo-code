/**
 * U4：diff 渲染加深 — 对照 Codex diff_render 行号/gutter，HC StructuredDiff 语义
 * 无 tree-sitter / 无 ink；轻量主题 + 可选词法高亮（关键字级）。
 */

import type { DiffHunk } from './textDiff.ts'

export type DiffRenderThemeId = 'default' | 'dim' | 'plain'

export type DiffRenderTheme = {
  id: DiffRenderThemeId
  reset: string
  dim: string
  bold: string
  add: string
  del: string
  meta: string
  gutter: string
  /** 语法：关键字 */
  kw: string
  /** 语法：字符串 */
  str: string
  /** 语法：注释 */
  cmt: string
  /** 语法：数字 */
  num: string
}

const PLAIN: DiffRenderTheme = {
  id: 'plain',
  reset: '',
  dim: '',
  bold: '',
  add: '',
  del: '',
  meta: '',
  gutter: '',
  kw: '',
  str: '',
  cmt: '',
  num: '',
}

const DEFAULT: DiffRenderTheme = {
  id: 'default',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  add: '\x1b[32m',
  del: '\x1b[31m',
  meta: '\x1b[36m',
  gutter: '\x1b[90m',
  kw: '\x1b[35m',
  str: '\x1b[33m',
  cmt: '\x1b[2m\x1b[37m',
  num: '\x1b[36m',
}

const DIM: DiffRenderTheme = {
  id: 'dim',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  add: '\x1b[2m\x1b[32m',
  del: '\x1b[2m\x1b[31m',
  meta: '\x1b[2m\x1b[36m',
  gutter: '\x1b[2m\x1b[90m',
  kw: '\x1b[2m\x1b[35m',
  str: '\x1b[2m\x1b[33m',
  cmt: '\x1b[2m',
  num: '\x1b[2m\x1b[36m',
}

export function resolveDiffRenderTheme(
  opts?: { theme?: string; env?: NodeJS.ProcessEnv; color?: boolean },
): DiffRenderTheme {
  const env = opts?.env ?? process.env
  if (opts?.color === false) return PLAIN
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return PLAIN
  if (env.BOLO_PLAIN === '1' || env.BOLO_PLAIN === 'true') return PLAIN
  const raw = (opts?.theme ?? env.BOLO_THEME ?? env.BOLO_DIFF_THEME ?? 'default')
    .toString()
    .trim()
    .toLowerCase()
  if (raw === 'plain' || raw === 'simple') return PLAIN
  if (raw === 'dim' || raw === 'minimal') return DIM
  return DEFAULT
}

/** BOLO_DIFF_SYNTAX=0 关；默认开（非 plain 主题） */
export function shouldSyntaxHighlight(
  opts?: { env?: NodeJS.ProcessEnv; theme?: DiffRenderTheme },
): boolean {
  const env = opts?.env ?? process.env
  const v = env.BOLO_DIFF_SYNTAX?.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true
  const th = opts?.theme ?? resolveDiffRenderTheme({ env })
  return th.id !== 'plain'
}

/** BOLO_DIFF_GUTTER=0 关行号；默认开 */
export function shouldShowLineGutter(opts?: {
  env?: NodeJS.ProcessEnv
}): boolean {
  const env = opts?.env ?? process.env
  const v = env.BOLO_DIFF_GUTTER?.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  return true
}

export function lineNumberWidth(maxLine: number): number {
  return Math.max(1, String(Math.max(0, maxLine)).length)
}

export type DiffBodyLineKind = 'add' | 'del' | 'ctx' | 'meta' | 'header'

export type DiffBodyLine = {
  kind: DiffBodyLineKind
  /** 去前缀后的代码（header/meta 为整行） */
  text: string
  oldNo?: number
  newNo?: number
}

/**
 * 将 hunks 展成带行号元数据的 body 行（对照 Codex 按 @@ 推进 old/new）。
 */
export function expandHunksToBodyLines(
  filePath: string,
  hunks: readonly DiffHunk[],
): DiffBodyLine[] {
  if (!hunks.length) {
    return [
      {
        kind: 'meta',
        text: `(no structuredPatch retained for ${filePath})`,
      },
    ]
  }
  const out: DiffBodyLine[] = [
    { kind: 'header', text: `--- a/${filePath}` },
    { kind: 'header', text: `+++ b/${filePath}` },
  ]
  for (const h of hunks) {
    out.push({
      kind: 'meta',
      text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    })
    let oldNo = h.oldStart
    let newNo = h.newStart
    // oldStart 0 表示空文件新增
    if (h.oldStart === 0) oldNo = 0
    if (h.newStart === 0) newNo = 0
    for (const raw of h.lines) {
      if (raw.startsWith('+') && !raw.startsWith('+++')) {
        out.push({
          kind: 'add',
          text: raw.slice(1),
          newNo: newNo > 0 ? newNo : undefined,
        })
        if (newNo > 0) newNo++
      } else if (raw.startsWith('-') && !raw.startsWith('---')) {
        out.push({
          kind: 'del',
          text: raw.slice(1),
          oldNo: oldNo > 0 ? oldNo : undefined,
        })
        if (oldNo > 0) oldNo++
      } else if (raw.startsWith(' ') || raw === '' || raw.startsWith('\\')) {
        const body = raw.startsWith(' ') ? raw.slice(1) : raw
        out.push({
          kind: 'ctx',
          text: body,
          oldNo: oldNo > 0 ? oldNo : undefined,
          newNo: newNo > 0 ? newNo : undefined,
        })
        if (oldNo > 0) oldNo++
        if (newNo > 0) newNo++
      } else {
        // 兜底：整行当 meta
        out.push({ kind: 'meta', text: raw })
      }
    }
  }
  return out
}

function langFromPath(filePath?: string): string {
  if (!filePath) return ''
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

const KW: Record<string, Set<string>> = {
  ts: new Set(
    'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public return set static super switch this throw true try type typeof undefined var void while with yield'.split(
      ' ',
    ),
  ),
  js: new Set(
    'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield'.split(
      ' ',
    ),
  ),
  py: new Set(
    'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(
      ' ',
    ),
  ),
  rs: new Set(
    'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(
      ' ',
    ),
  ),
  go: new Set(
    'break break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'.split(
      ' ',
    ),
  ),
}

function keywordsForExt(ext: string): Set<string> | null {
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts')
    return KW.ts!
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs')
    return KW.js!
  if (ext === 'py') return KW.py!
  if (ext === 'rs') return KW.rs!
  if (ext === 'go') return KW.go!
  return null
}

/**
 * 轻量行内高亮：字符串 / 注释 / 数字 / 关键字（可选）。
 * 不做完整词法；失败则原样返回。
 */
export function highlightCodeLine(
  text: string,
  filePath: string | undefined,
  theme: DiffRenderTheme,
): string {
  if (!theme.reset || !text) return text
  const ext = langFromPath(filePath)
  const kws = keywordsForExt(ext)

  // 整行注释
  const t = text.trimStart()
  if (
    t.startsWith('//') ||
    t.startsWith('#') ||
    t.startsWith('/*') ||
    t.startsWith('*')
  ) {
    return `${theme.cmt}${text}${theme.reset}`
  }

  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    // string
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === q) {
          j++
          break
        }
        j++
      }
      out += `${theme.str}${text.slice(i, j)}${theme.reset}`
      i = j
      continue
    }
    // line comment mid
    if (c === '/' && text[i + 1] === '/') {
      out += `${theme.cmt}${text.slice(i)}${theme.reset}`
      break
    }
    if (c === '#' && ext === 'py') {
      out += `${theme.cmt}${text.slice(i)}${theme.reset}`
      break
    }
    // number
    if (/\d/.test(c) && (i === 0 || !/[A-Za-z_$]/.test(text[i - 1] ?? ''))) {
      let j = i
      while (j < text.length && /[\d._xXa-fA-F]/.test(text[j]!)) j++
      out += `${theme.num}${text.slice(i, j)}${theme.reset}`
      i = j
      continue
    }
    // ident / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j]!)) j++
      const w = text.slice(i, j)
      if (kws?.has(w)) out += `${theme.kw}${w}${theme.reset}`
      else out += w
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

function paintSign(kind: DiffBodyLineKind, theme: DiffRenderTheme): string {
  if (kind === 'add') return `${theme.add}+${theme.reset}`
  if (kind === 'del') return `${theme.del}-${theme.reset}`
  if (kind === 'ctx') return `${theme.dim} ${theme.reset}`
  return ' '
}

function formatGutter(
  oldNo: number | undefined,
  newNo: number | undefined,
  w: number,
  theme: DiffRenderTheme,
): string {
  const o = oldNo != null && oldNo > 0 ? String(oldNo).padStart(w, ' ') : ' '.repeat(w)
  const n = newNo != null && newNo > 0 ? String(newNo).padStart(w, ' ') : ' '.repeat(w)
  if (!theme.gutter) return `${o} ${n} `
  return `${theme.gutter}${o}${theme.reset} ${theme.gutter}${n}${theme.reset} `
}

/**
 * 渲染带行号（可选）+ 主题色 + 可选语法高亮的 unified 块。
 */
export function renderDiffBodyLines(
  body: readonly DiffBodyLine[],
  opts?: {
    filePath?: string
    theme?: DiffRenderTheme
    gutter?: boolean
    syntax?: boolean
    maxLines?: number
  },
): string {
  const theme = opts?.theme ?? resolveDiffRenderTheme()
  const gutter = opts?.gutter ?? shouldShowLineGutter()
  const syntax =
    opts?.syntax ?? shouldSyntaxHighlight({ theme })
  const max = opts?.maxLines ?? 500

  let maxLn = 1
  for (const L of body) {
    if (L.oldNo != null) maxLn = Math.max(maxLn, L.oldNo)
    if (L.newNo != null) maxLn = Math.max(maxLn, L.newNo)
  }
  const w = lineNumberWidth(maxLn)
  const out: string[] = []
  for (let i = 0; i < body.length && i < max; i++) {
    const L = body[i]!
    if (L.kind === 'header' || L.kind === 'meta') {
      const sty = L.kind === 'header' ? theme.dim : theme.meta
      out.push(sty ? `${sty}${L.text}${theme.reset}` : L.text)
      continue
    }
    const g = gutter ? formatGutter(L.oldNo, L.newNo, w, theme) : ''
    const sign = paintSign(L.kind, theme)
    let code = L.text
    if (syntax && (L.kind === 'add' || L.kind === 'del' || L.kind === 'ctx')) {
      code = highlightCodeLine(code, opts?.filePath, theme)
    }
    // 行背景感：整段 code 再套 add/del（语法 span 后 reset，再上色会冲掉——
    // 用前缀色包一层：先 sign，code 已含内联色）
    if (L.kind === 'add' && theme.add && !syntax) {
      code = `${theme.add}${L.text}${theme.reset}`
    } else if (L.kind === 'del' && theme.del && !syntax) {
      code = `${theme.del}${L.text}${theme.reset}`
    } else if (L.kind === 'ctx' && theme.dim && !syntax) {
      code = `${theme.dim}${L.text}${theme.reset}`
    } else if (L.kind === 'add' && theme.add && syntax) {
      // 保留语法色；行首已有 +
    } else if (L.kind === 'del' && theme.del && syntax) {
      // dim 删除行整体（Codex 做法）— 简单包一层 dim 会盖语法，跳过
    }
    out.push(`${g}${sign}${code}`)
  }
  if (body.length > max) {
    out.push(
      theme.dim
        ? `${theme.dim}…(+${body.length - max} lines)${theme.reset}`
        : `…(+${body.length - max} lines)`,
    )
  }
  return out.join('\n')
}

export function renderHunksRich(
  filePath: string,
  hunks: readonly DiffHunk[],
  opts?: {
    theme?: DiffRenderTheme | string
    color?: boolean
    gutter?: boolean
    syntax?: boolean
    maxLines?: number
    env?: NodeJS.ProcessEnv
  },
): string {
  const theme =
    typeof opts?.theme === 'object' && opts.theme
      ? opts.theme
      : resolveDiffRenderTheme({
          theme: typeof opts?.theme === 'string' ? opts.theme : undefined,
          color: opts?.color,
          env: opts?.env,
        })
  const body = expandHunksToBodyLines(filePath, hunks)
  return renderDiffBodyLines(body, {
    filePath,
    theme,
    gutter: opts?.gutter,
    syntax: opts?.syntax,
    maxLines: opts?.maxLines,
  })
}

/**
 * 对已有 unified 文本上色（无精确行号时仅用 +/-/@@；可选语法按 path）。
 * 兼容旧 colorizeUnifiedText 调用方。
 */
export function colorizeUnifiedTextRich(
  unified: string,
  opts?: {
    filePath?: string
    maxLines?: number
    theme?: DiffRenderTheme | string
    color?: boolean
    syntax?: boolean
    gutter?: boolean
    env?: NodeJS.ProcessEnv
  },
): string {
  const theme =
    typeof opts?.theme === 'object' && opts.theme
      ? opts.theme
      : resolveDiffRenderTheme({
          theme: typeof opts?.theme === 'string' ? opts.theme : undefined,
          color: opts?.color,
          env: opts?.env,
        })
  const max = opts?.maxLines ?? 80
  const syntax = opts?.syntax ?? shouldSyntaxHighlight({ theme, env: opts?.env })
  // 无 hunk 元数据：不造假行号（gutter 默认关）
  const gutter = opts?.gutter === true
  const lines = unified.split(/\r?\n/)
  const body: DiffBodyLine[] = []
  for (const L of lines) {
    if (L.startsWith('---') || L.startsWith('+++')) {
      body.push({ kind: 'header', text: L })
    } else if (L.startsWith('@@')) {
      body.push({ kind: 'meta', text: L })
    } else if (L.startsWith('+') && !L.startsWith('+++')) {
      body.push({ kind: 'add', text: L.slice(1) })
    } else if (L.startsWith('-') && !L.startsWith('---')) {
      body.push({ kind: 'del', text: L.slice(1) })
    } else if (L.startsWith(' ')) {
      body.push({ kind: 'ctx', text: L.slice(1) })
    } else {
      body.push({ kind: 'meta', text: L })
    }
  }
  return renderDiffBodyLines(body, {
    filePath: opts?.filePath,
    theme,
    gutter,
    syntax,
    maxLines: max,
  })
}