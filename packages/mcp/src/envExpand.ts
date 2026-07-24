/**
 * MCP 配置环境变量插值（M-GEN-6）
 * 对照 HC envExpansion：`${VAR}` / `${VAR:-default}`；无脚本执行、无遥测。
 */

import type { McpServerConfig } from './types.ts'

export type ExpandEnvResult = {
  expanded: string
  /** 无值且无 default 的变量名（占位保留为原文） */
  missingVars: string[]
}

/**
 * 展开字符串中的 `${VAR}` 与 `${VAR:-default}`。
 * 缺变量且无 default → 保留原文并记入 missingVars。
 */
export function expandEnvVarsInString(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): ExpandEnvResult {
  const missingVars: string[] = []
  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent: string) => {
    const [varName, defaultValue] = varContent.split(':-', 2)
    const key = (varName ?? '').trim()
    if (!key) {
      missingVars.push(varContent)
      return match
    }
    const envValue = env[key]
    if (envValue !== undefined) return envValue
    if (defaultValue !== undefined) return defaultValue
    missingVars.push(key)
    return match
  })
  return { expanded, missingVars }
}

export function expandEnvVarsInRecord(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { expanded: Record<string, string> | undefined; missingVars: string[] } {
  if (!record) return { expanded: undefined, missingVars: [] }
  const out: Record<string, string> = {}
  const missingVars: string[] = []
  for (const [k, v] of Object.entries(record)) {
    const r = expandEnvVarsInString(v, env)
    out[k] = r.expanded
    missingVars.push(...r.missingVars)
  }
  return { expanded: out, missingVars }
}

export type ExpandMcpServerConfigResult = {
  config: McpServerConfig
  missingVars: string[]
}

/**
 * 展开 MCP server 配置中的可插值字段：
 * command · args · url · env · headers
 * 不展开 name（避免 id 被 env 改写）。
 */
export function expandMcpServerConfig(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): ExpandMcpServerConfigResult {
  const missingVars: string[] = []
  const take = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined
    const r = expandEnvVarsInString(s, env)
    missingVars.push(...r.missingVars)
    return r.expanded
  }

  const envRec = expandEnvVarsInRecord(cfg.env, env)
  missingVars.push(...envRec.missingVars)
  const headersRec = expandEnvVarsInRecord(cfg.headers, env)
  missingVars.push(...headersRec.missingVars)

  const args = cfg.args?.map((a) => {
    const r = expandEnvVarsInString(a, env)
    missingVars.push(...r.missingVars)
    return r.expanded
  })

  const command = take(cfg.command)
  const url = take(cfg.url)

  const uniq = [...new Set(missingVars)]

  return {
    config: {
      ...cfg,
      command: command ?? cfg.command,
      url: url ?? cfg.url,
      ...(args ? { args } : {}),
      ...(envRec.expanded ? { env: envRec.expanded } : {}),
      ...(headersRec.expanded ? { headers: headersRec.expanded } : {}),
    },
    missingVars: uniq,
  }
}