/**
 * Bolo Plugin Spec v0 — manifest 解析与校验（PL-SPEC-1）
 * 对照 HC PluginManifestSchema 语义（精简）：id 必填、未知 top-level 保留、contributes 字段类型检查。
 * 无遥测。
 */

import type { PluginManifest } from './index.ts'

export const BOLO_PLUGIN_MANIFEST_FILE = 'bolo.plugin.json' as const

export type PluginManifestIssue = {
  level: 'error' | 'warning'
  path: string
  message: string
}

export type ParsePluginManifestResult =
  | { ok: true; manifest: PluginManifest; warnings: PluginManifestIssue[] }
  | { ok: false; errors: PluginManifestIssue[]; warnings: PluginManifestIssue[] }

/** kebab-case id：小写字母数字与单连字符段 */
export function isValidPluginId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)
}

export function normalizePluginIdCandidate(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isRelPathString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * 解析并校验 bolo.plugin.json 内容。
 * error → 不可加载；warning → 可加载但有问题（如 id 非 kebab、未知 contributes 键）。
 */
export function parsePluginManifest(raw: unknown): ParsePluginManifestResult {
  const errors: PluginManifestIssue[] = []
  const warnings: PluginManifestIssue[] = []

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          level: 'error',
          path: '',
          message: 'manifest must be a JSON object',
        },
      ],
      warnings,
    }
  }

  const o = raw as Record<string, unknown>
  const idRaw = o.id
  if (typeof idRaw !== 'string' || !idRaw.trim()) {
    errors.push({
      level: 'error',
      path: 'id',
      message: 'required string field "id" is missing or empty',
    })
  }

  const id = typeof idRaw === 'string' ? idRaw.trim() : ''
  if (id && !isValidPluginId(id)) {
    warnings.push({
      level: 'warning',
      path: 'id',
      message: `plugin id "${id}" is not kebab-case (recommended: my-plugin)`,
    })
  }

  const name =
    typeof o.name === 'string' && o.name.trim()
      ? o.name.trim()
      : id || 'unnamed'
  const version =
    typeof o.version === 'string' && o.version.trim()
      ? o.version.trim()
      : '0.0.0'
  if (typeof o.version !== 'string' || !o.version.trim()) {
    warnings.push({
      level: 'warning',
      path: 'version',
      message: 'missing "version"; defaulting to "0.0.0"',
    })
  }

  let contributes: PluginManifest['contributes'] | undefined
  if (o.contributes !== undefined && o.contributes !== null) {
    if (typeof o.contributes !== 'object' || Array.isArray(o.contributes)) {
      errors.push({
        level: 'error',
        path: 'contributes',
        message: '"contributes" must be an object',
      })
    } else {
      const c = o.contributes as Record<string, unknown>
      const known = new Set([
        'skills',
        'hooks',
        'mcpServers',
        'agents',
        'commands',
      ])
      for (const k of Object.keys(c)) {
        if (!known.has(k)) {
          warnings.push({
            level: 'warning',
            path: `contributes.${k}`,
            message: `unknown contributes key "${k}" (ignored)`,
          })
        }
      }

      const out: NonNullable<PluginManifest['contributes']> = {}

      if (c.skills !== undefined) {
        if (isStringArray(c.skills)) {
          out.skills = c.skills.map((s) => s.trim()).filter(Boolean)
        } else {
          errors.push({
            level: 'error',
            path: 'contributes.skills',
            message: 'must be an array of relative directory paths (strings)',
          })
        }
      }
      if (c.hooks !== undefined) {
        if (isRelPathString(c.hooks)) {
          out.hooks = c.hooks.trim()
        } else {
          errors.push({
            level: 'error',
            path: 'contributes.hooks',
            message: 'must be a relative path string to hooks.json',
          })
        }
      }
      if (c.mcpServers !== undefined) {
        if (isRelPathString(c.mcpServers)) {
          out.mcpServers = c.mcpServers.trim()
        } else {
          errors.push({
            level: 'error',
            path: 'contributes.mcpServers',
            message: 'must be a relative path string to mcp.json',
          })
        }
      }
      if (c.agents !== undefined) {
        if (isStringArray(c.agents)) {
          out.agents = c.agents.map((s) => s.trim()).filter(Boolean)
        } else {
          errors.push({
            level: 'error',
            path: 'contributes.agents',
            message: 'must be an array of relative directory paths (strings)',
          })
        }
      }
      if (c.commands !== undefined) {
        if (isStringArray(c.commands)) {
          out.commands = c.commands.map((s) => s.trim()).filter(Boolean)
        } else {
          errors.push({
            level: 'error',
            path: 'contributes.commands',
            message:
              'must be an array of relative directory paths (strings) for *.md slash commands',
          })
        }
      }

      if (Object.keys(out).length) contributes = out
    }
  }

  if (errors.length) {
    return { ok: false, errors, warnings }
  }

  const manifest: PluginManifest = {
    id,
    name,
    version,
    ...(contributes ? { contributes } : {}),
  }
  return { ok: true, manifest, warnings }
}

export function formatPluginManifestIssues(
  issues: readonly PluginManifestIssue[],
): string[] {
  return issues.map((i) =>
    i.path ? `${i.path}: ${i.message}` : i.message,
  )
}