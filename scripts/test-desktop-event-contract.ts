/**
 * Desktop renderer 监听的事件名必须真实存在于 core 的 SessionEvent
 *
 * 已确认的实例：core 发 `{ type: 'text' }`，renderer 却在判
 * `e.type === 'text_delta'`——而 **`'text_delta'` 全仓零命中**。
 * 那个分支从来没有执行过，桌面端的「流式」是假的：气泡永不增量更新，
 * 靠 turn 结束后 `reloadMessages()` 全量重拉掩盖。
 *
 * 这类 bug 为什么必须由测试守：
 *
 * - `SessionEvent` 是 **TS 联合类型**，只在编译期存在；renderer 是**原生 JS**，
 *   拿不到任何类型检查。两边靠字符串对齐，而字符串漂移**不会报错**——
 *   分支只是静默地永不命中。
 * - 症状不是崩溃而是「功能看起来有、其实没有」。桌面端至今如此。
 * - core 每加一个事件类型，renderer 都可能漏接；反向则是拼错就永久失效。
 *
 * 做法：从 core 的联合类型声明里抽出全部 `type: '...'` 字面量（那是真源），
 * 再从 renderer 里抽出全部 `e.type === '...'` 比较，要求后者 ⊆ 前者。
 *
 * 运行：npx tsx scripts/test-desktop-event-contract.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const CORE_INDEX = path.join('packages', 'core', 'src', 'index.ts')
const RENDERER = path.join('apps', 'desktop', 'src', 'renderer', 'app.js')

/** 从 `export type SessionEvent = ...` 声明块里抽出全部 type 字面量 */
function extractCoreEventTypes(source: string): Set<string> {
  const start = source.indexOf('export type SessionEvent =')
  assert(start >= 0, 'SessionEvent union not found — the truth source moved')
  // 联合体到下一个顶层 `export ` 声明为止
  const rest = source.slice(start + 'export type SessionEvent ='.length)
  const endRel = rest.search(/\nexport /)
  const block = endRel >= 0 ? rest.slice(0, endRel) : rest
  const out = new Set<string>()
  for (const m of block.matchAll(/\btype:\s*'([a-z_]+)'/g)) {
    out.add(m[1]!)
  }
  return out
}

/**
 * 只抽 **事件流回调内部**的 `.type === '...'`。
 *
 * 不能全文匹配：renderer 里还有 `r.type === 'slash' | 'prompt' | 'turn'`，
 * 那是 `submit()` 的 IPC **响应**形状，与 SessionEvent 无关。
 * 全文匹配会把它们当成漏接事件误报——**有误报的测试比没有测试更糟**，
 * 会训练人去忽略它。
 */
function extractRendererEventTypes(source: string): Set<string> {
  const start = source.indexOf('onEvent(')
  assert(start >= 0, 'onEvent callback not found in the renderer — did the wiring move?')
  const block = sliceCallbackBlock(source, start)
  const out = new Set<string>()
  for (const m of block.matchAll(/\.type\s*===\s*'([a-z_]+)'/g)) {
    out.add(m[1]!)
  }
  return out
}

/** 从 `onEvent(` 起按花括号配平截出回调体 */
function sliceCallbackBlock(source: string, from: number): string {
  const open = source.indexOf('{', from)
  assert(open >= 0, 'onEvent callback body not found')
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  assert(false, 'unbalanced braces while slicing the onEvent callback')
  return ''
}

async function main() {
  const coreSrc = await fs.readFile(CORE_INDEX, 'utf8')
  const renderSrc = await fs.readFile(RENDERER, 'utf8')

  const coreTypes = extractCoreEventTypes(coreSrc)
  const rendererTypes = extractRendererEventTypes(renderSrc)

  // 抽取器自身不能是空的，否则下面的包含判断永真
  assert(
    coreTypes.size >= 8,
    `extracted only ${coreTypes.size} core event types — the extractor is broken, ` +
      'and a broken extractor makes the whole test vacuous',
  )
  assert(
    rendererTypes.size >= 3,
    `extracted only ${rendererTypes.size} renderer event checks — extractor likely broken`,
  )
  assert(
    coreTypes.has('text') && coreTypes.has('tool_end'),
    `sanity: known event types present, got ${[...coreTypes].join(', ')}`,
  )

  const unknown = [...rendererTypes].filter((t) => !coreTypes.has(t))
  assert(
    unknown.length === 0,
    `renderer branches on event type(s) core never emits: ${unknown.join(', ')} — ` +
      'the branch is dead code and the feature silently does nothing. ' +
      `core emits: ${[...coreTypes].sort().join(', ')}`,
  )

  // 反向只作提示，不失败：renderer 不必处理每一种事件
  const unhandled = [...coreTypes].filter((t) => !rendererTypes.has(t))
  console.log(
    `  core emits ${coreTypes.size} event types; renderer handles ${rendererTypes.size}`,
  )
  if (unhandled.length) {
    console.log(`  (not handled by the desktop renderer: ${unhandled.sort().join(', ')})`)
  }
  console.log('PASS: desktop event contract')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
