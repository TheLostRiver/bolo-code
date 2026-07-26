/**
 * AR1A/AR1B3：非交互 runtime snapshot query / recovery command。
 *
 * 这里只恢复既有会话并读取 core 的纯数据 snapshot，不提交 prompt、
 * 不调用 provider，也不经过会打印 banner/summary 的 runResumeCli。
 */

import { createHash } from 'node:crypto'

import {
  buildRuntimeSnapshot,
  endSession,
  executeRuntimeCommand,
  queryRuntimeSnapshot,
  type RuntimeListItem,
  type RuntimeListView,
  type RuntimeQuery,
  type RuntimeQueryEntity,
  type RuntimeQueryView,
} from '../../core/src/index.ts'
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommandResult,
} from '../../shared/src/index.ts'
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

type RuntimeCliError = {
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
  const actions = item.availableActions.length
    ? item.availableActions.map((action) => action.action).join(',')
    : 'none'
  if (item.entity === 'turn') {
    return `  turn ${item.entityId} · ${item.record.state} · actions=${actions}`
  }
  if (item.entity === 'control') {
    return `  control ${item.entityId} · ${item.record.kind}/${item.record.state} · actions=${actions}`
  }
  return `  task ${item.entityId} · ${item.record.agentType}/${item.record.state} · actions=${actions}`
}

export function formatRuntimeQueryView(view: RuntimeQueryView): string {
  if (view.kind === 'runtime.inspect') {
    return [
      `Runtime protocol v${view.protocolVersion}`,
      `session: ${view.sessionId}`,
      `${view.entity}: ${view.item.entityId}`,
      JSON.stringify(view.item, null, 2),
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
  failure: RuntimeCliError,
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
    const failure: RuntimeCliError = {
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

export type RuntimeCommandCliAction = {
  action: 'runtime.discard' | 'runtime.retry-safe'
  entity: RuntimeQueryEntity
  entityId: string
}

export type RuntimeCommandCliOptions = {
  idOrPath: string
  action: RuntimeCommandCliAction
  requestId?: string
  cwd?: string
  json?: boolean
  /** 测试专用：避免依赖本机 provider 配置。 */
  forceMock?: boolean
  writeOut?: (text: string) => void
  writeErr?: (text: string) => void
}

export type RuntimeCommandCliResult = {
  exitCode: 0 | 1
}

export function deriveRuntimeCommandRequestId(input: {
  sessionId: string
  action: RuntimeCommandCliAction['action']
  entity: RuntimeQueryEntity
  entityId: string
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.sessionId,
        input.action,
        input.entity,
        input.entityId,
      ]),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32)
  return `runtime_cli_${digest}`
}

export function formatRuntimeCommandResult(
  result: RuntimeCommandResult,
): string {
  if (!result.ok) {
    return [
      `runtime command rejected [${result.code}]: ${result.detail}`,
      `requestId: ${result.requestId}`,
    ].join('\n')
  }
  const lines = [
    `runtime command accepted: ${result.action}`,
    `requestId: ${result.requestId}`,
  ]
  if (result.replacement) {
    lines.push(
      `replacement: control=${result.replacement.controlId} ` +
        `turn=${result.replacement.turnId} ` +
        `replaced=${result.replacement.replacedControlId}`,
    )
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`warning: ${warning}`)
  }
  return lines.join('\n')
}

const NON_INTERACTIVE_RETRY_WARNING =
  'this non-interactive retry-safe command admits durable queue state but ' +
  'does not execute it; after this process exits, resume exposes the ' +
  'replacement as interrupted diagnostic work'

function addCommandConsumerWarnings(
  result: RuntimeCommandResult,
): RuntimeCommandResult {
  if (!result.ok || result.action !== 'runtime.retry-safe') return result
  return {
    ...result,
    warnings: [
      ...(result.warnings ?? []),
      NON_INTERACTIVE_RETRY_WARNING,
    ],
  }
}

export async function runRuntimeCommandCli(
  options: RuntimeCommandCliOptions,
): Promise<RuntimeCommandCliResult> {
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
      writeOut: () => undefined,
      writeErr: () => undefined,
    })
  } catch (error) {
    const failure: RuntimeCliError = {
      ok: false,
      code: 'load_failed',
      detail: error instanceof Error ? error.message : String(error),
    }
    writeFailure(failure, { json, writeOut, writeErr })
    return { exitCode: 1 }
  }

  try {
    const requestId =
      options.requestId?.trim() ||
      deriveRuntimeCommandRequestId({
        sessionId: resumed.session.id,
        ...options.action,
      })
    const result = addCommandConsumerWarnings(
      await executeRuntimeCommand(resumed.session, {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'runtime.command',
        requestId,
        action: options.action.action,
        target: {
          sessionId: resumed.session.id,
          entity: options.action.entity,
          entityId: options.action.entityId,
          expectedState: 'interrupted',
        },
      }),
    )
    const text = json
      ? JSON.stringify(result)
      : formatRuntimeCommandResult(result)
    if (json || result.ok) {
      writeOut(`${text}\n`)
    } else {
      writeErr(`${text}\n`)
    }
    return { exitCode: result.ok ? 0 : 1 }
  } finally {
    await endSession(resumed.session, { reason: 'other' })
  }
}
