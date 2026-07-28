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
  renderRuntimeText,
  type RuntimeQuery,
  type RuntimeQueryEntity,
  type RuntimeQueryView,
} from '../../core/src/index.ts'
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCommandResult,
} from '../../shared/src/index.ts'
import { resumeFromIdOrPath } from './resumeCli.ts'
import {
  runRetainedRuntimePager,
  runRuntimePager,
  type RuntimePagerKey,
} from './tui/runtimePager.ts'
import type {
  BoloTerminalInput,
  BoloTerminalOutput,
} from './tui/boloTerminalAdapter.ts'
import { resolveTuiTheme } from './tui/theme.ts'
import { resolveCliTuiEngine } from './tui/tuiEngine.ts'

export type RuntimeQueryCliOptions = {
  idOrPath: string
  query: RuntimeQuery
  cwd?: string
  json?: boolean
  isTty?: boolean
  columns?: number
  rows?: number
  env?: NodeJS.ProcessEnv
  readKey?: () => Promise<RuntimePagerKey>
  /** 测试/宿主注入；真实 CLI 默认使用 process.stdin/stdout。 */
  terminalInput?: BoloTerminalInput
  terminalOutput?: BoloTerminalOutput
  signal?: AbortSignal
  /** 测试专用：避免依赖本机 provider 配置。 */
  forceMock?: boolean
  writeOut?: (text: string) => void
  writeErr?: (text: string) => void
}

export type RuntimeQueryCliResult = {
  exitCode: 0 | 1 | 130
}

export const RUNTIME_CLI_FAILURE_CODES = [
  'usage',
  'load_failed',
  'invalid_query',
  'not_found',
  'pager_failed',
] as const

export type RuntimeCliFailureCode =
  (typeof RUNTIME_CLI_FAILURE_CODES)[number]

export type RuntimeCliFailure = {
  ok: false
  code: RuntimeCliFailureCode
  detail: string
}

export function formatRuntimeQueryView(view: RuntimeQueryView): string {
  return renderRuntimeText(view, {
    columns: Number.MAX_SAFE_INTEGER,
    pageSize: Number.MAX_SAFE_INTEGER,
    color: false,
  }).text
}

/**
 * AR1C2 automation compatibility:
 * - success stays the raw runtime.list/runtime.inspect view;
 * - JSON.stringify preserves known field order and additive unknown fields.
 */
export function formatRuntimeQueryJson(
  view: RuntimeQueryView,
): string {
  return JSON.stringify(view)
}

export function formatRuntimeCliFailure(
  failure: RuntimeCliFailure,
): string {
  return JSON.stringify(failure)
}

function writeFailure(
  failure: RuntimeCliFailure,
  options: {
    json: boolean
    writeOut: (text: string) => void
    writeErr: (text: string) => void
  },
): void {
  if (options.json) {
    options.writeOut(`${formatRuntimeCliFailure(failure)}\n`)
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
    const failure: RuntimeCliFailure = {
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

    if (json) {
      writeOut(`${formatRuntimeQueryJson(result.view)}\n`)
      return { exitCode: 0 }
    }

    const isTty =
      options.isTty ??
      (process.stdin.isTTY === true &&
        process.stdout.isTTY === true)
    if (!isTty) {
      writeOut(`${formatRuntimeQueryView(result.view)}\n`)
      return { exitCode: 0 }
    }

    try {
      const env = options.env ?? process.env
      const color = resolveTuiTheme({ env }).ansi
      const pager =
        resolveCliTuiEngine({ dynamicTui: true, env }) === 'retained'
          ? await runRetainedRuntimePager({
              view: result.view,
              isTty: true,
              columns: options.columns,
              rows: options.rows,
              color,
              input: options.terminalInput,
              output: options.terminalOutput,
              writeOut,
              signal: options.signal,
            })
          : await runRuntimePager({
              view: result.view,
              isTty: true,
              columns: options.columns,
              rows: options.rows,
              color,
              readKey: options.readKey,
              writeOut,
              signal: options.signal,
            })
      if (!pager.ok) {
        // isTty=true 时不应命中；保留 fail-safe 一次性输出。
        writeOut(`${formatRuntimeQueryView(result.view)}\n`)
        return { exitCode: 0 }
      }
      return {
        exitCode: pager.reason === 'interrupt' ? 130 : 0,
      }
    } catch (error) {
      writeFailure(
        {
          ok: false,
          code: 'pager_failed',
          detail:
            error instanceof Error ? error.message : String(error),
        },
        { json: false, writeOut, writeErr },
      )
      return { exitCode: 1 }
    }
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
    const failure: RuntimeCliFailure = {
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
