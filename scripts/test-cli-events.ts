/**
 * CLI T4/T5：事件格式化 + 权限解析纯函数
 * 运行：npx tsx scripts/test-cli-events.ts
 */
import {
  createSessionEventPrinter,
  formatPermissionPrompt,
  formatSessionEventChunks,
  formatToolEventLine,
  parsePermissionAnswer,
  createTtyAskPermission,
} from '../packages/cli/src/index.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

async function main() {
  // ── formatToolEventLine ──
  assert(
    formatToolEventLine({ type: 'tool_start', id: '1', name: 'Bash' }) ===
      '→ Bash',
    'tool_start line',
  )
  const progLine = formatToolEventLine({
    type: 'tool_progress',
    id: '1',
    name: 'Bash',
    message: 'running: echo',
  })
  assert(
    typeof progLine === 'string' &&
      progLine.includes('Bash') &&
      progLine.includes('running'),
    'tool_progress line',
  )
  assert(
    formatToolEventLine({
      type: 'tool_end',
      id: '1',
      name: 'Bash',
      output: 'ok',
      ok: true,
    }) === '✓ Bash',
    'tool_end ok',
  )
  assert(
    formatToolEventLine({
      type: 'tool_end',
      id: '1',
      name: 'Read',
      output: 'err',
      ok: false,
    }) === '✗ Read',
    'tool_end fail',
  )
  assert(
    formatToolEventLine({ type: 'text', text: 'hi' }) === null,
    'text not tool line',
  )
  assert(
    formatToolEventLine({ type: 'phase', phase: 'running' }) === null,
    'phase ignored',
  )

  // ── formatSessionEventChunks ──
  const textChunks = formatSessionEventChunks({ type: 'text', text: 'Hel' })
  assert(textChunks.length === 1 && textChunks[0]!.text === 'Hel', 'text chunk')
  assert(textChunks[0]!.stream === 'out', 'text out')

  const startChunks = formatSessionEventChunks({
    type: 'tool_start',
    id: 't1',
    name: 'Skill',
  })
  assert(
    startChunks[0]!.text === '→ Skill\n',
    `tool start chunk got ${JSON.stringify(startChunks)}`,
  )

  const errChunks = formatSessionEventChunks({
    type: 'error',
    message: 'boom',
  })
  assert(errChunks[0]!.stream === 'err', 'error stream')
  assert(errChunks[0]!.text.includes('boom'), 'error text')

  assert(
    formatSessionEventChunks({ type: 'phase', phase: 'idle' }).length === 0,
    'phase silent',
  )

  const reasonChunks = formatSessionEventChunks({
    type: 'reasoning',
    text: 'hmm',
  })
  assert(reasonChunks.length === 1, 'reasoning chunk')
  assert(reasonChunks[0]!.text.includes('hmm'), 'reasoning text')
  assert(
    formatSessionEventChunks({ type: 'reasoning', text: '' }).length === 0,
    'empty reasoning silent',
  )

  // ── printer：流式 + 工具行不刷屏 ──
  const out: string[] = []
  const err: string[] = []
  const p = createSessionEventPrinter({
    writeOut: (s) => out.push(s),
    writeErr: (s) => err.push(s),
  })
  p.beginTurn()
  p.onEvent({ type: 'phase', phase: 'running' })
  p.onEvent({ type: 'text', text: 'Hello' })
  p.onEvent({ type: 'text', text: ' world' })
  p.onEvent({ type: 'tool_start', id: '1', name: 'Bash', input: {} })
  p.onEvent({
    type: 'tool_end',
    id: '1',
    name: 'Bash',
    output: 'done',
    ok: true,
  })
  p.onEvent({ type: 'text', text: 'done.\n' })
  p.endTurn()

  const joined = out.join('')
  assert(joined.includes('Hello world'), 'streamed text')
  assert(joined.includes('→ Bash\n'), 'tool start printed')
  assert(joined.includes('✓ Bash\n'), 'tool end printed')
  assert(p.didStreamText() === true, 'didStreamText')
  assert(err.length === 0, 'no err on happy path')
  // phase 不出现
  assert(!joined.includes('running'), 'no phase spam')

  // ── printer：thinking 与正文分离 ──
  const outR: string[] = []
  const pR = createSessionEventPrinter({
    writeOut: (s) => outR.push(s),
    writeErr: () => {},
  })
  pR.beginTurn()
  pR.onEvent({ type: 'reasoning', text: 'step A' })
  pR.onEvent({ type: 'reasoning', text: ' step B' })
  pR.onEvent({ type: 'text', text: 'Final answer' })
  pR.endTurn()
  const joinedR = outR.join('')
  assert(joinedR.includes('thinking'), 'thinking prefix')
  assert(joinedR.includes('step A'), 'reasoning body')
  assert(joinedR.includes('Final answer'), 'text after reasoning')
  // 前缀 thinking 不应粘在 Final answer 同一段无换行（应有换行分隔）
  assert(
    /step B[\s\S]*\n[\s\S]*Final answer/.test(joinedR) ||
      joinedR.indexOf('step B') < joinedR.indexOf('Final answer'),
    'reasoning before text',
  )
  // 无 reasoning 事件时不输出 thinking 字样
  const outPlain: string[] = []
  const pPlain = createSessionEventPrinter({
    writeOut: (s) => outPlain.push(s),
  })
  pPlain.beginTurn()
  pPlain.onEvent({ type: 'text', text: 'only text' })
  pPlain.endTurn()
  assert(
    !outPlain.join('').includes('thinking'),
    'no fake thinking when absent',
  )

  // showThinking=false：不渲染 reasoning，正文仍出
  const outOff: string[] = []
  const pOff = createSessionEventPrinter({
    writeOut: (s) => outOff.push(s),
    showThinking: false,
  })
  pOff.beginTurn()
  pOff.onEvent({ type: 'reasoning', text: 'secret-think' })
  pOff.onEvent({ type: 'text', text: 'visible' })
  pOff.endTurn()
  const joinedOff = outOff.join('')
  assert(!joinedOff.includes('thinking'), 'off: no thinking prefix')
  assert(!joinedOff.includes('secret-think'), 'off: no reasoning body')
  assert(joinedOff.includes('visible'), 'off: text still shown')

  // showThinking 函数门控
  let gate = true
  const outGate: string[] = []
  const pGate = createSessionEventPrinter({
    writeOut: (s) => outGate.push(s),
    showThinking: () => gate,
  })
  pGate.beginTurn()
  pGate.onEvent({ type: 'reasoning', text: 'shown' })
  gate = false
  pGate.onEvent({ type: 'reasoning', text: 'hidden' })
  pGate.endTurn()
  assert(outGate.join('').includes('shown'), 'gate on shows')
  assert(!outGate.join('').includes('hidden'), 'gate off hides')

  // ── permission parse ──
  assert(parsePermissionAnswer('y') === 'allow', 'y allow')
  assert(parsePermissionAnswer('YES') === 'allow', 'YES allow')
  assert(parsePermissionAnswer('') === 'deny', 'empty deny')
  assert(parsePermissionAnswer('n') === 'deny', 'n deny')
  assert(
    formatPermissionPrompt('Bash') === 'Allow Bash? [y/a/N] ',
    'prompt format',
  )

  // ── non-TTY deny ──
  const denyFn = createTtyAskPermission({ isTty: false })
  const d = await denyFn({
    toolName: 'Bash',
    toolInput: {},
    toolUseId: 'u1',
  })
  assert(d === 'deny', 'non-tty deny')

  // ── TTY mock answer ──
  const allowFn = createTtyAskPermission({
    isTty: true,
    readAnswer: async () => 'y',
  })
  const a = await allowFn({
    toolName: 'Edit',
    toolInput: {},
    toolUseId: 'u2',
  })
  assert(a === 'allow', 'tty y allow')

  const alwaysFn = createTtyAskPermission({
    isTty: true,
    readAnswer: async () => 'a',
  })
  const al = await alwaysFn({
    toolName: 'Bash',
    toolInput: {},
    toolUseId: 'u2a',
  })
  assert(al === 'allow_always', 'tty a allow_always')

  const noFn = createTtyAskPermission({
    isTty: true,
    readAnswer: async () => '',
  })
  const n = await noFn({
    toolName: 'Edit',
    toolInput: {},
    toolUseId: 'u3',
  })
  assert(n === 'deny', 'tty empty deny')

  console.log('ok: test-cli-events')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})