/**
 * 确保用户/项目 .bolo 目录结构存在
 */

import { promises as fs } from 'node:fs'
import {
  getProjectLayout,
  getUserLayout,
  type BoloLayoutPaths,
} from './paths.ts'
import {
  DEFAULT_CONFIG,
  DEFAULT_HOOKS_FILE,
  DEFAULT_MCP_FILE,
} from './types.ts'

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function writeJsonIfMissing(
  file: string,
  value: unknown,
): Promise<boolean> {
  try {
    await fs.access(file)
    return false
  } catch {
    await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    return true
  }
}

export type EnsureLayoutResult = {
  layout: BoloLayoutPaths
  created: string[]
}

export async function ensureLayout(
  layout: BoloLayoutPaths,
  options?: { writeDefaults?: boolean },
): Promise<EnsureLayoutResult> {
  const writeDefaults = options?.writeDefaults !== false
  const created: string[] = []

  await ensureDir(layout.root)
  await ensureDir(layout.skillsDir)
  await ensureDir(layout.pluginsDir)
  await ensureDir(layout.sessionsDir)
  await ensureDir(layout.rulesDir)
  await ensureDir(layout.agentsDir)

  if (writeDefaults) {
    if (await writeJsonIfMissing(layout.configJson, DEFAULT_CONFIG)) {
      created.push(layout.configJson)
    }
    if (await writeJsonIfMissing(layout.mcpJson, DEFAULT_MCP_FILE)) {
      created.push(layout.mcpJson)
    }
    if (await writeJsonIfMissing(layout.hooksJson, DEFAULT_HOOKS_FILE)) {
      created.push(layout.hooksJson)
    }
  }

  return { layout, created }
}

export async function ensureUserLayout(options?: {
  writeDefaults?: boolean
}): Promise<EnsureLayoutResult> {
  return ensureLayout(getUserLayout(), options)
}

export async function ensureProjectLayout(
  cwd: string,
  options?: { writeDefaults?: boolean },
): Promise<EnsureLayoutResult> {
  return ensureLayout(getProjectLayout(cwd), options)
}

/** 同时确保用户全局 + 项目目录 */
export async function ensureAllLayouts(
  cwd: string,
  options?: { writeDefaults?: boolean },
): Promise<{ user: EnsureLayoutResult; project: EnsureLayoutResult }> {
  const user = await ensureUserLayout(options)
  const project = await ensureProjectLayout(cwd, options)
  return { user, project }
}