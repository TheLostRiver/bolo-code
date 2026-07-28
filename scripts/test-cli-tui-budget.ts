/**
 * OI-14G: retained TUI release budgets.
 *
 * The parent process measures the built artifact and cold start serially. A
 * dedicated --expose-gc child measures the Bolo renderer with a discard
 * writer, so headless xterm scrollback/reflow is not charged to the CLI heap.
 */
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import {
  createRetainedTuiController,
  type CliTuiController,
} from '../packages/cli/src/index.ts'
import type { ChatMessage } from '../packages/shared/src/index.ts'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const distEntry = path.join(repoRoot, 'dist', 'bolo.mjs')
const workerEnv = 'BOLO_TUI_BUDGET_CHILD'

const BUNDLE_BASELINE_BYTES = 1_385_065
const MAX_BUNDLE_DELTA_BYTES = 1_500_000
const MAX_COLD_START_DELTA_MS = 100
const MAX_RENDER_CPU_MS = 3_000
const MAX_RENDER_HEAP_DELTA_MB = 128
const MAX_CLEANUP_RETAINED_DELTA_MB = 64
const COLD_WARMUPS = 2
const COLD_SAMPLES = 10

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

class BudgetOutput extends EventEmitter {
  readonly columns = 80
  readonly rows = 40
}

function createLongHistory(): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let turn = 0; turn < 250; turn += 1) {
    const turnId = String(turn).padStart(3, '0')
    messages.push({
      role: 'user',
      content: `history user ${turnId}`,
    })
    messages.push({
      role: 'assistant',
      content: Array.from(
        { length: 39 },
        (_, line) =>
          `t${turnId} l${String(line).padStart(2, '0')} retained budget`,
      ).join('\n'),
    })
  }
  return messages
}

function heapMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024)
}

async function forceGc(): Promise<void> {
  assert(
    typeof global.gc === 'function',
    'budget worker must run under node --expose-gc',
  )
  for (let pass = 0; pass < 3; pass += 1) {
    global.gc()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

type WorkerReport = {
  blocks: number
  sourceLines: number
  writes: number
  renderedChars: number
  wallMs: number
  cpuMs: number
  renderHeapDeltaMb: number
  cleanupRetainedDeltaMb: number
}

async function runBudgetWorker(): Promise<void> {
  const history = createLongHistory()
  const sourceLines = history.reduce(
    (sum, message) => sum + message.content.split('\n').length,
    0,
  )
  assert(history.length === 500, 'worker fixture has 500 transcript blocks')
  assert(sourceLines === 10_000, 'worker fixture has 10,000 source lines')

  const output = new BudgetOutput()
  let writes = 0
  let renderedChars = 0
  let controller: CliTuiController | undefined

  await forceGc()
  const heapBefore = heapMb()
  const cpuBefore = process.cpuUsage()
  const wallStartedAt = performance.now()

  try {
    controller = createRetainedTuiController({
      output,
      writeOut: (text) => {
        writes += 1
        renderedChars += text.length
      },
      env: { NO_COLOR: '1' },
    })
    controller.setWelcomeVisible(false)
    await controller.start()
    controller.restoreMessages(history)
    await controller.flush()

    const blocks = controller
      .getState()
      .turns.reduce((sum, turn) => sum + turn.blocks.length, 0)
    const cpu = process.cpuUsage(cpuBefore)
    const report: WorkerReport = {
      blocks,
      sourceLines,
      writes,
      renderedChars,
      wallMs: performance.now() - wallStartedAt,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      renderHeapDeltaMb: heapMb() - heapBefore,
      cleanupRetainedDeltaMb: 0,
    }

    await controller.stop()
    controller = undefined
    await forceGc()
    report.cleanupRetainedDeltaMb = heapMb() - heapBefore
    console.log(JSON.stringify(report))
  } finally {
    await controller?.stop()
  }
}

function median(samples: readonly number[]): number {
  assert(samples.length > 0, 'median needs at least one sample')
  const ordered = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  if (ordered.length % 2 === 1) return ordered[middle]!
  return (ordered[middle - 1]! + ordered[middle]!) / 2
}

function timedNode(
  args: string[],
  label: string,
): number {
  const startedAt = performance.now()
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  const elapsedMs = performance.now() - startedAt
  assert(!result.error, `${label} launched (${result.error?.message ?? ''})`)
  assert(
    result.status === 0,
    `${label} exited 0 (status=${String(result.status)}, ` +
      `stderr=${result.stderr.trim()})`,
  )
  return elapsedMs
}

function measureColdStart(): {
  nodeP50Ms: number
  boloP50Ms: number
  deltaMs: number
  nodeSamplesMs: number[]
  boloSamplesMs: number[]
} {
  for (let pass = 0; pass < COLD_WARMUPS; pass += 1) {
    timedNode(['-e', ''], 'empty Node warmup')
    timedNode([distEntry, '--help'], 'Bolo help warmup')
  }

  const nodeSamples: number[] = []
  const boloSamples: number[] = []
  for (let sample = 0; sample < COLD_SAMPLES; sample += 1) {
    nodeSamples.push(timedNode(['-e', ''], 'empty Node sample'))
    boloSamples.push(timedNode([distEntry, '--help'], 'Bolo help sample'))
  }
  const nodeP50Ms = median(nodeSamples)
  const boloP50Ms = median(boloSamples)
  return {
    nodeP50Ms,
    boloP50Ms,
    deltaMs: boloP50Ms - nodeP50Ms,
    nodeSamplesMs: nodeSamples,
    boloSamplesMs: boloSamples,
  }
}

function runWorkerProcess(): WorkerReport {
  const execArgs = process.execArgv.includes('--expose-gc')
    ? [...process.execArgv]
    : ['--expose-gc', ...process.execArgv]
  const child = spawnSync(
    process.execPath,
    [...execArgs, fileURLToPath(import.meta.url)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        [workerEnv]: '1',
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    },
  )
  assert(!child.error, `budget worker launched (${child.error?.message ?? ''})`)
  assert(
    child.status === 0,
    `budget worker exited 0 (status=${String(child.status)}, ` +
      `stderr=${child.stderr.trim()})`,
  )
  const reportLine = child.stdout.trim().split(/\r?\n/gu).at(-1)
  assert(reportLine, 'budget worker emitted a JSON report')
  return JSON.parse(reportLine) as WorkerReport
}

async function assertGateRegistration(): Promise<void> {
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> }
  const scripts = pkg.scripts ?? {}
  assert(
    scripts['test:cli-tui-budget'] ===
      'npm run build && tsx scripts/test-cli-tui-budget.ts',
    'test:cli-tui-budget rebuilds before running the standalone budget gate',
  )

  const defaultGate = scripts.test ?? ''
  const buildIndex = defaultGate.indexOf('tsx scripts/test-dist-build.ts')
  const budgetIndex = defaultGate.indexOf(
    'tsx scripts/test-cli-tui-budget.ts',
  )
  const installIndex = defaultGate.indexOf('tsx scripts/test-dist-install.ts')
  assert(buildIndex >= 0, 'default gate contains dist build')
  assert(
    budgetIndex > buildIndex,
    'default gate runs the TUI budget after dist build',
  )
  assert(
    installIndex > budgetIndex,
    'default gate runs clean install after the TUI budget',
  )
}

async function main(): Promise<void> {
  await assertGateRegistration()

  const bundle = await fs.stat(distEntry)
  const bundleDeltaBytes = bundle.size - BUNDLE_BASELINE_BYTES
  assert(
    bundleDeltaBytes <= MAX_BUNDLE_DELTA_BYTES,
    `bundle grew ${bundleDeltaBytes} bytes from the ` +
      `${BUNDLE_BASELINE_BYTES}-byte baseline, over the ` +
      `${MAX_BUNDLE_DELTA_BYTES}-byte budget`,
  )

  const cold = measureColdStart()
  assert(
    cold.deltaMs <= MAX_COLD_START_DELTA_MS,
    `Bolo --help p50 added ${cold.deltaMs.toFixed(1)}ms over empty Node, ` +
      `over the ${MAX_COLD_START_DELTA_MS}ms budget; ` +
      `node=[${cold.nodeSamplesMs.map((value) => value.toFixed(1)).join(',')}], ` +
      `bolo=[${cold.boloSamplesMs.map((value) => value.toFixed(1)).join(',')}]`,
  )

  const worker = runWorkerProcess()
  assert(worker.blocks === 500, 'worker retained all 500 transcript blocks')
  assert(worker.sourceLines === 10_000, 'worker rendered 10,000 source lines')
  assert(worker.writes > 0, 'worker emitted at least one retained frame')
  assert(worker.renderedChars > 0, 'worker frame was not empty')
  assert(
    worker.cpuMs <= MAX_RENDER_CPU_MS,
    `retained render used ${worker.cpuMs.toFixed(1)}ms CPU, over the ` +
      `${MAX_RENDER_CPU_MS}ms budget`,
  )
  assert(
    worker.renderHeapDeltaMb <= MAX_RENDER_HEAP_DELTA_MB,
    `retained render grew heap by ${worker.renderHeapDeltaMb.toFixed(1)}MB, ` +
      `over the ${MAX_RENDER_HEAP_DELTA_MB}MB budget`,
  )
  assert(
    worker.cleanupRetainedDeltaMb <= MAX_CLEANUP_RETAINED_DELTA_MB,
    `cleanup retained ${worker.cleanupRetainedDeltaMb.toFixed(1)}MB, over ` +
      `the ${MAX_CLEANUP_RETAINED_DELTA_MB}MB budget`,
  )

  console.log(
    'PASS: CLI TUI budgets ' +
      `(bundle=${bundle.size}B, delta=${bundleDeltaBytes}B; ` +
      `cold=${cold.deltaMs.toFixed(1)}ms ` +
      `[node=${cold.nodeP50Ms.toFixed(1)}, bolo=${cold.boloP50Ms.toFixed(1)}]; ` +
      `cpu=${worker.cpuMs.toFixed(1)}ms, ` +
      `heap=${worker.renderHeapDeltaMb.toFixed(1)}MB, ` +
      `cleanup=${worker.cleanupRetainedDeltaMb.toFixed(1)}MB)`,
  )
}

if (process.env[workerEnv] === '1') {
  runBudgetWorker().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
