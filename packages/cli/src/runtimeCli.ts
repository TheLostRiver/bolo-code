/**
 * AR1A：非交互 runtime snapshot query。
 *
 * 这里只恢复既有会话并读取 core 的纯数据 snapshot，不提交 prompt、
 * 不调用 provider，也不经过会打印 banner/summary 的 runResumeCli。
 */

import {
  buildRuntimeSnapshot,
  endSession,
  queryRuntimeSnapshot,
  type RuntimeListItem,
  type RuntimeListView,
  type RuntimeQuery,
  type RuntimeQueryView,
} from '../../core/src/index.ts'
import { resumeFromIdOrPath } from './resumeCli.ts'

export type RuntimeQueryCliOptions = {
  idOrPath: string
  query: RuntimeQuery
  cwd?: string
  json?: boolean
  /** 测试专用：避免依赖本机 provider 配置。 */
  forceMock?: boolean
  writeOut?: (text: string) => void
  writeErr?: (text: string) => void
}

export type RuntimeQueryCliResult = {
  exitCode: 0 | 1
}

type RuntimeQueryCliError = {
  ok: false
  code: 'load_failed' | 'invalid_query' | 'not_found'
  detail: string
}

function formatRunner(view: RuntimeListView): string {
  return view.runner.state === 'running'
    ? `runner: running · turn=${view.runner.active.turnId}`
    : 'runner: idle'
}

function formatListItem(item: RuntimeListItem): string {
  if (item.entity === 'turn') {
    return `  turn ${item.entityId} · ${item.record.state}`
  }
  if (item.entity === 'control') {
    return `  control ${item.entityId} · ${item.record.kind}/${item.record.state}`
  }
  return `  task ${item.entityId} · ${item.record.agentType}/${item.record.state}`
}

export function formatRuntimeQueryView(view: RuntimeQueryView): string {
  if (view.kind === 'runtime.inspect') {
    return [
      `Runtime protocol v${view.protocolVersion}`,
      `session: ${view.sessionId}`,
      `${view.entity}: ${view.item.entityId}`,
      JSON.stringify(view.item.record, null, 2),
    ].join('\n')
  }

  return [
    `Runtime protocol v${view.protocolVersion}`,
    `session: ${view.sessionId} · phase=${view.phase}`,
    formatRunner(view),
    `${view.entity} entities (${view.items.length}):`,
    ...view.items.map(formatListItem),
  ].join('\n')
}

function writeFailure(
  failure: RuntimeQueryCliError,
  options: {
    json: boolean
    writeOut: (text: string) => void
    writeErr: (text: string) => void
  },
): void {
  if (options.json) {
    options.writeOut(`${JSON.stringify(failure)}\n`)
    return
  }
  options.writeErr(`error [${failure.code}]: ${failure.detail}\n`)
}

export async function runRuntimeQueryCli(
  options: RuntimeQueryCliOptions,
): Promise<RuntimeQueryCliResult> {
  const writeOut =
    options.writeOut ?? ((text: string) => process.stdout.write(text))
  const writeErr =
    options.writeErr ?? ((text: string) => process.stderr.write(text))
  const json = options.json === true
  let resumed:
    | Awaited<ReturnType<typeof resumeFromIdOrPath>>
    | undefined

  try {
    resumed = await resumeFromIdOrPath({
      idOrPath: options.idOrPath,
      cwd: options.cwd,
      forceMock: options.forceMock,
      reassembleSystem: false,
      systemPrompt: false,
      isTty: false,
      // resume 事件、缺 key warning 与 SessionEnd hook 错误都不能污染
      // runtime query 的单 payload stdout。
      writeOut: () => undefined,
      writeErr: () => undefined,
    })
  } catch (error) {
    const failure: RuntimeQueryCliError = {
      ok: false,
      code: 'load_failed',
      detail: error instanceof Error ? error.message : String(error),
    }
    writeFailure(failure, { json, writeOut, writeErr })
    return { exitCode: 1 }
  }

  try {
    const result = queryRuntimeSnapshot(
      buildRuntimeSnapshot(resumed.session),
      options.query,
    )
    if (!result.ok) {
      writeFailure(result, { json, writeOut, writeErr })
      return { exitCode: 1 }
    }

    writeOut(
      json
        ? `${JSON.stringify(result.view)}\n`
        : `${formatRuntimeQueryView(result.view)}\n`,
    )
    return { exitCode: 0 }
  } finally {
    await endSession(resumed.session, { reason: 'other' })
  }
}
