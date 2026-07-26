/**
 * AR-T3b：引用去重
 *
 * 活体实测发现（第三方 Anthropic 中转，2026-07-26）：Anthropic **逐句**发送引用，
 * 于是同一个来源支撑多句话时就被重复渲染。实测一次搜索出 7 行引用、
 * 但只有 4 个不同 URL，其中一个连着出现 3 次。
 *
 * 这不是解析 bug（provider 确实发了 7 条），但屏幕上重复三遍同一个链接是噪音。
 * 去重放在**渲染层**：解析层如实反映 provider 发了什么，展示层负责不刷屏。
 *
 * 运行：npx tsx scripts/test-web-search-citation-dedupe.ts
 */
import { createSessionEventPrinter } from '../packages/cli/src/tui/formatSessionEvent.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function run(events: Array<Record<string, unknown>>): string {
  const out: string[] = []
  const printer = createSessionEventPrinter({
    writeOut: (s: string) => out.push(s),
    writeErr: () => {},
  })
  printer.beginTurn()
  for (const e of events) printer.onEvent(e as never)
  return out.join('')
}

const cite = (url: string, title?: string) => ({
  type: 'web_search',
  phase: 'citation',
  url,
  ...(title ? { title } : {}),
})

async function main() {
  // ── 1) 同一 URL 重复只渲染一次 ──
  {
    const text = run([
      cite('https://a.example/x', 'A'),
      cite('https://a.example/x', 'A'),
      cite('https://a.example/x', 'A'),
    ])
    const lines = text.split('\n').filter((l) => l.includes('a.example/x'))
    assert(
      lines.length === 1,
      `repeated citation renders once, got ${lines.length}`,
    )
  }

  // ── 2) 不同 URL 各渲染一次 ──
  {
    const text = run([
      cite('https://a.example/x', 'A'),
      cite('https://b.example/y', 'B'),
      cite('https://a.example/x', 'A'),
      cite('https://c.example/z', 'C'),
    ])
    for (const u of ['a.example/x', 'b.example/y', 'c.example/z']) {
      const n = text.split('\n').filter((l) => l.includes(u)).length
      assert(n === 1, `${u} renders exactly once, got ${n}`)
    }
  }

  // ── 3) 非引用阶段不受影响 ──
  {
    const text = run([
      { type: 'web_search', phase: 'query', query: 'node lts' },
      { type: 'web_search', phase: 'results', resultCount: 7 },
      cite('https://a.example/x'),
    ])
    assert(text.includes('node lts'), 'query still rendered')
    assert(text.includes('7'), 'result count still rendered')
    assert(text.includes('a.example/x'), 'citation still rendered')
  }

  // ── 4) 新一轮重新开始计数（换个问题时同源应再次显示） ──
  {
    const out: string[] = []
    const printer = createSessionEventPrinter({
      writeOut: (s: string) => out.push(s),
      writeErr: () => {},
    })
    printer.beginTurn()
    printer.onEvent(cite('https://a.example/x') as never)
    printer.endTurn()
    printer.beginTurn()
    printer.onEvent(cite('https://a.example/x') as never)
    const lines = out.join('').split('\n').filter((l) => l.includes('a.example/x'))
    assert(
      lines.length === 2,
      `a new turn shows the source again, got ${lines.length}`,
    )
  }

  console.log('PASS: web search citation dedupe')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
