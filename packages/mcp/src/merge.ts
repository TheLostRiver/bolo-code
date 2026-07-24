/**
 * MCP server 多层合并（M-GEN-8）
 * 对照 HC 多 scope 配置：后层覆盖前层；Bolo 记录 override 警告（无遥测）。
 *
 * 默认位次（后写赢）：
 *   user mcp.json → project mcp.json → user plugins → project plugins
 * （plugins 内部按 discoverPlugins 顺序，project 插件目录后于 user）
 */

import type { McpServerConfig } from './types.ts'

export type McpServerLayer = {
  /** 诊断用：user | project | plugin:my-id */
  label: string
  servers: readonly McpServerConfig[]
}

export type MergeMcpServerLayersResult = {
  servers: McpServerConfig[]
  /** 同名覆盖说明 */
  warnings: string[]
}

/**
 * 按层合并 MCP servers；同名后层覆盖前层并记 warning。
 * 不校验 transport（校验走 validateMcpServerConfig）。
 */
export function mergeMcpServerLayers(
  layers: readonly McpServerLayer[],
): MergeMcpServerLayersResult {
  const map = new Map<string, McpServerConfig>()
  const source = new Map<string, string>()
  const warnings: string[] = []

  for (const layer of layers) {
    for (const raw of layer.servers) {
      const name = raw.name?.trim()
      if (!name) continue
      const prev = source.get(name)
      if (prev && prev !== layer.label) {
        warnings.push(
          `mcp server "${name}" overridden: ${prev} → ${layer.label}`,
        )
      }
      source.set(name, layer.label)
      map.set(name, { ...raw, name })
    }
  }

  return { servers: [...map.values()], warnings }
}

/** 便捷：两列表合并（后者赢），用于 user+project 快路径 */
export function mergeMcpServerLists(
  base: readonly McpServerConfig[],
  over: readonly McpServerConfig[],
  labels?: { base: string; over: string },
): MergeMcpServerLayersResult {
  return mergeMcpServerLayers([
    { label: labels?.base ?? 'base', servers: base },
    { label: labels?.over ?? 'override', servers: over },
  ])
}

export function tagMcpServerScope(
  servers: readonly McpServerConfig[],
  scope: NonNullable<McpServerConfig['scope']>,
): McpServerConfig[] {
  return servers.map((s) => ({ ...s, scope }))
}