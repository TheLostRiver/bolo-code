/**
 * MCP host：连 stdio servers → listTools → 注册为 BoloTool（mcp__server__tool）
 * 单 server 失败 warn，不阻断其它 server / 会话
 */

import {
  buildTool,
  type BoloTool,
  type JsonSchema,
} from '../../tools/src/index.ts'
import {
  formatMcpCallOutput,
  McpStdioClient,
  type McpToolDef,
} from './stdioClient.ts'
import { mcpToolName } from './names.ts'
import type { McpServerConfig, McpToolRegistration } from './types.ts'

export type ConnectedMcpServer = {
  name: string
  client: McpStdioClient
  tools: McpToolDef[]
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
 * 连接配置中的 MCP servers（stdio），listTools 后注册 BoloTool。
 * 任一 server 失败只记 warning。
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
      servers.push({ name: cfg.name, client, tools: listed })

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
            description: t.description ?? `MCP ${cfg.name}/${t.name} (unconnected)`,
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