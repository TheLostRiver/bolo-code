/**
 * AR3C · 内容卡片视图模型 + renderer 不得注入 HTML
 *
 * 两件事放在一个文件里，因为它们是同一个交付的两面：
 * **卡片长什么样由 packages 决定，renderer 只负责把纯文本放进 DOM。**
 *
 * ## 折叠策略是从反面教材来的
 *
 * Codex App 被专门开 issue 抱怨过（#16415）：消息流里工具调用/步骤
 * **默认全部折叠**，即使开到最详也要反复手点展开，导致「很难实时监督并 steer」。
 * 折叠省空间，但杀掉的正是 agent 界面最该有的东西——看着它干活。
 *
 * 所以这里的规则是：**正在跑的展开，跑完的折叠，出错的永远展开。**
 * 用户需要盯的是「现在在干什么」和「哪里出了问题」，不是三十条已完成的历史。
 *
 * ## 截断必须可见
 *
 * 超长输出要截，但截了就得说。悄悄截断会让人以为工具真的只返回了那么多——
 * 与本项目一路在防的「显示出没发生过的事」是同一类。
 *
 * ## renderer 不得注入 HTML
 *
 * 模型输出是不可信内容。桌面端当前是干净的（`innerHTML` 只用于清空），
 * 但 AR3C 正是有人会伸手用 `innerHTML` 渲 markdown 的时刻——
 * 在改之前先把这条性质钉死，比出事后再查容易得多。
 *
 * 运行：npx tsx scripts/test-timeline-cards.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  buildTimelineCards,
  type TimelineTurn,
} from '../packages/shared/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

function turn(index: number, items: TimelineTurn['items']): TimelineTurn {
  return { index, items }
}

async function main() {
  // ── 1) 正在跑的工具默认**展开** ──
  // 这是对 Codex App「默认全折叠、难以实时监督」那条抱怨的直接回应。
  {
    const cards = buildTimelineCards({
      turns: [
        turn(0, [
          { kind: 'user', text: 'go' },
          { kind: 'tool', callId: 'c1', name: 'Bash', complete: false },
        ]),
      ],
    })
    const tool = cards.find((c) => c.kind === 'tool')
    assert(tool, 'produces a tool card')
    assert(
      tool!.collapsed === false,
      'a running tool is expanded — collapsing it is what makes an agent impossible to supervise',
    )
    assert(tool!.status === 'running', `status reflects it is still going: ${tool!.status}`)
  }

  // ── 2) 已完成的工具折叠，但摘要行仍要有信息 ──
  {
    const cards = buildTimelineCards({
      turns: [
        turn(0, [
          { kind: 'tool', callId: 'c1', name: 'Read', complete: true, output: 'body' },
        ]),
      ],
    })
    const tool = cards.find((c) => c.kind === 'tool')!
    assert(tool.collapsed === true, 'a finished tool collapses to save space')
    assert(
      tool.title.includes('Read'),
      `the collapsed line still names the tool: ${tool.title}`,
    )
    assert(tool.status === 'ok', `status ok: ${tool.status}`)
  }

  // ── 3) 出错的**永远展开** ──
  // 失败是用户唯一必须看到的东西，折叠它等于把问题藏起来。
  {
    const cards = buildTimelineCards({
      turns: [
        turn(0, [
          {
            kind: 'tool',
            callId: 'c1',
            name: 'Bash',
            complete: true,
            output: '<tool_use_error>command not found</tool_use_error>',
          },
        ]),
      ],
    })
    const tool = cards.find((c) => c.kind === 'tool')!
    assert(
      tool.collapsed === false,
      'a failed tool is never collapsed — hiding failures is the one thing the UI must not do',
    )
    assert(tool.status === 'error', `and is marked as an error: ${tool.status}`)
  }

  // ── 4) 截断必须可见，且保头保尾 ──
  {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
    const cards = buildTimelineCards({
      turns: [
        turn(0, [
          { kind: 'tool', callId: 'c1', name: 'Bash', complete: true, output: long },
        ]),
      ],
      maxBodyChars: 500,
    })
    const tool = cards.find((c) => c.kind === 'tool')!
    assert(tool.truncated === true, 'long output is marked as truncated')
    assert(
      tool.body!.length < long.length,
      'and the body really is shorter',
    )
    assert(
      tool.body!.includes('line 0'),
      'the head survives — you need to see how it started',
    )
    assert(
      tool.body!.includes('line 399'),
      'and the tail survives — the end usually carries the result or the error',
    )
  }

  // ── 5) compact summary 单独成卡，不冒充用户消息 ──
  {
    const cards = buildTimelineCards({
      turns: [turn(0, [{ kind: 'summary', text: 'earlier work' }])],
    })
    const c = cards[0]!
    assert(c.kind === 'summary', `summary keeps its own kind: ${c.kind}`)
    assert(
      !/^you\b/i.test(c.title),
      'and is not presented as something the user said',
    )
  }

  // ── 6) diff 卡带增删计数，折叠时也看得出规模 ──
  {
    const cards = buildTimelineCards({
      turns: [
        turn(0, [
          { kind: 'diff', path: 'src/a.ts', tool: 'Edit', added: 12, removed: 3 },
        ]),
      ],
    })
    const d = cards.find((c) => c.kind === 'diff')!
    assert(d.title.includes('src/a.ts'), `names the file: ${d.title}`)
    assert(
      d.title.includes('12') && d.title.includes('3'),
      `the collapsed line carries the size: ${d.title}`,
    )
  }

  // ── 7) 卡片 id 稳定且唯一——否则重渲染会错位 ──
  {
    const turns = [
      turn(0, [
        { kind: 'user' as const, text: 'q' },
        { kind: 'tool' as const, callId: 'c1', name: 'Read', complete: true, output: 'a' },
        { kind: 'tool' as const, callId: 'c2', name: 'Grep', complete: true, output: 'b' },
      ]),
    ]
    const a = buildTimelineCards({ turns })
    const b = buildTimelineCards({ turns })
    assert(
      a.map((c) => c.id).join(',') === b.map((c) => c.id).join(','),
      'ids are stable across rebuilds',
    )
    assert(
      new Set(a.map((c) => c.id)).size === a.length,
      `ids are unique: ${a.map((c) => c.id).join(',')}`,
    )
  }

  // ── 8) 纯函数 ──
  {
    const turns = [turn(0, [{ kind: 'user' as const, text: 'q' }])]
    const before = JSON.stringify(turns)
    buildTimelineCards({ turns })
    assert(JSON.stringify(turns) === before, 'never mutates its input')
    assert(buildTimelineCards({ turns: [] }).length === 0, 'empty is empty')
  }

  // ── 9) renderer 不得把内容当 HTML 注入 ──
  // 模型输出是不可信内容。当前只在清空时用 innerHTML；这条性质要在
  // 加卡片渲染之前钉死，因为那正是有人会伸手渲 markdown 的时刻。
  {
    const src = await fs.readFile(
      path.join('apps', 'desktop', 'src', 'renderer', 'app.js'),
      'utf8',
    )
    const injections = [...src.matchAll(/\.innerHTML\s*=\s*([^\n]+)/g)]
      .map((m) => m[1]!.trim())
      .filter((rhs) => rhs !== "''" && rhs !== '""' && rhs !== '``')
    assert(
      injections.length === 0,
      `renderer assigns non-empty innerHTML: ${injections.join(' | ')} — ` +
        'model output is untrusted; use textContent so it can never execute',
    )
    assert(
      !/insertAdjacentHTML|outerHTML\s*=/.test(src),
      'no other HTML injection paths either',
    )
    // 抽取器自身要有效，否则上面两条永真
    assert(
      /innerHTML/.test(src),
      'sanity: the extractor really does find innerHTML in this file',
    )
  }

  console.log('PASS: timeline cards')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
