/**
 * Tool 契约 — 对照 HelsincyCode Tool.ts / buildTool
 * 默认 fail-closed：非并发安全、非只读；无遥测
 */

export type JsonSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolResult = {
  ok: boolean
  /** 回灌模型的文本 */
  output: string
  /** 对照 HC is_error */
  isError?: boolean
  /** 可选机器可读错误码 */
  errorCode?: string
}

export type ToolContext = {
  cwd: string
  sessionId?: string
  signal?: AbortSignal
  /** Skill 工具等扩展上下文 */
  extras?: Record<string, unknown>
}

export type ToolCallResult = ToolResult

export type BoloTool = {
  name: string
  description: string
  /** OpenAI / Anthropic 共用的 JSON Schema */
  inputJSONSchema: JsonSchema
  /**
   * 是否默认需要权限门控（再叠加 PermissionMode）。
   * 对照 HC：真正权限在 checkPermissions + 全局系统；这里保留布尔以便 gate 分类。
   */
  requiresPermission: boolean
  /** 对照 HC isConcurrencySafe — 默认真 fail-closed false */
  isConcurrencySafe: (input: unknown) => boolean
  /** 对照 HC isReadOnly */
  isReadOnly: (input: unknown) => boolean
  isEnabled: () => boolean
  /**
   * 工具级权限钩子（对照 checkPermissions）。
   * 默认 allow， defer 给全局 PermissionGate。
   */
  checkPermissions: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<{ behavior: 'allow' | 'deny' | 'ask'; reason?: string }>
  /** 业务校验（zod 等价物；在 schema 通过后调用） */
  validateInput?: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<{ ok: true } | { ok: false; message: string; errorCode?: string }>
  call: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolCallResult>
}

type Defaultable =
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isEnabled'
  | 'checkPermissions'
  | 'requiresPermission'

export type ToolDef = Omit<BoloTool, Defaultable> & Partial<Pick<BoloTool, Defaultable>>

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  requiresPermission: true,
  checkPermissions: async (
    input: Record<string, unknown>,
    _ctx?: ToolContext,
  ) => ({ behavior: 'allow' as const, updatedInput: input }),
}

/**
 * 对照 buildTool：填充安全默认值
 */
export function buildTool(def: ToolDef): BoloTool {
  return {
    ...TOOL_DEFAULTS,
    requiresPermission: def.requiresPermission ?? true,
    isConcurrencySafe: def.isConcurrencySafe ?? TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: def.isReadOnly ?? TOOL_DEFAULTS.isReadOnly,
    isEnabled: def.isEnabled ?? TOOL_DEFAULTS.isEnabled,
    checkPermissions:
      def.checkPermissions ??
      (async (input) => ({ behavior: 'allow' as const })),
    ...def,
  } as BoloTool
}

/**
 * 轻量 required 字段校验（对齐 HC zod safeParse 的最小替代，无 zod 依赖）
 */
export function validateAgainstJsonSchema(
  schema: JsonSchema,
  raw: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: 'input must be a JSON object' }
  }
  const data = raw as Record<string, unknown>
  const required = schema.required ?? []
  const missing = required.filter(
    (k) => data[k] === undefined || data[k] === null || data[k] === '',
  )
  if (missing.length) {
    return {
      success: false,
      error: `InputValidationError: missing required field(s): ${missing.join(', ')}`,
    }
  }
  return { success: true, data }
}

export function formatToolUseError(message: string): string {
  return `<tool_use_error>${message}</tool_use_error>`
}

export function findToolByName(
  tools: readonly BoloTool[],
  name: string,
): BoloTool | undefined {
  return tools.find((t) => t.name === name && t.isEnabled())
}