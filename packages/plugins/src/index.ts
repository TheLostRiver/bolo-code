/** 插件贡献点骨架 */

export type PluginManifest = {
  id: string
  name: string
  version: string
  contributes?: {
    skills?: string[]
    hooks?: string
    mcpServers?: string
    agents?: string[]
    commands?: string[]
  }
}

export type PluginScope = 'user' | 'project' | 'session'