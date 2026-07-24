/**
 * MCP host：连 stdio servers → listTools/listResources/listPrompts
 * → 注册 BoloTool（mcp__server__tool + 可选 ListMcpResources / ReadMcpResource / GetMcpPrompt）
 * → list_changed 通知热刷新（tools/resources/prompts 缓存 + 可选会话工具表同步）
 * 单 server 失败 warn，不阻断其它 server / 会话
 *
 * 对照 HC 语义（非复制）：capabilities 门控 · list_changed 再 list · meta 工具 · 无遥测
 */

import {
  buildTool,
  type BoloTool,
  type JsonSchema,
} from '../../tools/src/index.ts'
import {
  formatMcpCallOutput,
  formatMcpPromptResult,
  formatMcpResourceContents,
  MCP_PROMPTS_LIST_CHANGED,
  MCP_RESOURCES_LIST_CHANGED,
  MCP_TOOLS_LIST_CHANGED,
  McpStdioClient,
  type McpPromptDef,
  type McpResourceDef,
  type McpToolDef,
} from './stdioClient.ts'
import { mcpToolName, parseMcpToolName } from './names.ts'
import type { McpServerConfig, McpToolRegistration } from './types.ts'

/** list_changed 刷新面（对照 HC tools|prompts|resources list_changed） */
export type McpListChangedKind = 'tools' | 'resources' | 'prompts'

export type McpListChangedEvent = {
  server: string
  kind: McpListChangedKind
  tools: McpToolDef[]
  resources: McpResourceDef[]
  prompts: McpPromptDef[]
}

export type ConnectedMcpServer = {
  name: string
  client: McpStdioClient
  tools: McpToolDef[]
  resources: McpResourceDef[]
  prompts: McpPromptDef[]
  capabilities: {
    tools: boolean
    resources: boolean
    prompts: boolean
  }
}

export type ConnectMcpResult = {
  servers: ConnectedMcpServer[]
  tools: BoloTool[]
  registrations: McpToolRegistration[]
  /** 连接/list 失败信息（不抛） */
  warnings: string[]
}

export type ConnectMcpOptions = {
  servers: McpServerConfig[]
  cwd?: string
  timeoutMs?: number
  /**
   * 为 true 时：stdio 失败后用 config.tools 声明式注册（仍无真 call）。
   * 默认 false — 禁止 mock 冒充完成。
   */
  allowConfigToolFallback?: boolean
  /**
   * 为 false 时不注册 ListMcpResources / ReadMcpResource / GetMcpPrompt。
   * 默认：任一 server 支持 resources 或 prompts 时注册。
   */
  registerMetaTools?: boolean
  /**
   * 收到 notifications/tools|resources|prompts/list_changed 并成功 re-list 后回调。
   * 会话层用此同步 session.tools（mcp__*）；无遥测。
   */
  onListChanged?: (event: McpListChangedEvent) => void | Promise<void>
}

const META_TOOL_NAMES = new Set([
  'ListMcpResources',
  'ReadMcpResource',
  'GetMcpPrompt',
])

/** 是否为 MCP 远端工具或全局 meta 工具（热刷新时从会话工具表剔除再重建） */
export function isMcpManagedToolName(name: string): boolean {
  return META_TOOL_NAMES.has(name) || parseMcpToolName(name) != null
}

/**
 * 按当前 ConnectedMcpServer 缓存重建 mcp__* + meta 工具表。
 * 不关连接；供 list_changed 后写回 session.tools。
 */
export function rebuildMcpBoloTools(
  servers: ConnectedMcpServer[],
  options?: { registerMetaTools?: boolean },
): { tools: BoloTool[]; registrations: McpToolRegistration[] } {
  const tools: BoloTool[] = []
  const registrations: McpToolRegistration[] = []
  const seen = new Set<string>()

  for (const s of servers) {
    if (!s.client.isConnected) continue
    for (const t of s.tools) {
      const reg = registrationFromListed(s.name, t)
      if (seen.has(reg.name)) continue
      seen.add(reg.name)
      registrations.push(reg)
      tools.push(boloToolFromMcp(reg, s.client))
    }
  }

  const wantMeta =
    options?.registerMetaTools !== false &&
    servers.some((s) => s.capabilities.resources || s.capabilities.prompts)
  if (wantMeta) {
    for (const meta of createMcpMetaTools(servers)) {
      if (seen.has(meta.name)) continue
      seen.add(meta.name)
      tools.push(meta)
    }
  }

  return { tools, registrations }
}

/**
 * 把非 MCP 工具 + 当前 MCP 重建结果合并。
 * 保留内置 / Agent 等；替换全部 mcp 管理名。
 */
export function mergeSessionToolsWithMcp(
  existing: BoloTool[] | undefined,
  servers: ConnectedMcpServer[],
  options?: { registerMetaTools?: boolean },
): BoloTool[] {
  const base = (existing ?? []).filter((t) => !isMcpManagedToolName(t.name))
  const { tools: mcpTools } = rebuildMcpBoloTools(servers, options)
  return [...base, ...mcpTools]
}

/**
 * 对已连接 server 挂 list_changed 监听：再 list → 更新缓存 → onListChanged。
 * 对照 HC：capabilities.listChanged 时注册；Bolo 更宽：凡支持该面即监听（server 可发）。
 */
export function attachMcpListChangedHandlers(
  servers: ConnectedMcpServer[],
  onListChanged?: (event: McpListChangedEvent) => void | Promise<void>,
): () => void {
  const unsubs: Array<() => void> = []

  for (const conn of servers) {
    const client = conn.client

    const refreshTools = async () => {
      try {
        const listed = await client.listTools()
        conn.tools = listed
        conn.capabilities.tools = client.supportsTools || listed.length > 0
        await onListChanged?.({
          server: conn.name,
          kind: 'tools',
          tools: conn.tools,
          resources: conn.resources,
          prompts: conn.prompts,
        })
      } catch {
        /* re-list 失败保留旧缓存 */
      }
    }

    const refreshResources = async () => {
      if (!client.supportsResources) return
      try {
        conn.resources = await client.listResources()
        await onListChanged?.({
          server: conn.name,
          kind: 'resources',
          tools: conn.tools,
          resources: conn.resources,
          prompts: conn.prompts,
        })
      } catch {
        /* keep */
      }
    }

    const refreshPrompts = async () => {
      if (!client.supportsPrompts) return
      try {
        conn.prompts = await client.listPrompts()
        await onListChanged?.({
          server: conn.name,
          kind: 'prompts',
          tools: conn.tools,
          resources: conn.resources,
          prompts: conn.prompts,
        })
      } catch {
        /* keep */
      }
    }

    // 串行同 server 刷新，避免并发 list 互相覆盖
    let chain: Promise<void> = Promise.resolve()
    const enqueue = (fn: () => Promise<void>) => {
      chain = chain.then(fn).catch(() => {})
      return chain
    }

    unsubs.push(
      client.onNotification(MCP_TOOLS_LIST_CHANGED, () =>
        enqueue(refreshTools),
      ),
    )
    unsubs.push(
      client.onNotification(MCP_RESOURCES_LIST_CHANGED, () =>
        enqueue(refreshResources),
      ),
    )
    unsubs.push(
      client.onNotification(MCP_PROMPTS_LIST_CHANGED, () =>
        enqueue(refreshPrompts),
      ),
    )
  }

  return () => {
    for (const u of unsubs) u()
  }
}

function asInputSchema(raw: unknown): JsonSchema {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as { type?: string }).type === 'object'
  ) {
    return raw as JsonSchema
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }
}

export function registrationFromListed(
  serverName: string,
  tool: McpToolDef,
): McpToolRegistration {
  return {
    name: mcpToolName(serverName, tool.name),
    server: serverName,
    tool: tool.name,
    description: tool.description ?? `MCP ${serverName}/${tool.name}`,
    requiresPermission: true,
    inputSchema: tool.inputSchema,
  }
}

export function boloToolFromMcp(
  reg: McpToolRegistration,
  client: McpStdioClient,
): BoloTool {
  const schema = asInputSchema(reg.inputSchema)
  return buildTool({
    name: reg.name,
    description: reg.description,
    inputJSONSchema: schema,
    requiresPermission: true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    call: async (input) => {
      try {
        const result = await client.callTool(reg.tool, input)
        const output = formatMcpCallOutput(result)
        const isError = result.isError === true
        return {
          ok: !isError,
          output,
          isError,
          errorCode: isError ? 'mcp_tool_error' : undefined,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          output: msg,
          isError: true,
          errorCode: 'mcp_call_failed',
        }
      }
    },
  })
}

/**
 * 全局 meta 工具：ListMcpResources / ReadMcpResource / GetMcpPrompt
 * 对照 HC ListMcpResourcesTool · ReadMcpResourceTool（prompts 侧最小 GetMcpPrompt）
 */
export function createMcpMetaTools(servers: ConnectedMcpServer[]): BoloTool[] {
  const connected = () => servers.filter((s) => s.client.isConnected)
  const out: BoloTool[] = []

  const anyResources = servers.some((s) => s.capabilities.resources)
  const anyPrompts = servers.some((s) => s.capabilities.prompts)

  if (anyResources) {
    out.push(
      buildTool({
        name: 'ListMcpResources',
        description:
          'List resources from connected MCP servers (optional server filter).',
        inputJSONSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'Optional MCP server name to filter by',
            },
          },
          additionalProperties: false,
        },
        requiresPermission: false,
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
        call: async (input) => {
          const target =
            typeof input.server === 'string' && input.server.trim()
              ? input.server.trim()
              : undefined
          const list = connected()
          const clients = target
            ? list.filter((s) => s.name === target)
            : list
          if (target && !clients.length) {
            const names = list.map((s) => s.name).join(', ') || '(none)'
            return {
              ok: false,
              output: `Server "${target}" not found. Available: ${names}`,
              isError: true,
              errorCode: 'mcp_server_not_found',
            }
          }
          const rows: Array<{
            server: string
            uri: string
            name?: string
            description?: string
            mimeType?: string
          }> = []
          for (const s of clients) {
            if (!s.capabilities.resources) continue
            try {
              const resources = await s.client.listResources()
              s.resources = resources
              for (const r of resources) {
                rows.push({
                  server: s.name,
                  uri: r.uri,
                  name: r.name,
                  description: r.description,
                  mimeType: r.mimeType,
                })
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              rows.push({
                server: s.name,
                uri: '',
                name: `(list failed: ${msg})`,
              })
            }
          }
          if (!rows.length) {
            return {
              ok: true,
              output:
                'No resources found. MCP servers may still provide tools even if they have no resources.',
            }
          }
          return { ok: true, output: JSON.stringify(rows, null, 2) }
        },
      }),
    )

    out.push(
      buildTool({
        name: 'ReadMcpResource',
        description: 'Read one MCP resource by server name and URI.',
        inputJSONSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'MCP server name',
            },
            uri: {
              type: 'string',
              description: 'Resource URI to read',
            },
          },
          required: ['server', 'uri'],
          additionalProperties: false,
        },
        requiresPermission: true,
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
        call: async (input) => {
          const serverName =
            typeof input.server === 'string' ? input.server.trim() : ''
          const uri = typeof input.uri === 'string' ? input.uri.trim() : ''
          if (!serverName || !uri) {
            return {
              ok: false,
              output: 'server and uri are required',
              isError: true,
              errorCode: 'mcp_invalid_input',
            }
          }
          const s = connected().find((x) => x.name === serverName)
          if (!s) {
            const names = connected().map((x) => x.name).join(', ') || '(none)'
            return {
              ok: false,
              output: `Server "${serverName}" not found. Available: ${names}`,
              isError: true,
              errorCode: 'mcp_server_not_found',
            }
          }
          if (!s.capabilities.resources) {
            return {
              ok: false,
              output: `Server "${serverName}" does not support resources`,
              isError: true,
              errorCode: 'mcp_no_resources',
            }
          }
          try {
            const contents = await s.client.readResource(uri)
            return {
              ok: true,
              output: formatMcpResourceContents(contents),
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
              ok: false,
              output: msg,
              isError: true,
              errorCode: 'mcp_read_failed',
            }
          }
        },
      }),
    )
  }

  if (anyPrompts) {
    out.push(
      buildTool({
        name: 'GetMcpPrompt',
        description:
          'Fetch an MCP prompt template by server + name (optional arguments object of strings).',
        inputJSONSchema: {
          type: 'object',
          properties: {
            server: {
              type: 'string',
              description: 'MCP server name',
            },
            name: {
              type: 'string',
              description: 'Prompt name from prompts/list',
            },
            arguments: {
              type: 'object',
              description: 'String arguments for the prompt',
              additionalProperties: true,
            },
          },
          required: ['server', 'name'],
          additionalProperties: false,
        },
        requiresPermission: true,
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
        call: async (input) => {
          const serverName =
            typeof input.server === 'string' ? input.server.trim() : ''
          const promptName =
            typeof input.name === 'string' ? input.name.trim() : ''
          if (!serverName || !promptName) {
            return {
              ok: false,
              output: 'server and name are required',
              isError: true,
              errorCode: 'mcp_invalid_input',
            }
          }
          const s = connected().find((x) => x.name === serverName)
          if (!s) {
            const names = connected().map((x) => x.name).join(', ') || '(none)'
            return {
              ok: false,
              output: `Server "${serverName}" not found. Available: ${names}`,
              isError: true,
              errorCode: 'mcp_server_not_found',
            }
          }
          if (!s.capabilities.prompts) {
            return {
              ok: false,
              output: `Server "${serverName}" does not support prompts`,
              isError: true,
              errorCode: 'mcp_no_prompts',
            }
          }
          const argsRaw =
            input.arguments && typeof input.arguments === 'object'
              ? (input.arguments as Record<string, unknown>)
              : {}
          const args: Record<string, string> = {}
          for (const [k, v] of Object.entries(argsRaw)) {
            if (v === undefined || v === null) continue
            args[k] = typeof v === 'string' ? v : String(v)
          }
          try {
            const result = await s.client.getPrompt(promptName, args)
            return {
              ok: true,
              output: formatMcpPromptResult(result),
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
              ok: false,
              output: msg,
              isError: true,
              errorCode: 'mcp_prompt_failed',
            }
          }
        },
      }),
    )
  }

  return out
}

/**
 * 连接配置中的 MCP servers（stdio），list tools/resources/prompts 后注册 BoloTool，
 * 并挂 list_changed 热刷新。任一 server 失败只记 warning。
 */
export async function connectMcpServers(
  options: ConnectMcpOptions,
): Promise<ConnectMcpResult> {
  const warnings: string[] = []
  const servers: ConnectedMcpServer[] = []
  const tools: BoloTool[] = []
  const registrations: McpToolRegistration[] = []
  const seenNames = new Set<string>()

  for (const cfg of options.servers) {
    if (!cfg.name?.trim() || !cfg.command?.trim()) {
      warnings.push(
        `skip MCP server with empty name/command: ${JSON.stringify(cfg.name)}`,
      )
      continue
    }

    const client = new McpStdioClient({
      server: cfg,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    })

    try {
      await client.connect()
      const listed = await client.listTools()
      let resources: McpResourceDef[] = []
      let prompts: McpPromptDef[] = []
      if (client.supportsResources) {
        resources = await client.listResources()
      }
      if (client.supportsPrompts) {
        prompts = await client.listPrompts()
      }

      servers.push({
        name: cfg.name,
        client,
        tools: listed,
        resources,
        prompts,
        capabilities: {
          tools: client.supportsTools || listed.length > 0,
          resources: client.supportsResources,
          prompts: client.supportsPrompts,
        },
      })

      for (const t of listed) {
        const reg = registrationFromListed(cfg.name, t)
        if (seenNames.has(reg.name)) {
          warnings.push(`duplicate MCP tool name overwritten: ${reg.name}`)
          const idx = tools.findIndex((x) => x.name === reg.name)
          if (idx >= 0) tools.splice(idx, 1)
          const ridx = registrations.findIndex((x) => x.name === reg.name)
          if (ridx >= 0) registrations.splice(ridx, 1)
        }
        seenNames.add(reg.name)
        registrations.push(reg)
        tools.push(boloToolFromMcp(reg, client))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`MCP server "${cfg.name}" failed: ${msg}`)
      try {
        await client.close()
      } catch {
        /* ignore */
      }

      if (options.allowConfigToolFallback && cfg.tools?.length) {
        warnings.push(
          `MCP "${cfg.name}": using config.tools fallback (no live call)`,
        )
        for (const t of cfg.tools) {
          const reg: McpToolRegistration = {
            name: mcpToolName(cfg.name, t.name),
            server: cfg.name,
            tool: t.name,
            description:
              t.description ?? `MCP ${cfg.name}/${t.name} (unconnected)`,
            requiresPermission: true,
          }
          if (seenNames.has(reg.name)) continue
          seenNames.add(reg.name)
          registrations.push(reg)
          tools.push(
            buildTool({
              name: reg.name,
              description: reg.description,
              inputJSONSchema: {
                type: 'object',
                properties: {},
                additionalProperties: true,
              },
              requiresPermission: true,
              call: async () => ({
                ok: false,
                output: `MCP server "${cfg.name}" is not connected; cannot call ${t.name}`,
                isError: true,
                errorCode: 'mcp_not_connected',
              }),
            }),
          )
        }
      }
    }
  }

  const wantMeta =
    options.registerMetaTools !== false &&
    servers.some((s) => s.capabilities.resources || s.capabilities.prompts)
  if (wantMeta) {
    for (const meta of createMcpMetaTools(servers)) {
      if (seenNames.has(meta.name)) {
        warnings.push(`meta tool name collision skipped: ${meta.name}`)
        continue
      }
      seenNames.add(meta.name)
      tools.push(meta)
    }
  }

  // 热刷新：再 list + 回调；会话层通常再 mergeSessionToolsWithMcp
  attachMcpListChangedHandlers(servers, options.onListChanged)

  return { servers, tools, registrations, warnings }
}

export async function closeMcpConnections(
  connections: ConnectedMcpServer[],
): Promise<void> {
  await Promise.all(
    connections.map(async (s) => {
      try {
        await s.client.close()
      } catch {
        /* ignore */
      }
    }),
  )
}