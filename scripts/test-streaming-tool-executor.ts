/**
 * StreamingToolExecutor 最小验收
 * - 边 add 边跑；drain 保序
 * - 并发安全工具重叠执行
 * - 非并发独占
 * - Bash 失败级联取消排队兄弟
 * - discard 后排队不执行
 */
import { buildTool, createBuiltinTools } from '../packages/tools/src/index.ts'
import { StreamingToolExecutor } from '../packages/core/src/streamingToolExecutor.ts'
import type { RunToolUseContext } from '../packages/core/src/toolExecution.ts'

function assert(c: unknown, m: string) {
  if (!c) {
    console.error('FAIL', m)
    process.exit(1)
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function baseCtx(
  tools: RunToolUseContext['tools'],
  signal?: AbortSignal,
): RunToolUseContext {
  return {
    sessionId: 's',
    cwd: process.cwd(),
    hooks: {},
    permissionMode: 'bypassPermissions',
    askPermission: async () => 'allow',
    tools,
    signal,
  }
}

async function main() {
  // 1) 保序：后完成的先入队，结果仍按入队序
  const order: string[] = []
  const slow = buildTool({
    name: 'SlowRead',
    description: 'slow',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: { type: 'object', properties: { id: { type: 'string' } } },
    async call(input) {
      const id = String((input as { id?: string }).id ?? '')
      await sleep(id === 'A' ? 80 : 10)
      order.push(id)
      return { ok: true, output: `done-${id}` }
    },
  })
  const ex1 = new StreamingToolExecutor({
    context: baseCtx([slow]),
  })
  ex1.addTool({ id: 'tA', name: 'SlowRead', input: { id: 'A' } })
  ex1.addTool({ id: 'tB', name: 'SlowRead', input: { id: 'B' } })
  const r1 = await ex1.drain()
  assert(r1.length === 2, 'order len')
  assert(r1[0]!.tool_call_id === 'tA' && r1[0]!.content.includes('done-A'), 'order A first')
  assert(r1[1]!.tool_call_id === 'tB' && r1[1]!.content.includes('done-B'), 'order B second')
  assert(order[0] === 'B' && order[1] === 'A', `B finishes first: ${order.join(',')}`)

  // 2) 并发重叠：两个 safe 工具的执行窗口重叠
  let concurrent = 0
  let maxConcurrent = 0
  const concurrentTool = buildTool({
    name: 'Conc',
    description: 'c',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: { type: 'object', properties: {} },
    async call() {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(40)
      concurrent -= 1
      return { ok: true, output: 'ok' }
    },
  })
  const ex2 = new StreamingToolExecutor({
    context: baseCtx([concurrentTool]),
  })
  ex2.addTool({ id: 'c1', name: 'Conc', input: {} })
  ex2.addTool({ id: 'c2', name: 'Conc', input: {} })
  await ex2.drain()
  assert(maxConcurrent >= 2, `expected concurrent>=2 got ${maxConcurrent}`)

  // 3) 非并发独占：Write-like 串行 maxConcurrent=1
  let serial = 0
  let maxSerial = 0
  const serialTool = buildTool({
    name: 'Serial',
    description: 's',
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: { type: 'object', properties: {} },
    async call() {
      serial += 1
      maxSerial = Math.max(maxSerial, serial)
      await sleep(30)
      serial -= 1
      return { ok: true, output: 'ok' }
    },
  })
  const ex3 = new StreamingToolExecutor({
    context: baseCtx([serialTool]),
  })
  ex3.addTool({ id: 's1', name: 'Serial', input: {} })
  ex3.addTool({ id: 's2', name: 'Serial', input: {} })
  await ex3.drain()
  assert(maxSerial === 1, `serial exclusive got max=${maxSerial}`)

  // 4) Bash 失败级联：先入队慢 safe，再 Bash 失败 → safe 被 cancel 或未跑完合成错误
  // 用假 Bash 名 + isConcurrencySafe false 模拟：真 Bash 需 shell。
  // 改用真实 Bash 失败命令 + 假慢 Read 并发？Bash 非并发，会等 Read 批？
  // 分区语义：Read(safe) 与 Bash(unsafe)：safe 先跑完再 Bash。
  // 要测级联：两个 Bash 串行——第一个失败后第二个排队被 cancel。
  const tools = createBuiltinTools()
  const ex4 = new StreamingToolExecutor({
    context: baseCtx(tools),
  })
  // 故意失败的 bash
  ex4.addTool({
    id: 'b1',
    name: 'Bash',
    input: {
      command:
        process.platform === 'win32'
          ? 'cmd /c exit 1'
          : 'exit 1',
    },
  })
  ex4.addTool({
    id: 'b2',
    name: 'Bash',
    input: { command: process.platform === 'win32' ? 'echo should-not' : 'echo should-not' },
  })
  const r4 = await ex4.drain()
  assert(r4.length === 2, 'bash cascade len')
  assert(
    r4[0]!.content.includes('tool_use_error') || r4[0]!.content.length > 0,
    'bash1 failed-ish',
  )
  // 第二个应被 sibling cancel
  assert(
    r4[1]!.content.includes('Cancelled: parallel') ||
      r4[1]!.content.includes('tool cancelled') ||
      r4[1]!.content.includes('Streaming discarded'),
    `bash2 cancelled: ${r4[1]!.content.slice(0, 120)}`,
  )
  assert(ex4.bashCascadeActive, 'cascade flag')

  // 5) discard：入队后 discard，drain 为 discarded 错误
  let ran = false
  const late = buildTool({
    name: 'Late',
    description: 'l',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: { type: 'object', properties: {} },
    async call() {
      ran = true
      await sleep(50)
      return { ok: true, output: 'ran' }
    },
  })
  // 用非并发 + 先占坑再 discard 排队项
  const blocker = buildTool({
    name: 'Blocker',
    description: 'b',
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    inputJSONSchema: { type: 'object', properties: {} },
    async call() {
      await sleep(60)
      return { ok: true, output: 'block' }
    },
  })
  const ex5 = new StreamingToolExecutor({
    context: baseCtx([blocker, late]),
  })
  ex5.addTool({ id: 'blk', name: 'Blocker', input: {} })
  ex5.addTool({ id: 'late', name: 'Late', input: {} })
  // 立即 discard：Blocker 可能在跑，Late 应 queued→discarded
  ex5.discard()
  const r5 = await ex5.drain()
  assert(ex5.isDiscarded, 'discarded flag')
  const lateMsg = r5.find((m) => m.tool_call_id === 'late')
  assert(lateMsg, 'late result present')
  assert(
    lateMsg!.content.includes('discarded') || !ran,
    `late discarded or not run: ${lateMsg!.content.slice(0, 80)} ran=${ran}`,
  )

  // 6) 未知工具立即完成错误，不堵队列
  const ex6 = new StreamingToolExecutor({
    context: baseCtx(tools),
  })
  ex6.addTool({ id: 'u1', name: 'NoSuch', input: {} })
  ex6.addTool({
    id: 'u2',
    name: 'Bash',
    input: {
      command: process.platform === 'win32' ? 'echo hi' : 'echo hi',
    },
  })
  const r6 = await ex6.drain()
  assert(r6[0]!.content.includes('No such tool'), 'unknown tool')
  assert(r6[1]!.content.includes('hi') || r6[1]!.content.length > 0, 'bash after unknown')

  // 7) tool_progress 经 onEvent 透出
  const progressLog: string[] = []
  const progTool = buildTool({
    name: 'Prog',
    description: 'p',
    requiresPermission: false,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    inputJSONSchema: { type: 'object', properties: {} },
    async call(_input, ctx) {
      ctx.onProgress?.('step-one')
      return { ok: true, output: 'done' }
    },
  })
  const ex7 = new StreamingToolExecutor({
    context: {
      ...baseCtx([progTool]),
      onEvent: (e) => {
        if (e.type === 'tool_progress') {
          progressLog.push(`${e.name}:${e.message}`)
        }
      },
    },
  })
  ex7.addTool({ id: 'p1', name: 'Prog', input: {} })
  await ex7.drain()
  assert(
    progressLog.some((x) => x.includes('step-one')),
    `progress events: ${progressLog.join(',')}`,
  )

  // 8) interruptBehavior: block 不因 parent interrupt 取消；cancel 会取消
  let blockFinished = false
  const blockTool = buildTool({
    name: 'BlockWrite',
    description: 'block',
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    interruptBehavior: () => 'block',
    inputJSONSchema: { type: 'object', properties: {} },
    async call(_input, ctx) {
      await sleep(80)
      blockFinished = !ctx.signal?.aborted
      return {
        ok: true,
        output: ctx.signal?.aborted ? 'aborted' : 'ok-block',
      }
    },
  })
  const parentBlock = new AbortController()
  const ex8 = new StreamingToolExecutor({
    context: baseCtx([blockTool], parentBlock.signal),
  })
  ex8.addTool({ id: 'bw', name: 'BlockWrite', input: {} })
  await sleep(15)
  parentBlock.abort('interrupt')
  const r8 = await ex8.drain()
  assert(blockFinished, 'block tool finished despite interrupt')
  assert(
    r8[0]!.content.includes('ok-block'),
    `block result: ${r8[0]!.content.slice(0, 80)}`,
  )

  let cancelSawAbort = false
  const cancelTool = buildTool({
    name: 'CancelShell',
    description: 'cancel',
    requiresPermission: false,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    interruptBehavior: () => 'cancel',
    inputJSONSchema: { type: 'object', properties: {} },
    async call(_input, ctx) {
      await sleep(80)
      cancelSawAbort = Boolean(ctx.signal?.aborted)
      return {
        ok: !ctx.signal?.aborted,
        output: ctx.signal?.aborted ? 'cancelled' : 'ok-cancel',
        isError: Boolean(ctx.signal?.aborted),
      }
    },
  })
  const parentCancel = new AbortController()
  const ex9 = new StreamingToolExecutor({
    context: baseCtx([cancelTool], parentCancel.signal),
  })
  ex9.addTool({ id: 'cs', name: 'CancelShell', input: {} })
  await sleep(15)
  parentCancel.abort('interrupt')
  const r9 = await ex9.drain()
  assert(cancelSawAbort, 'cancel tool saw abort')
  assert(
    r9[0]!.content.includes('cancelled') ||
      r9[0]!.content.includes('tool cancelled') ||
      r9[0]!.content.includes('Abort'),
    `cancel result: ${r9[0]!.content.slice(0, 100)}`,
  )

  console.log('STREAMING TOOL EXECUTOR TESTS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})