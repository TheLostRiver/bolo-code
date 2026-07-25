/**
 * DR4A transport-neutral runtime protocol.
 *
 * The protocol is pure JSON data. Additive object fields are ignored by
 * parsers for forward compatibility; unknown versions, discriminants,
 * lifecycle states, and actions fail closed.
 */

export const RUNTIME_PROTOCOL_VERSION = 1 as const
export const RUNTIME_PROTOCOL_SUPPORTED_VERSIONS = [
  RUNTIME_PROTOCOL_VERSION,
] as const

export const RUNTIME_PROTOCOL_FEATURES = [
  'views.session',
  'views.turns',
  'views.controls',
  'views.tasks',
  'commands.inspect',
  'commands.interrupt',
  'commands.cancel',
] as const

export type RuntimeProtocolVersion = typeof RUNTIME_PROTOCOL_VERSION
export type RuntimeProtocolFeature =
  (typeof RUNTIME_PROTOCOL_FEATURES)[number]

export const RUNTIME_SESSION_PHASES = [
  'idle',
  'starting',
  'ready',
  'running',
  'awaiting_permission',
  'compacting',
  'stopping',
  'ended',
] as const
export type RuntimeSessionPhase = (typeof RUNTIME_SESSION_PHASES)[number]

export const RUNTIME_TURN_STATES = [
  'admitted',
  'running',
  'completed',
  'error',
  'aborted',
  'interrupted',
] as const
export type RuntimeTurnState = (typeof RUNTIME_TURN_STATES)[number]

export const RUNTIME_CONTROL_KINDS = [
  'queue',
  'steer',
  'interrupt',
] as const
export type RuntimeControlKind = (typeof RUNTIME_CONTROL_KINDS)[number]

export const RUNTIME_CONTROL_STATES = [
  'pending',
  'ready',
  'promoted',
  'cancelled',
  'interrupted',
] as const
export type RuntimeControlState = (typeof RUNTIME_CONTROL_STATES)[number]

export const RUNTIME_CONTROL_BOUNDARIES = [
  'before_provider',
  'after_provider',
  'before_tools',
  'after_tools',
  'after_permission',
  'after_diff_approval',
  'after_compact',
  'before_stop',
  'turn_terminal',
  'between_turns',
  'interrupt_signal',
] as const
export type RuntimeControlBoundary =
  (typeof RUNTIME_CONTROL_BOUNDARIES)[number]

export const RUNTIME_TASK_STATES = [
  'queued',
  'admitted',
  'running',
  'completed',
  'error',
  'aborted',
  'interrupted',
] as const
export type RuntimeTaskState = (typeof RUNTIME_TASK_STATES)[number]

export const RUNTIME_TASK_ISOLATIONS = ['none', 'worktree'] as const
export type RuntimeTaskIsolation =
  (typeof RUNTIME_TASK_ISOLATIONS)[number]

export type RuntimeRunnerOwnerView = {
  sessionId: string
  turnId: string
  acquiredAt: string
  querySource?: string
}

export type RuntimeRunnerView =
  | { state: 'idle' }
  | { state: 'running'; active: RuntimeRunnerOwnerView }

export type RuntimeTurnView = {
  turnId: string
  state: RuntimeTurnState
  prompt?: string
  querySource?: string
  admittedAt?: string
  updatedAt: string
  terminalReason?: string
  detail?: string
  recovered?: boolean
}

export type RuntimeControlView = {
  controlId: string
  sessionId: string
  kind: RuntimeControlKind
  state: RuntimeControlState
  requestedAt: string
  updatedAt: string
  expectedTurnId?: string
  turnId?: string
  prompt?: string
  querySource?: string
  boundary?: RuntimeControlBoundary
  detail?: string
  recovered?: boolean
  interruptedFrom?: 'pending' | 'ready'
  recoveryReason?: 'process_restart'
}

export type RuntimeUsageView = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  estimated?: boolean
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export type RuntimeTaskResultView = {
  summary: string
  isError: boolean
  writtenAt: string
  agentTranscriptPath?: string
  usage?: RuntimeUsageView
  totalDurationMs?: number
  totalToolUseCount?: number
  worktreePath?: string
  detail?: string
}

export type RuntimeTaskView = {
  taskId: string
  sessionId: string
  agentType: string
  state: RuntimeTaskState
  admittedAt: string
  updatedAt: string
  parentTurnId?: string
  prompt?: string
  description?: string
  isolation?: RuntimeTaskIsolation
  detail?: string
  result?: RuntimeTaskResultView
  recovered?: boolean
  interruptedFrom?: 'admitted' | 'running'
  recoveryReason?: 'process_restart'
}

export type RuntimeSessionView = {
  sessionId: string
  cwd: string
  phase: RuntimeSessionPhase
  runner: RuntimeRunnerView
  turns: RuntimeTurnView[]
  controls: RuntimeControlView[]
  tasks: RuntimeTaskView[]
}

export type RuntimeSnapshot = {
  protocolVersion: RuntimeProtocolVersion
  kind: 'runtime.snapshot'
  generatedAt: string
  /** Feature ids are open strings so newer peers can advertise additions. */
  features: string[]
  session: RuntimeSessionView
}

export type RuntimeProtocolHello = {
  protocolVersion: RuntimeProtocolVersion
  kind: 'runtime.hello'
  supportedVersions: RuntimeProtocolVersion[]
  features: RuntimeProtocolFeature[]
}

export type RuntimeProtocolNegotiationRequest = {
  supportedVersions: readonly number[]
  requestedFeatures?: readonly string[]
  requiredFeatures?: readonly string[]
}

export type RuntimeProtocolNegotiationResult =
  | {
      ok: true
      protocolVersion: RuntimeProtocolVersion
      features: RuntimeProtocolFeature[]
    }
  | {
      ok: false
      code: 'unsupported_version' | 'unsupported_features'
      detail: string
      unsupportedFeatures?: string[]
    }

export const RUNTIME_COMMAND_ACTIONS = [
  'runtime.inspect',
  'turn.interrupt',
  'control.cancel',
  'task.cancel',
] as const
export type RuntimeCommandAction = (typeof RUNTIME_COMMAND_ACTIONS)[number]

type RuntimeCommandBase = {
  protocolVersion: RuntimeProtocolVersion
  kind: 'runtime.command'
  requestId: string
}

export type RuntimeInspectCommand = RuntimeCommandBase & {
  action: 'runtime.inspect'
  target: { sessionId: string }
}

export type RuntimeTurnInterruptCommand = RuntimeCommandBase & {
  action: 'turn.interrupt'
  target: {
    sessionId: string
    turnId: string
    expectedState: 'running'
  }
}

export type RuntimeControlCancelCommand = RuntimeCommandBase & {
  action: 'control.cancel'
  target: {
    sessionId: string
    controlId: string
    expectedState: 'pending' | 'ready'
  }
}

export type RuntimeTaskCancelCommand = RuntimeCommandBase & {
  action: 'task.cancel'
  target: {
    sessionId: string
    taskId: string
    expectedState: 'queued'
  }
}

export type RuntimeCommand =
  | RuntimeInspectCommand
  | RuntimeTurnInterruptCommand
  | RuntimeControlCancelCommand
  | RuntimeTaskCancelCommand

export const RUNTIME_COMMAND_ERROR_CODES = [
  'invalid_command',
  'not_found',
  'state_conflict',
  'not_cancellable',
  'persistence_failed',
  'internal_error',
] as const
export type RuntimeCommandErrorCode =
  (typeof RUNTIME_COMMAND_ERROR_CODES)[number]

type RuntimeCommandResultBase = {
  protocolVersion: RuntimeProtocolVersion
  kind: 'runtime.result'
  requestId: string
  action: RuntimeCommandAction
}

export type RuntimeCommandResult =
  | (RuntimeCommandResultBase & {
      ok: true
      snapshot?: RuntimeSnapshot
      warnings?: string[]
    })
  | (RuntimeCommandResultBase & {
      ok: false
      code: RuntimeCommandErrorCode
      detail: string
    })

export type RuntimeProtocolParseErrorCode =
  | 'invalid_envelope'
  | 'unsupported_version'
  | 'unsupported_action'
  | 'invalid_transition'
  | 'invalid_snapshot'
  | 'invalid_result'

export type RuntimeProtocolParseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      code: RuntimeProtocolParseErrorCode
      detail: string
    }

const featureSet = new Set<string>(RUNTIME_PROTOCOL_FEATURES)
const actionSet = new Set<string>(RUNTIME_COMMAND_ACTIONS)

export function createRuntimeProtocolHello(): RuntimeProtocolHello {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.hello',
    supportedVersions: [...RUNTIME_PROTOCOL_SUPPORTED_VERSIONS],
    features: [...RUNTIME_PROTOCOL_FEATURES],
  }
}

export function negotiateRuntimeProtocol(
  request: RuntimeProtocolNegotiationRequest,
): RuntimeProtocolNegotiationResult {
  if (!request.supportedVersions.includes(RUNTIME_PROTOCOL_VERSION)) {
    return {
      ok: false,
      code: 'unsupported_version',
      detail:
        `no common runtime protocol version; supported=` +
        RUNTIME_PROTOCOL_SUPPORTED_VERSIONS.join(','),
    }
  }
  const unsupportedFeatures = (request.requiredFeatures ?? []).filter(
    (feature) => !featureSet.has(feature),
  )
  if (unsupportedFeatures.length > 0) {
    return {
      ok: false,
      code: 'unsupported_features',
      detail: `unsupported required runtime features: ${unsupportedFeatures.join(', ')}`,
      unsupportedFeatures,
    }
  }
  const requested = request.requestedFeatures
  const features = requested
    ? requested.filter(
        (feature): feature is RuntimeProtocolFeature =>
          featureSet.has(feature),
      )
    : [...RUNTIME_PROTOCOL_FEATURES]
  return {
    ok: true,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    features: [...new Set(features)],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  return value
}

function requiredString(
  value: unknown,
  path: string,
  maxLength = 256,
): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  const text = value.trim()
  if (!text) throw new Error(`${path} is empty`)
  if (text.length > maxLength) throw new Error(`${path} is too long`)
  if (/[\r\n\0]/.test(text) && maxLength <= 256) {
    throw new Error(`${path} contains invalid control characters`)
  }
  return text
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  if (value.includes('\0')) throw new Error(`${path} contains a null character`)
  return value
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  if (record[key] === undefined) return undefined
  return requiredText(record[key], `${path}.${key}`)
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`${path}.${key} must be a boolean`)
  }
  return value
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`${path} must be a non-negative finite number`)
  }
  return value
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  if (record[key] === undefined) return undefined
  return nonNegativeNumber(record[key], `${path}.${key}`)
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new Error(`${path} has an unsupported value: ${String(value)}`)
  }
  return value as T
}

function parseFeatures(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value.map((feature, index) =>
    requiredString(feature, `${path}[${index}]`, 512),
  )
}

function parseUsage(value: unknown, path: string): RuntimeUsageView {
  const record = requiredRecord(value, path)
  return {
    inputTokens: nonNegativeNumber(record.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeNumber(
      record.outputTokens,
      `${path}.outputTokens`,
    ),
    totalTokens: nonNegativeNumber(record.totalTokens, `${path}.totalTokens`),
    calls: nonNegativeNumber(record.calls, `${path}.calls`),
    ...(optionalBoolean(record, 'estimated', path) !== undefined
      ? { estimated: optionalBoolean(record, 'estimated', path) }
      : {}),
    ...(optionalNumber(record, 'cacheReadInputTokens', path) !== undefined
      ? {
          cacheReadInputTokens: optionalNumber(
            record,
            'cacheReadInputTokens',
            path,
          ),
        }
      : {}),
    ...(optionalNumber(record, 'cacheCreationInputTokens', path) !== undefined
      ? {
          cacheCreationInputTokens: optionalNumber(
            record,
            'cacheCreationInputTokens',
            path,
          ),
        }
      : {}),
  }
}

function parseRunner(value: unknown, path: string): RuntimeRunnerView {
  const record = requiredRecord(value, path)
  const state = oneOf(record.state, ['idle', 'running'] as const, `${path}.state`)
  if (state === 'idle') return { state }
  const active = requiredRecord(record.active, `${path}.active`)
  return {
    state,
    active: {
      sessionId: requiredString(
        active.sessionId,
        `${path}.active.sessionId`,
      ),
      turnId: requiredString(active.turnId, `${path}.active.turnId`),
      acquiredAt: requiredString(
        active.acquiredAt,
        `${path}.active.acquiredAt`,
        512,
      ),
      ...(optionalText(active, 'querySource', `${path}.active`) !== undefined
        ? {
            querySource: optionalText(
              active,
              'querySource',
              `${path}.active`,
            ),
          }
        : {}),
    },
  }
}

function parseTurn(value: unknown, path: string): RuntimeTurnView {
  const record = requiredRecord(value, path)
  return {
    turnId: requiredString(record.turnId, `${path}.turnId`),
    state: oneOf(record.state, RUNTIME_TURN_STATES, `${path}.state`),
    ...(optionalText(record, 'prompt', path) !== undefined
      ? { prompt: optionalText(record, 'prompt', path) }
      : {}),
    ...(optionalText(record, 'querySource', path) !== undefined
      ? { querySource: optionalText(record, 'querySource', path) }
      : {}),
    ...(optionalText(record, 'admittedAt', path) !== undefined
      ? { admittedAt: optionalText(record, 'admittedAt', path) }
      : {}),
    updatedAt: requiredString(record.updatedAt, `${path}.updatedAt`, 512),
    ...(optionalText(record, 'terminalReason', path) !== undefined
      ? { terminalReason: optionalText(record, 'terminalReason', path) }
      : {}),
    ...(optionalText(record, 'detail', path) !== undefined
      ? { detail: optionalText(record, 'detail', path) }
      : {}),
    ...(optionalBoolean(record, 'recovered', path) !== undefined
      ? { recovered: optionalBoolean(record, 'recovered', path) }
      : {}),
  }
}

function parseControl(value: unknown, path: string): RuntimeControlView {
  const record = requiredRecord(value, path)
  const interruptedFrom =
    record.interruptedFrom === undefined
      ? undefined
      : oneOf(
          record.interruptedFrom,
          ['pending', 'ready'] as const,
          `${path}.interruptedFrom`,
        )
  const recoveryReason =
    record.recoveryReason === undefined
      ? undefined
      : oneOf(
          record.recoveryReason,
          ['process_restart'] as const,
          `${path}.recoveryReason`,
        )
  return {
    controlId: requiredString(record.controlId, `${path}.controlId`),
    sessionId: requiredString(record.sessionId, `${path}.sessionId`),
    kind: oneOf(record.kind, RUNTIME_CONTROL_KINDS, `${path}.kind`),
    state: oneOf(record.state, RUNTIME_CONTROL_STATES, `${path}.state`),
    requestedAt: requiredString(
      record.requestedAt,
      `${path}.requestedAt`,
      512,
    ),
    updatedAt: requiredString(record.updatedAt, `${path}.updatedAt`, 512),
    ...(optionalText(record, 'expectedTurnId', path) !== undefined
      ? { expectedTurnId: optionalText(record, 'expectedTurnId', path) }
      : {}),
    ...(optionalText(record, 'turnId', path) !== undefined
      ? { turnId: optionalText(record, 'turnId', path) }
      : {}),
    ...(optionalText(record, 'prompt', path) !== undefined
      ? { prompt: optionalText(record, 'prompt', path) }
      : {}),
    ...(optionalText(record, 'querySource', path) !== undefined
      ? { querySource: optionalText(record, 'querySource', path) }
      : {}),
    ...(record.boundary !== undefined
      ? {
          boundary: oneOf(
            record.boundary,
            RUNTIME_CONTROL_BOUNDARIES,
            `${path}.boundary`,
          ),
        }
      : {}),
    ...(optionalText(record, 'detail', path) !== undefined
      ? { detail: optionalText(record, 'detail', path) }
      : {}),
    ...(optionalBoolean(record, 'recovered', path) !== undefined
      ? { recovered: optionalBoolean(record, 'recovered', path) }
      : {}),
    ...(interruptedFrom ? { interruptedFrom } : {}),
    ...(recoveryReason ? { recoveryReason } : {}),
  }
}

function parseTaskResult(
  value: unknown,
  path: string,
): RuntimeTaskResultView {
  const record = requiredRecord(value, path)
  if (typeof record.isError !== 'boolean') {
    throw new Error(`${path}.isError must be a boolean`)
  }
  return {
    summary: requiredText(record.summary, `${path}.summary`),
    isError: record.isError,
    writtenAt: requiredString(record.writtenAt, `${path}.writtenAt`, 512),
    ...(optionalText(record, 'agentTranscriptPath', path) !== undefined
      ? {
          agentTranscriptPath: optionalText(
            record,
            'agentTranscriptPath',
            path,
          ),
        }
      : {}),
    ...(record.usage !== undefined
      ? { usage: parseUsage(record.usage, `${path}.usage`) }
      : {}),
    ...(optionalNumber(record, 'totalDurationMs', path) !== undefined
      ? {
          totalDurationMs: optionalNumber(
            record,
            'totalDurationMs',
            path,
          ),
        }
      : {}),
    ...(optionalNumber(record, 'totalToolUseCount', path) !== undefined
      ? {
          totalToolUseCount: optionalNumber(
            record,
            'totalToolUseCount',
            path,
          ),
        }
      : {}),
    ...(optionalText(record, 'worktreePath', path) !== undefined
      ? { worktreePath: optionalText(record, 'worktreePath', path) }
      : {}),
    ...(optionalText(record, 'detail', path) !== undefined
      ? { detail: optionalText(record, 'detail', path) }
      : {}),
  }
}

function parseTask(value: unknown, path: string): RuntimeTaskView {
  const record = requiredRecord(value, path)
  const interruptedFrom =
    record.interruptedFrom === undefined
      ? undefined
      : oneOf(
          record.interruptedFrom,
          ['admitted', 'running'] as const,
          `${path}.interruptedFrom`,
        )
  const recoveryReason =
    record.recoveryReason === undefined
      ? undefined
      : oneOf(
          record.recoveryReason,
          ['process_restart'] as const,
          `${path}.recoveryReason`,
        )
  return {
    taskId: requiredString(record.taskId, `${path}.taskId`),
    sessionId: requiredString(record.sessionId, `${path}.sessionId`),
    agentType: requiredString(record.agentType, `${path}.agentType`),
    state: oneOf(record.state, RUNTIME_TASK_STATES, `${path}.state`),
    admittedAt: requiredString(record.admittedAt, `${path}.admittedAt`, 512),
    updatedAt: requiredString(record.updatedAt, `${path}.updatedAt`, 512),
    ...(optionalText(record, 'parentTurnId', path) !== undefined
      ? { parentTurnId: optionalText(record, 'parentTurnId', path) }
      : {}),
    ...(optionalText(record, 'prompt', path) !== undefined
      ? { prompt: optionalText(record, 'prompt', path) }
      : {}),
    ...(optionalText(record, 'description', path) !== undefined
      ? { description: optionalText(record, 'description', path) }
      : {}),
    ...(record.isolation !== undefined
      ? {
          isolation: oneOf(
            record.isolation,
            RUNTIME_TASK_ISOLATIONS,
            `${path}.isolation`,
          ),
        }
      : {}),
    ...(optionalText(record, 'detail', path) !== undefined
      ? { detail: optionalText(record, 'detail', path) }
      : {}),
    ...(record.result !== undefined
      ? { result: parseTaskResult(record.result, `${path}.result`) }
      : {}),
    ...(optionalBoolean(record, 'recovered', path) !== undefined
      ? { recovered: optionalBoolean(record, 'recovered', path) }
      : {}),
    ...(interruptedFrom ? { interruptedFrom } : {}),
    ...(recoveryReason ? { recoveryReason } : {}),
  }
}

function assertUniqueIds<T>(
  values: readonly T[],
  idOf: (value: T) => string,
  path: string,
): void {
  const seen = new Set<string>()
  for (const value of values) {
    const id = idOf(value)
    if (seen.has(id)) throw new Error(`${path} contains duplicate id "${id}"`)
    seen.add(id)
  }
}

function parseSnapshotOrThrow(input: unknown): RuntimeSnapshot {
  const record = requiredRecord(input, 'snapshot')
  if (record.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported runtime protocol version: ${String(record.protocolVersion)}`,
    )
  }
  if (record.kind !== 'runtime.snapshot') {
    throw new Error('snapshot.kind must be "runtime.snapshot"')
  }
  const session = requiredRecord(record.session, 'snapshot.session')
  if (!Array.isArray(session.turns)) {
    throw new Error('snapshot.session.turns must be an array')
  }
  if (!Array.isArray(session.controls)) {
    throw new Error('snapshot.session.controls must be an array')
  }
  if (!Array.isArray(session.tasks)) {
    throw new Error('snapshot.session.tasks must be an array')
  }
  const sessionId = requiredString(
    session.sessionId,
    'snapshot.session.sessionId',
  )
  const runner = parseRunner(session.runner, 'snapshot.session.runner')
  const turns = session.turns.map((turn, index) =>
    parseTurn(turn, `snapshot.session.turns[${index}]`),
  )
  const controls = session.controls.map((control, index) =>
    parseControl(control, `snapshot.session.controls[${index}]`),
  )
  const tasks = session.tasks.map((task, index) =>
    parseTask(task, `snapshot.session.tasks[${index}]`),
  )
  if (runner.state === 'running' && runner.active.sessionId !== sessionId) {
    throw new Error('snapshot runner belongs to another session')
  }
  if (controls.some((control) => control.sessionId !== sessionId)) {
    throw new Error('snapshot contains a control from another session')
  }
  if (tasks.some((task) => task.sessionId !== sessionId)) {
    throw new Error('snapshot contains a task from another session')
  }
  assertUniqueIds(turns, (turn) => turn.turnId, 'snapshot.session.turns')
  assertUniqueIds(
    controls,
    (control) => control.controlId,
    'snapshot.session.controls',
  )
  assertUniqueIds(tasks, (task) => task.taskId, 'snapshot.session.tasks')
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'runtime.snapshot',
    generatedAt: requiredString(
      record.generatedAt,
      'snapshot.generatedAt',
      512,
    ),
    features: parseFeatures(record.features, 'snapshot.features'),
    session: {
      sessionId,
      cwd: requiredText(session.cwd, 'snapshot.session.cwd'),
      phase: oneOf(
        session.phase,
        RUNTIME_SESSION_PHASES,
        'snapshot.session.phase',
      ),
      runner,
      turns,
      controls,
      tasks,
    },
  }
}

export function parseRuntimeSnapshot(
  input: unknown,
): RuntimeProtocolParseResult<RuntimeSnapshot> {
  if (
    isRecord(input) &&
    input.protocolVersion !== RUNTIME_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      code: 'unsupported_version',
      detail: `unsupported runtime protocol version: ${String(input.protocolVersion)}`,
    }
  }
  try {
    return { ok: true, value: parseSnapshotOrThrow(input) }
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_snapshot',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function parseCommandBase(input: unknown): {
  record: Record<string, unknown>
  requestId: string
  action: RuntimeCommandAction
  target: Record<string, unknown>
} {
  const record = requiredRecord(input, 'command')
  if (record.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported runtime protocol version: ${String(record.protocolVersion)}`,
    )
  }
  if (record.kind !== 'runtime.command') {
    throw new Error('command.kind must be "runtime.command"')
  }
  const action = oneOf(
    record.action,
    RUNTIME_COMMAND_ACTIONS,
    'command.action',
  )
  return {
    record,
    requestId: requiredString(record.requestId, 'command.requestId'),
    action,
    target: requiredRecord(record.target, 'command.target'),
  }
}

export function parseRuntimeCommand(
  input: unknown,
): RuntimeProtocolParseResult<RuntimeCommand> {
  if (
    isRecord(input) &&
    input.protocolVersion !== RUNTIME_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      code: 'unsupported_version',
      detail: `unsupported runtime protocol version: ${String(input.protocolVersion)}`,
    }
  }
  if (
    isRecord(input) &&
    typeof input.action === 'string' &&
    !actionSet.has(input.action)
  ) {
    return {
      ok: false,
      code: 'unsupported_action',
      detail: `unsupported runtime action: ${input.action}`,
    }
  }
  try {
    const { requestId, action, target } = parseCommandBase(input)
    const sessionId = requiredString(
      target.sessionId,
      'command.target.sessionId',
    )
    const base = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.command' as const,
      requestId,
    }
    if (action === 'runtime.inspect') {
      return {
        ok: true,
        value: { ...base, action, target: { sessionId } },
      }
    }
    if (action === 'turn.interrupt') {
      if (target.expectedState !== 'running') {
        return {
          ok: false,
          code: 'invalid_transition',
          detail: 'turn.interrupt requires expectedState="running"',
        }
      }
      return {
        ok: true,
        value: {
          ...base,
          action,
          target: {
            sessionId,
            turnId: requiredString(
              target.turnId,
              'command.target.turnId',
            ),
            expectedState: 'running',
          },
        },
      }
    }
    if (action === 'control.cancel') {
      if (target.expectedState !== 'pending' && target.expectedState !== 'ready') {
        return {
          ok: false,
          code: 'invalid_transition',
          detail:
            'control.cancel requires expectedState="pending" or "ready"',
        }
      }
      return {
        ok: true,
        value: {
          ...base,
          action,
          target: {
            sessionId,
            controlId: requiredString(
              target.controlId,
              'command.target.controlId',
            ),
            expectedState: target.expectedState,
          },
        },
      }
    }
    if (target.expectedState !== 'queued') {
      return {
        ok: false,
        code: 'invalid_transition',
        detail: 'task.cancel requires expectedState="queued"',
      }
    }
    return {
      ok: true,
      value: {
        ...base,
        action,
        target: {
          sessionId,
          taskId: requiredString(target.taskId, 'command.target.taskId'),
          expectedState: 'queued',
        },
      },
    }
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_envelope',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export function parseRuntimeCommandResult(
  input: unknown,
): RuntimeProtocolParseResult<RuntimeCommandResult> {
  if (
    isRecord(input) &&
    input.protocolVersion !== RUNTIME_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      code: 'unsupported_version',
      detail: `unsupported runtime protocol version: ${String(input.protocolVersion)}`,
    }
  }
  if (
    isRecord(input) &&
    typeof input.action === 'string' &&
    !actionSet.has(input.action)
  ) {
    return {
      ok: false,
      code: 'unsupported_action',
      detail: `unsupported runtime action: ${input.action}`,
    }
  }
  try {
    const record = requiredRecord(input, 'result')
    if (record.kind !== 'runtime.result') {
      throw new Error('result.kind must be "runtime.result"')
    }
    const requestId = requiredString(record.requestId, 'result.requestId')
    const action = oneOf(
      record.action,
      RUNTIME_COMMAND_ACTIONS,
      'result.action',
    )
    if (typeof record.ok !== 'boolean') {
      throw new Error('result.ok must be a boolean')
    }
    const base = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'runtime.result' as const,
      requestId,
      action,
    }
    if (record.ok) {
      let snapshot: RuntimeSnapshot | undefined
      let warnings: string[] | undefined
      if (record.snapshot !== undefined) {
        const parsed = parseRuntimeSnapshot(record.snapshot)
        if (!parsed.ok) throw new Error(parsed.detail)
        snapshot = parsed.value
      }
      if (record.warnings !== undefined) {
        if (!Array.isArray(record.warnings)) {
          throw new Error('result.warnings must be an array')
        }
        warnings = record.warnings.map((warning, index) =>
          requiredString(
            warning,
            `result.warnings[${index}]`,
            10_000,
          ),
        )
      }
      return {
        ok: true,
        value: {
          ...base,
          ok: true,
          ...(snapshot ? { snapshot } : {}),
          ...(warnings?.length ? { warnings } : {}),
        },
      }
    }
    const code = oneOf(
      record.code,
      RUNTIME_COMMAND_ERROR_CODES,
      'result.code',
    )
    return {
      ok: true,
      value: {
        ...base,
        ok: false,
        code,
        detail: requiredText(record.detail, 'result.detail'),
      },
    }
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_result',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
